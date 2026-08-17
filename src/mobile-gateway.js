'use strict';

/**
 * Mobile gateway — the only thing standing between a phone and the engine.
 *
 * The DSH engine has no authentication of any kind. Its own launcher refuses
 * `--host 0.0.0.0` on the grounds that binding it to a network interface would
 * expose remote code execution, and that judgement is correct: anything that
 * can reach the engine can run tools, read files and drive a shell.
 *
 * So this is deliberately **not** a proxy. It does not forward requests to the
 * engine; it implements a small, fixed set of operations and calls the engine
 * itself. A method the phone names is looked up in a table — never used to
 * construct an engine path — so no message from the network can reach anything
 * that is not listed here, whatever it contains.
 *
 * What a paired phone can do:
 *   - list sessions
 *   - read one session's history
 *   - send a prompt to a session and receive the streamed reply
 *
 * What it cannot do, by construction: run a tool, open a terminal, read a file
 * outside a session transcript, create or delete anything, or reach any other
 * engine method.
 *
 * The connection is outbound only. The Mac dials the relay; nothing listens
 * here, so no port is opened on the user's machine and no inbound firewall
 * hole is required.
 */

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

/**
 * Operations a phone may ask for. The key is the whole vocabulary.
 *
 * Null-prototype on purpose: on an ordinary object literal, `OPERATIONS['__proto__']`
 * and `OPERATIONS['constructor']` return inherited values rather than nothing, so
 * a lookup would appear to succeed for names that were never defined here. The
 * request handler also checks own-property membership; either alone would do,
 * both together mean the allowlist cannot be talked around by naming something
 * off the prototype chain.
 */
const OPERATIONS = Object.assign(Object.create(null), {
  'sessions.list': { engine: 'session.list', shape: () => ({}) },
  'sessions.history': {
    engine: 'session.history',
    shape: (p) => ({ sessionId: requireId(p.sessionId) }),
  },
  'sessions.prompt': {
    engine: 'session.prompt',
    shape: (p) => ({ sessionId: requireId(p.sessionId), text: requireText(p.text) }),
  },
});

function requireId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('bad session id');
  }
  return value;
}

function requireText(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('empty text');
  if (value.length > 8000) throw new Error('text too long');
  return value;
}

/** A pairing secret, shown once in the app and carried by the phone. */
function newPairingSecret() {
  return randomBytes(32).toString('base64url');
}

/**
 * Room name for a secret: the relay pairs a phone with a Mac by this, and must
 * never see the secret itself — it forwards frames and should not be able to
 * impersonate either end.
 */
function roomFor(secret) {
  return createHmac('sha256', 'dsh-gui-mobile-room').update(secret).digest('hex').slice(0, 32);
}

/** Constant-time compare, so a wrong token cannot be found byte by byte. */
function secretMatches(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Handle one request from the phone.
 *
 * @param {object} msg          the frame as received — untrusted
 * @param {(method: string, payload: object) => Promise<any>} callEngine
 */
async function handleRequest(msg, callEngine) {
  const id = typeof msg?.id === 'string' ? msg.id : null;
  const name = typeof msg?.op === 'string' ? msg.op : '';
  const op = Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : null;
  if (!op) {
    // Naming the allowed set back is fine: it is a fixed, public vocabulary,
    // and a client that guessed wrong needs to know what exists.
    return { id, ok: false, error: `unsupported operation`, allowed: Object.keys(OPERATIONS) };
  }
  let payload;
  try {
    payload = op.shape(msg.payload ?? {});
  } catch (err) {
    return { id, ok: false, error: err.message };
  }
  try {
    const value = await callEngine(op.engine, payload);
    return { id, ok: true, value };
  } catch (err) {
    return { id, ok: false, error: err.message };
  }
}

module.exports = {
  OPERATIONS,
  newPairingSecret,
  roomFor,
  secretMatches,
  handleRequest,
};
