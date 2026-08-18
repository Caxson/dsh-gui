#!/usr/bin/env node
/**
 * Relay — the rendezvous between a phone and a Mac that are both behind NAT.
 *
 * It is deliberately dumb. It pairs two sockets that present the same room id
 * and copies frames between them. It does not parse them, does not store them,
 * and cannot produce them: the room id is an HMAC of the pairing secret, so the
 * relay never learns the secret and cannot impersonate either end or mint a new
 * pairing of its own.
 *
 * That matters because this runs on a shared VPS alongside other services. The
 * blast radius of the relay being compromised should be "frames can be observed
 * in transit", not "someone can drive the agent".
 *
 * One Mac and one phone per room, first come. A second claimant for a role is
 * refused rather than silently replacing the first, so a stolen room id cannot
 * quietly take over a live session.
 *
 * Usage: node mobile/relay.mjs [--port 8500] [--host 127.0.0.1]
 */

import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const PORT = Number(flag('port', 8500))
// Loopback by default: on the VPS this sits behind nginx, which terminates TLS.
// Binding it to the world by accident should take an explicit flag.
const HOST = flag('host', '127.0.0.1')

const ROOM_RE = /^[0-9a-f]{32}$/
const ROLES = new Set(['agent', 'client'])
const MAX_FRAME = 256 * 1024
// A room id is cheap to invent — it only has to be 32 hex characters to get
// past the shape check; being the *right* 32 characters only matters for
// finding a peer. So anyone can ask for an unbounded number of rooms, and this
// process shares a machine with other services. The cap is what keeps a
// nuisance from becoming their outage.
const MAX_ROOMS = Number(flag('max-rooms', 64))
// nginx holds the upgraded connection open for an hour, which is right for a
// desktop waiting on its phone and wrong for a socket whose other end died
// without a FIN. Ping on an interval and drop the ones that stop answering.
// Configurable so the sweep can actually be exercised by a test rather than
// taken on faith for half a minute at a time.
const HEARTBEAT_MS = Number(flag('heartbeat-ms', 30_000))

/** room id → { agent?: WebSocket, client?: WebSocket } */
const rooms = new Map()

// The single verb the relay understands. Checked as bytes and bounded before
// anything is parsed, so ordinary traffic — which is every other frame — costs
// one length comparison and is forwarded untouched.
const EVICT = '{"type":"relay.evict-peer"}'
function isEvict(data) {
  if (data.length !== EVICT.length) return false
  return data.toString('utf8') === EVICT
}

function peerOf(room, role) {
  const pair = rooms.get(room)
  if (!pair) return null
  return role === 'agent' ? pair.client : pair.agent
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts)
}

const http = createServer((req, res) => {
  // A health check that says nothing about who is connected.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok\n')
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })

http.on('upgrade', (req, socket, head) => {
  let url
  try {
    url = new URL(req.url, 'http://relay.invalid')
  } catch {
    socket.destroy()
    return
  }
  const room = url.searchParams.get('room') ?? ''
  const role = url.searchParams.get('role') ?? ''
  // Shape-check before allocating anything: the room id is a fixed-width hex
  // digest, so anything else is not a client of ours.
  if (!ROOM_RE.test(room) || !ROLES.has(role)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  const existing = rooms.get(room)
  if (!existing && rooms.size >= MAX_ROOMS) {
    // Only opening a *new* room is refused. A phone arriving to join the room
    // its desktop already holds still gets in when the relay is at capacity,
    // so a flood degrades new pairings rather than breaking live ones.
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    socket.destroy()
    return
  }
  const pair = existing ?? {}
  if (pair[role] && pair[role].readyState === pair[role].OPEN) {
    // Refuse rather than replace: taking over a live role would be exactly what
    // someone holding a leaked room id would want to do.
    socket.write('HTTP/1.1 409 Conflict\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    pair[role] = ws
    rooms.set(room, pair)
    log(`+ ${role} ${room.slice(0, 8)} (agent=${!!pair.agent} client=${!!pair.client})`)

    // Tell each side whether its counterpart is present, so the phone can say
    // "Mac offline" instead of appearing to hang.
    const announce = () => {
      const state = JSON.stringify({ type: 'peer', agent: !!pair.agent, client: !!pair.client })
      for (const sock of [pair.agent, pair.client]) {
        if (sock && sock.readyState === sock.OPEN) sock.send(state)
      }
    }
    announce()

    // Liveness. `alive` is cleared before each ping and set by the pong; a
    // socket that misses one whole interval is gone as far as we can tell.
    ws.alive = true
    ws.on('pong', () => { ws.alive = true })

    ws.on('message', (data, isBinary) => {
      // One exception to "the relay does not read frames", and it is worth
      // naming. A room id is visible to whoever carries it, so someone who
      // learns one can occupy the client role and — because a second claimant
      // is refused — keep the actual owner out of their own pairing until they
      // rotate the secret. The desktop is the only party that can tell an
      // impostor from a phone (it holds the secret), and it needs some way to
      // act on that. So the agent, and only the agent, may ask for its current
      // client to be dropped. The relay still learns nothing: it recognises one
      // fixed verb on a socket whose authority comes from holding the role.
      if (role === 'agent' && !isBinary && isEvict(data)) {
        const peer = pair.client
        if (peer) {
          log(`x client ${room.slice(0, 8)} evicted by agent`)
          peer.close(4003, 'evicted')
        }
        return
      }
      const peer = peerOf(room, role)
      if (!peer || peer.readyState !== peer.OPEN) return
      // Copied through untouched — the relay has no opinion about content.
      peer.send(data, { binary: isBinary })
    })

    ws.on('close', () => {
      if (pair[role] === ws) delete pair[role]
      if (!pair.agent && !pair.client) rooms.delete(room)
      else announce()
      log(`- ${role} ${room.slice(0, 8)}`)
    })

    ws.on('error', () => ws.close())
  })
})

// Sweep dead sockets. Without this, a peer that vanishes without closing keeps
// its role — and its room — held for the hour nginx allows, which is both a
// leak and a way to lock someone out of their own pairing.
const heartbeat = setInterval(() => {
  for (const [room, pair] of rooms) {
    for (const role of ['agent', 'client']) {
      const ws = pair[role]
      if (!ws) continue
      if (ws.alive === false) {
        log(`! ${role} ${room.slice(0, 8)} stopped answering`)
        ws.terminate()   // fires 'close', which cleans the room up
        continue
      }
      ws.alive = false
      ws.ping()
    }
  }
}, HEARTBEAT_MS)
heartbeat.unref()

http.listen(PORT, HOST, () => {
  log(`relay listening on ${HOST}:${PORT} (max ${MAX_ROOMS} rooms)`)
})
