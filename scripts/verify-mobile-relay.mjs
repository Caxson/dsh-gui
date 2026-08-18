#!/usr/bin/env node
/**
 * verify-mobile-relay — drive the real relay over real sockets.
 *
 * The interesting cases are not "a message got through". They are: can a third
 * party with the room id take over a live connection, does a malformed room id
 * get anywhere, and does a frame ever reach someone it was not paired with.
 */

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac, randomBytes } from 'node:crypto'
import { connect } from 'node:net'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8577
const base = `ws://127.0.0.1:${PORT}`

const roomFor = (secret) =>
  createHmac('sha256', 'dsh-gui-mobile-room').update(secret).digest('hex').slice(0, 32)

let failures = []
const check = (ok, label) => {
  if (ok) console.log(`  ok  ${label}`)
  else { failures.push(label); console.error(`  FAIL  ${label}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Open a socket and collect what it receives. */
function open(room, role) {
  const ws = new WebSocket(`${base}/?room=${room}&role=${role}`)
  const seen = []
  ws.addEventListener('message', (e) => seen.push(String(e.data)))
  // A refused handshake surfaces as `error` here and does not always reach
  // `close`, so settle on all three or a refusal hangs the run forever.
  const ready = new Promise((resolve) => {
    ws.addEventListener('open', () => resolve('open'))
    ws.addEventListener('error', () => resolve('refused'))
    ws.addEventListener('close', () => resolve('closed'))
    setTimeout(() => resolve('timeout'), 5000)
  })
  return { ws, seen, ready }
}

const relay = spawn(process.execPath, [join(ROOT, 'mobile', 'relay.mjs'), '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
relay.stdout.on('data', () => {})
relay.stderr.on('data', (d) => process.stderr.write(d))

const done = (code) => { relay.kill('SIGTERM'); process.exit(code) }

try {
  console.log('relay starting…')
  await sleep(800)
  console.log('connecting…')

  const room = roomFor('secret-one')
  const other = roomFor('secret-two')

  // ── a paired mac and phone can talk ────────────────────────────────────
  const mac = open(room, 'agent')
  const phone = open(room, 'client')
  check((await mac.ready) === 'open', 'the mac can attach to its room')
  check((await phone.ready) === 'open', 'the phone can attach to the same room')
  await sleep(200)

  mac.ws.send('from-mac')
  phone.ws.send('from-phone')
  await sleep(300)
  check(phone.seen.includes('from-mac'), 'a frame from the mac reaches the phone')
  check(mac.seen.includes('from-phone'), 'a frame from the phone reaches the mac')
  check(
    phone.seen.some((m) => m.includes('"type":"peer"')),
    'each side is told whether its counterpart is present',
  )

  // ── someone else's room hears nothing ──────────────────────────────────
  const stranger = open(other, 'client')
  check((await stranger.ready) === 'open', 'a different room is its own space')
  await sleep(150)
  mac.ws.send('secret-payload')
  await sleep(300)
  check(
    !stranger.seen.some((m) => m.includes('secret-payload')),
    'a frame never crosses into another room',
  )

  // ── a second claimant cannot take over a live role ─────────────────────
  const impostor = open(room, 'client')
  const outcome = await impostor.ready
  check(outcome !== 'open', 'a second phone for a busy room is refused, not swapped in')
  await sleep(200)
  mac.ws.send('after-impostor')
  await sleep(300)
  check(
    phone.seen.includes('after-impostor'),
    'the original phone still has the connection afterwards',
  )

  // ── malformed room ids get nowhere ─────────────────────────────────────
  for (const bad of ['', 'short', '../../etc', 'g'.repeat(32), 'A'.repeat(32)]) {
    const junk = open(bad, 'client')
    check((await junk.ready) !== 'open', `room id ${JSON.stringify(bad)} is refused`)
  }
  const badRole = open(room, 'admin')
  check((await badRole.ready) !== 'open', 'an unknown role is refused')

  // ── a freed role can be reclaimed after a disconnect ───────────────────
  phone.ws.close()
  await sleep(400)
  const rejoin = open(room, 'client')
  check((await rejoin.ready) === 'open', 'the role frees up once its socket closes')
  rejoin.ws.close()
  mac.ws.close()
  stranger.ws.close()
  await sleep(200)

  // ── eviction runs one way only ─────────────────────────────────────────
  // The agent can drop its client, because only the agent can tell an impostor
  // from a phone. The reverse must not work: a client that could evict would
  // hand anyone holding the room id a way to knock the desktop off instead of
  // merely squatting.
  const evictRoom = roomFor('evict-test')
  const evMac = open(evictRoom, 'agent')
  const evPhone = open(evictRoom, 'client')
  check((await evMac.ready) === 'open', 'evict test: the mac attaches')
  check((await evPhone.ready) === 'open', 'evict test: the phone attaches')
  await sleep(200)

  const EVICT = '{"type":"relay.evict-peer"}'
  evPhone.ws.send(EVICT)
  await sleep(400)
  check(evMac.ws.readyState === 1, 'a client cannot evict the agent')
  check(
    evMac.seen.includes(EVICT),
    'and its frame is forwarded as ordinary traffic instead of being obeyed',
  )

  const phoneClosed = new Promise((r) => evPhone.ws.addEventListener('close', () => r()))
  evMac.ws.send(EVICT)
  await Promise.race([phoneClosed, sleep(2000)])
  check(evPhone.ws.readyState === 3, 'the agent can evict its client')
  check(!evPhone.seen.includes(EVICT), 'the evict verb is consumed, not forwarded to the client')

  await sleep(300)
  const rejoinAfterEvict = open(evictRoom, 'client')
  check((await rejoinAfterEvict.ready) === 'open', 'the role is free again after an eviction')
  rejoinAfterEvict.ws.close()
  evMac.ws.close()
  await sleep(200)

  // ── the limits that keep a nuisance off the neighbouring service ───────
  // A second relay with the limits turned down far enough to observe. The
  // caps are the whole reason this is safe to expose on a shared machine, so
  // "it has a cap" is not a claim to take on faith.
  const CAPPED = 8578
  const capped = spawn(
    process.execPath,
    [join(ROOT, 'mobile', 'relay.mjs'),
     '--port', String(CAPPED), '--max-rooms', '2', '--heartbeat-ms', '250'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  try {
    await sleep(800)
    const at = (room, role) => {
      const ws = new WebSocket(`ws://127.0.0.1:${CAPPED}/?room=${room}&role=${role}`)
      const ready = new Promise((resolve) => {
        ws.addEventListener('open', () => resolve('open'))
        ws.addEventListener('error', () => resolve('refused'))
        ws.addEventListener('close', () => resolve('closed'))
        setTimeout(() => resolve('timeout'), 5000)
      })
      return { ws, ready }
    }

    const r1 = at(roomFor('cap-1'), 'agent')
    const r2 = at(roomFor('cap-2'), 'agent')
    check((await r1.ready) === 'open', 'the first room opens under the cap')
    check((await r2.ready) === 'open', 'the second room opens under the cap')
    const r3 = at(roomFor('cap-3'), 'agent')
    check((await r3.ready) !== 'open', 'a room beyond the cap is refused')
    // Degrading new pairings is acceptable; breaking a live one is not.
    const joiner = at(roomFor('cap-1'), 'client')
    check(
      (await joiner.ready) === 'open',
      'a phone can still join an existing room while the relay is full',
    )
    joiner.ws.close(); r1.ws.close(); r2.ws.close()
    await sleep(300)

    // A peer that dies without closing: raw socket, real handshake, then
    // silence. It never answers a ping, so the sweep must reclaim its role —
    // otherwise a crashed phone locks its owner out for an hour.
    const deadRoom = roomFor('cap-dead')
    const raw = connect(CAPPED, '127.0.0.1')
    const upgraded = await new Promise((resolve) => {
      raw.on('connect', () => {
        raw.write(
          `GET /?room=${deadRoom}&role=client HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
        )
      })
      raw.once('data', (d) => resolve(String(d).startsWith('HTTP/1.1 101')))
      raw.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 4000)
    })
    check(upgraded, 'a raw socket can complete the handshake (the test is valid)')
    // Two full intervals: one to mark it unanswered, one to terminate it.
    await sleep(900)
    const reclaim = at(deadRoom, 'client')
    check(
      (await reclaim.ready) === 'open',
      'a peer that stops answering is swept, freeing its role',
    )
    reclaim.ws.close()
    raw.destroy()
    await sleep(150)
  } finally {
    capped.kill('SIGTERM')
  }
} catch (err) {
  console.error(err)
  done(1)
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} relay check(s) failed`)
  done(1)
}
console.log('\n✓ the relay pairs, isolates, and refuses takeover')
done(0)
