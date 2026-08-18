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

/** room id → { agent?: WebSocket, client?: WebSocket } */
const rooms = new Map()

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
  const pair = rooms.get(room) ?? {}
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

    ws.on('message', (data, isBinary) => {
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

http.listen(PORT, HOST, () => {
  log(`relay listening on ${HOST}:${PORT}`)
})
