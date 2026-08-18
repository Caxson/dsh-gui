'use strict';

/**
 * Mobile link — the Mac's end of the phone connection.
 *
 * The relay pairs two sockets that present the same room id, and the room id is
 * `HMAC(secret)`. That is enough for *rendezvous* and deliberately not enough
 * for *authorisation*: the relay computes nothing, but it does see every room id
 * that passes through it, so the machine running the relay could open a socket
 * as "the phone" for any room it has ever carried. Pairing therefore proves
 * nothing on its own.
 *
 * So the phone authenticates in-band. Its first frame must carry the pairing
 * secret itself, which the relay never sees, and until that frame arrives and
 * verifies, every other frame is refused. Authentication is per-connection: when
 * the peer drops and a new one arrives, the new one starts unauthenticated,
 * whatever the previous one proved.
 *
 * Everything a phone is allowed to ask for lives in mobile-gateway.js. This file
 * is transport and identity; it grants no capability of its own.
 */

const { roomFor, secretMatches, handleRequest } = require('./mobile-gateway');

/** A phone that has not proved itself yet gets a handful of frames, then goes. */
const MAX_UNAUTHENTICATED_FRAMES = 4;
/** Frames per window from an authenticated phone. Generous for a human, not for a script. */
const RATE_LIMIT = { frames: 30, windowMs: 10_000 };
/** Reconnect backoff, in ms. Capped so a long outage does not mean a long silence. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * @param {object} opts
 * @param {string} opts.relayUrl   wss://host/path/ — the trailing slash matters
 * @param {string} opts.secret     pairing secret; never sent to the relay
 * @param {(method: string, payload: object) => Promise<any>} opts.callEngine
 * @param {(...args: any[]) => void} [opts.log]
 * @param {(url: string) => any} [opts.openSocket]  injectable for tests
 */
function createMobileLink({ relayUrl, secret, callEngine, log = () => {}, openSocket }) {
  if (typeof relayUrl !== 'string' || !/^wss?:\/\//.test(relayUrl)) {
    throw new Error('relayUrl must be a ws:// or wss:// url');
  }
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('pairing secret is too short to be one');
  }

  const room = roomFor(secret);
  const url = `${relayUrl}${relayUrl.endsWith('/') ? '' : '/'}?room=${room}&role=agent`;
  const dial = openSocket || ((u) => new WebSocket(u));

  let socket = null;
  let stopped = false;
  let attempt = 0;
  // Per-connection authentication state. Reset whenever the peer changes, so a
  // new phone never inherits the standing of the one before it.
  let authenticated = false;
  let unauthedFrames = 0;
  let windowStart = 0;
  let framesInWindow = 0;
  let peerPresent = false;

  const listeners = new Set();
  const emit = (event) => { for (const fn of listeners) fn(event); };

  function resetPeer(why) {
    if (authenticated || unauthedFrames) log(`mobile: peer reset (${why})`);
    authenticated = false;
    unauthedFrames = 0;
    framesInWindow = 0;
    windowStart = 0;
  }

  function send(sock, value) {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(value));
  }

  /** True if this frame is within the rate budget; starts a new window as needed. */
  function withinBudget(now) {
    if (now - windowStart >= RATE_LIMIT.windowMs) {
      windowStart = now;
      framesInWindow = 0;
    }
    framesInWindow += 1;
    return framesInWindow <= RATE_LIMIT.frames;
  }

  async function onFrame(sock, raw, now) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      // Not our protocol at all. Say nothing useful about why.
      return;
    }
    if (msg && msg.type === 'peer') {
      const present = Boolean(msg.client);
      if (present !== peerPresent) {
        peerPresent = present;
        // A phone leaving means the next one must authenticate from scratch.
        if (!present) resetPeer('phone disconnected');
        emit({ type: 'peer', present });
      }
      return;
    }

    if (!authenticated) {
      unauthedFrames += 1;
      const ok =
        msg && msg.type === 'hello' && typeof msg.auth === 'string' &&
        secretMatches(msg.auth, secret);
      if (ok) {
        authenticated = true;
        unauthedFrames = 0;
        windowStart = now;
        framesInWindow = 0;
        log('mobile: phone authenticated');
        emit({ type: 'authenticated' });
        send(sock, { type: 'welcome' });
        return;
      }
      send(sock, { type: 'unauthorized' });
      if (unauthedFrames >= MAX_UNAUTHENTICATED_FRAMES) {
        // Ask the relay to drop the peer — `sock` is this machine's link to the
        // relay, not the phone's socket, so closing it here would hang up on
        // ourselves and hand an attacker a way to keep us reconnecting. It also
        // has to be an eviction rather than simply ignoring them: a peer left
        // in place holds the client role, and a second claimant is refused, so
        // the owner's own phone would be locked out until the secret changed.
        log('mobile: evicting an unauthenticated peer');
        send(sock, { type: 'relay.evict-peer' });
        resetPeer('evicted an unauthenticated peer');
      }
      return;
    }

    if (!withinBudget(now)) {
      send(sock, { id: msg?.id ?? null, ok: false, error: 'slow down' });
      return;
    }

    const reply = await handleRequest(msg, callEngine);
    send(sock, reply);
  }

  function connect() {
    if (stopped) return;
    let sock;
    try {
      sock = dial(url);
    } catch (err) {
      schedule(err && err.message);
      return;
    }
    socket = sock;

    sock.onopen = () => {
      attempt = 0;
      resetPeer('link opened');
      log('mobile: link up');
      emit({ type: 'up' });
    };
    sock.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      // Errors here must not take the link down — a bad frame is the phone's
      // problem, not a reason to drop a working connection.
      Promise.resolve(onFrame(sock, raw, Date.now())).catch((err) => {
        log(`mobile: frame failed — ${err && err.message}`);
      });
    };
    sock.onclose = () => {
      if (socket === sock) socket = null;
      resetPeer('link closed');
      peerPresent = false;
      emit({ type: 'down' });
      schedule('closed');
    };
    sock.onerror = () => {
      // onclose follows; reconnecting from both would double the backoff steps.
    };
  }

  function schedule(why) {
    if (stopped) return;
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    log(`mobile: link down (${why}); retrying in ${wait}ms`);
    const timer = setTimeout(connect, wait);
    if (timer.unref) timer.unref();
  }

  return {
    room,
    start() { stopped = false; attempt = 0; connect(); },
    stop() {
      stopped = true;
      if (socket) { try { socket.close(); } catch { /* already gone */ } }
      socket = null;
      resetPeer('stopped');
    },
    /** For the UI: is the link up, and is a phone attached and proven? */
    status() {
      return {
        connected: Boolean(socket && socket.readyState === 1),
        peerPresent,
        authenticated,
      };
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

module.exports = { createMobileLink, MAX_UNAUTHENTICATED_FRAMES, RATE_LIMIT };
