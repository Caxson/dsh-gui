#!/usr/bin/env node
/**
 * verify-mobile-link — can something that is not the paired phone drive the Mac?
 *
 * The question that matters is not "does a paired phone work". It is: the relay
 * sees every room id it carries, so whoever runs the relay can open a socket as
 * "the phone" for any room. Does that get them anything?
 *
 * Everything here runs against the real relay over real sockets, with a real
 * link on the other end. The engine is a stub that records what it was asked
 * for — the point is which requests reach it, not what it answers.
 */

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createMobileLink, MAX_UNAUTHENTICATED_FRAMES, RATE_LIMIT } =
  require(join(ROOT, 'src', 'mobile-link.js'))
const { roomFor } = require(join(ROOT, 'src', 'mobile-gateway.js'))

const PORT = 8581
const RELAY = `ws://127.0.0.1:${PORT}`
const SECRET = 'a-pairing-secret-long-enough-to-be-one'

let failures = []
const check = (ok, label) => {
  if (ok) console.log(`  ok  ${label}`)
  else { failures.push(label); console.error(`  FAIL  ${label}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The engine, reduced to a witness: what did the phone actually reach? */
const reached = []
const callEngine = async (method, payload) => {
  reached.push(method)
  if (method === 'session.list') return { sessions: [{ sessionId: 's1', title: 'one' }] }
  return { echoed: payload }
}

/** A phone — or something pretending to be one. */
function phone() {
  const ws = new WebSocket(`${RELAY}/?room=${roomFor(SECRET)}&role=client`)
  const seen = []
  ws.addEventListener('message', (e) => { try { seen.push(JSON.parse(String(e.data))) } catch { /* not json */ } })
  const ready = new Promise((resolve) => {
    ws.addEventListener('open', () => resolve('open'))
    ws.addEventListener('error', () => resolve('refused'))
    ws.addEventListener('close', () => resolve('closed'))
    setTimeout(() => resolve('timeout'), 5000)
  })
  const closed = new Promise((resolve) => ws.addEventListener('close', () => resolve()))
  return {
    ws, seen, ready, closed,
    send: (v) => ws.send(JSON.stringify(v)),
    /** Frames that are replies to requests, not link chatter. */
    replies: () => seen.filter((m) => m && 'ok' in m),
    last: () => seen[seen.length - 1],
  }
}

const relay = spawn(process.execPath, [join(ROOT, 'mobile', 'relay.mjs'), '--port', String(PORT)], {
  stdio: ['ignore', 'ignore', 'inherit'],
})
const done = (code) => { relay.kill('SIGTERM'); process.exit(code) }

let link
try {
  await sleep(800)
  link = createMobileLink({ relayUrl: RELAY, secret: SECRET, callEngine })
  link.start()
  await sleep(600)
  check(link.status().connected, 'the mac dials the relay and stays up')

  // ── the attack: correct room, no secret ────────────────────────────────
  // This is exactly what the relay operator can mount, so it is the one that
  // has to fail.
  const impostor = phone()
  check((await impostor.ready) === 'open', 'someone with the room id can reach the mac at all')
  await sleep(200)
  impostor.send({ id: 'x1', op: 'sessions.list' })
  await sleep(400)
  check(reached.length === 0, 'an unauthenticated request never reaches the engine')
  check(
    impostor.seen.some((m) => m && m.type === 'unauthorized'),
    'it is told it is unauthorized rather than left hanging',
  )

  // A wrong secret is no better than none.
  impostor.send({ type: 'hello', auth: 'not-the-secret' })
  await sleep(300)
  check(!link.status().authenticated, 'a wrong secret does not authenticate')

  // Guessing does not get an unlimited number of tries.
  for (let i = 0; i < MAX_UNAUTHENTICATED_FRAMES + 2; i += 1) {
    impostor.send({ type: 'hello', auth: `guess-${i}` })
    await sleep(60)
  }
  await Promise.race([impostor.closed, sleep(2000)])
  check(impostor.ws.readyState === 3, 'a peer that keeps guessing is disconnected')
  check(reached.length === 0, 'still nothing reached the engine')
  await sleep(400)

  // ── the real phone ─────────────────────────────────────────────────────
  const real = phone()
  check((await real.ready) === 'open', 'the real phone attaches')
  await sleep(200)
  real.send({ type: 'hello', auth: SECRET })
  await sleep(400)
  check(link.status().authenticated, 'the pairing secret authenticates')
  check(real.seen.some((m) => m && m.type === 'welcome'), 'the phone is told it is in')

  real.send({ id: 'r1', op: 'sessions.list' })
  await sleep(400)
  check(reached.includes('session.list'), 'an authenticated request reaches the engine')
  const listed = real.replies().find((m) => m.id === 'r1')
  check(listed && listed.ok === true, 'the phone gets the result back')

  // ── the vocabulary is the whole boundary ───────────────────────────────
  const before = reached.length
  for (const op of ['workspace.create', 'session.create', 'terminal.write', '__proto__', 'constructor']) {
    real.send({ id: `bad-${op}`, op })
  }
  await sleep(500)
  check(reached.length === before, 'no unlisted operation reaches the engine')
  const refusals = real.replies().filter((m) => String(m.id).startsWith('bad-'))
  check(refusals.length === 5, 'every unlisted operation is answered, not dropped')
  check(refusals.every((m) => m.ok === false), 'and every one of them is a refusal')

  // ── a paired phone still cannot run flat out ───────────────────────────
  const beforeFlood = reached.length
  for (let i = 0; i < RATE_LIMIT.frames + 15; i += 1) real.send({ id: `f${i}`, op: 'sessions.list' })
  await sleep(900)
  check(
    reached.length - beforeFlood <= RATE_LIMIT.frames,
    `the engine is called at most ${RATE_LIMIT.frames} times per window`,
  )
  check(
    real.replies().some((m) => m.ok === false && m.error === 'slow down'),
    'the excess is refused rather than silently dropped',
  )

  // ── standing does not outlive the connection ───────────────────────────
  real.ws.close()
  await sleep(600)
  check(!link.status().authenticated, 'authentication drops with the phone')
  const second = phone()
  check((await second.ready) === 'open', 'a new phone can attach to the freed role')
  await sleep(200)
  const beforeSecond = reached.length
  second.send({ id: 's1', op: 'sessions.list' })
  await sleep(400)
  check(
    reached.length === beforeSecond,
    'the next phone must authenticate for itself, inheriting nothing',
  )
  second.ws.close()
  await sleep(200)
} catch (err) {
  console.error(err)
  if (link) link.stop()
  done(1)
}

if (link) link.stop()
if (failures.length) {
  console.error(`\n✗ ${failures.length} mobile-link check(s) failed`)
  done(1)
}
console.log('\n✓ pairing is rendezvous only — the secret is what grants anything')
done(0)
