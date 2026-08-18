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
import { createHmac } from 'node:crypto'

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
