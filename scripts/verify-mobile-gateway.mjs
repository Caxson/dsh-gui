#!/usr/bin/env node
/**
 * verify-mobile-gateway — try to get through the gateway, not just past it.
 *
 * The engine has no authentication, so this gateway is the only thing between
 * a phone (and anyone who reaches the relay) and remote code execution. A test
 * that only checks the happy path would tell us nothing about that. Every case
 * below is an attempt to reach something the phone must never reach.
 */

import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { handleRequest, OPERATIONS, roomFor, secretMatches, newPairingSecret } =
  require(join(ROOT, 'src', 'mobile-gateway.js'))

let failures = []
const check = (ok, label) => {
  if (ok) console.log(`  ok  ${label}`)
  else { failures.push(label); console.error(`  FAIL  ${label}`) }
}

// Records every engine call the gateway makes, so we can assert on what it
// actually reached for — not merely on what it returned.
const calls = []
const engine = async (method, payload) => {
  calls.push({ method, payload })
  return { echoed: method }
}

const reached = async (msg) => {
  calls.length = 0
  const res = await handleRequest(msg, engine)
  return { res, calls: [...calls] }
}

console.log('allowed operations:')
{
  const { res, calls } = await reached({ id: '1', op: 'sessions.list' })
  check(res.ok && calls[0]?.method === 'session.list', 'listing sessions reaches session.list')
}
{
  const { res, calls } = await reached({ id: '2', op: 'sessions.history', payload: { sessionId: 'session-abc_1' } })
  check(res.ok && calls[0]?.payload.sessionId === 'session-abc_1', 'history passes a well-formed id through')
}
{
  const { res, calls } = await reached({ id: '3', op: 'sessions.prompt', payload: { sessionId: 's1', text: 'hi' } })
  check(res.ok && calls[0]?.method === 'session.prompt', 'prompting reaches session.prompt')
}

console.log('\nattempts to reach something else:')
for (const op of [
  'session.create', 'workspace.create', 'terminal.open', 'tool.call',
  '__proto__', 'constructor', 'toString', 'hasOwnProperty',
]) {
  const { res, calls } = await reached({ id: 'x', op, payload: {} })
  check(!res.ok && calls.length === 0, `"${op}" is refused and reaches nothing`)
}

{
  // These first passed for the wrong reason: on a normal object literal the
  // lookup *succeeded* (returning something off Object.prototype) and the
  // request only failed later, when calling a missing shape() threw. Assert the
  // refusal comes from the allowlist itself, so the accident cannot come back.
  for (const name of ['__proto__', 'constructor', 'toString', 'valueOf']) {
    const { res } = await reached({ id: 'x', op: name })
    check(
      res.error === 'unsupported operation',
      `"${name}" is refused by the allowlist, not by a thrown error`,
    )
  }
}

{
  // A method name smuggled in the payload must not become the engine call.
  const { res, calls } = await reached({
    id: 'x', op: 'sessions.list', payload: { method: 'tool.call', engine: 'session.create' },
  })
  check(res.ok && calls[0]?.method === 'session.list', 'payload cannot redirect which engine method runs')
}

{
  // Path traversal in an id would matter if ids were pasted into a URL.
  const { res, calls } = await reached({
    id: 'x', op: 'sessions.history', payload: { sessionId: '../../etc/passwd' },
  })
  check(!res.ok && calls.length === 0, 'a traversal-shaped session id is rejected')
}
{
  const { res, calls } = await reached({
    id: 'x', op: 'sessions.history', payload: { sessionId: 'a b' },
  })
  check(!res.ok && calls.length === 0, 'a session id with a space is rejected')
}
{
  const { res, calls } = await reached({ id: 'x', op: 'sessions.prompt', payload: { sessionId: 's1', text: '' } })
  check(!res.ok && calls.length === 0, 'an empty prompt is rejected')
}
{
  const { res, calls } = await reached({
    id: 'x', op: 'sessions.prompt', payload: { sessionId: 's1', text: 'x'.repeat(8001) },
  })
  check(!res.ok && calls.length === 0, 'an oversized prompt is rejected')
}
{
  const { res, calls } = await reached({ id: 'x', op: 'sessions.prompt', payload: { sessionId: 's1', text: { toString: 1 } } })
  check(!res.ok && calls.length === 0, 'a non-string prompt is rejected')
}
for (const junk of [null, undefined, 42, 'sessions.list', [], { op: null }]) {
  const { res, calls } = await reached(junk)
  check(!res.ok && calls.length === 0, `malformed frame ${JSON.stringify(junk) ?? 'undefined'} reaches nothing`)
}

console.log('\npairing:')
{
  const secret = newPairingSecret()
  check(secret.length >= 40, 'a pairing secret is long enough to not be guessed')
  const room = roomFor(secret)
  check(/^[0-9a-f]{32}$/.test(room), 'the room id is a hash, not the secret')
  check(!room.includes(secret) && !secret.includes(room), 'the relay never sees the secret itself')
  check(roomFor(secret) === room, 'the same secret always names the same room')
  check(roomFor(newPairingSecret()) !== room, 'a different secret names a different room')
  check(secretMatches(secret, secret) === true, 'a correct secret matches')
  check(secretMatches(secret, secret.slice(0, -1) + 'x') === false, 'a near-miss secret does not match')
  check(secretMatches(secret, secret.slice(0, -1)) === false, 'a truncated secret does not match')
}

console.log(`\nvocabulary is exactly: ${Object.keys(OPERATIONS).join(', ')}`)

if (failures.length) {
  console.error(`\n✗ ${failures.length} gateway check(s) failed`)
  process.exit(1)
}
console.log('\n✓ the gateway exposes only what it means to')
