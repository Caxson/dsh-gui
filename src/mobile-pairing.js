'use strict';

/**
 * Mobile pairing — the state around the phone link, and the one secret it turns on.
 *
 * Off by default, and off is the honest default: turning it on means a machine
 * on the internet can carry frames to this app, and that should be a decision
 * someone makes rather than one they inherit.
 *
 * The pairing secret lives here. It is written to the app's own data directory
 * with owner-only permissions and never leaves this machine except in the
 * pairing payload the user hands to their own phone — the relay never sees it,
 * which is the whole reason a paired phone can be told apart from anyone who
 * merely knows the room id.
 */

const { existsSync, readFileSync, writeFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');

const { newPairingSecret, roomFor } = require('./mobile-gateway');
const { createMobileLink } = require('./mobile-link');

/**
 * Where frames are carried. Overridable so someone can run their own — the
 * relay is 130 lines and self-contained, and nobody should have to route their
 * sessions through ours to use this.
 */
const DEFAULT_RELAY = 'wss://xf.merefusion.com/dsh-relay/';

const OFF = Object.freeze({ enabled: false, secret: null, relayUrl: DEFAULT_RELAY });

function statePath(userDataDir) {
  return join(userDataDir, 'mobile.json');
}

/** Read persisted state, treating anything unreadable or malformed as "off". */
function loadState(userDataDir) {
  const file = statePath(userDataDir);
  if (!existsSync(file)) return OFF;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const secret = typeof raw.secret === 'string' && raw.secret.length >= 16 ? raw.secret : null;
    const relayUrl =
      typeof raw.relayUrl === 'string' && /^wss?:\/\//.test(raw.relayUrl) ? raw.relayUrl : DEFAULT_RELAY;
    // Enabled without a usable secret is not a state we honour: it would dial
    // out with nothing able to authenticate, which is worse than being off.
    return { enabled: Boolean(raw.enabled) && Boolean(secret), secret, relayUrl };
  } catch {
    return OFF;
  }
}

function saveState(userDataDir, state) {
  const file = statePath(userDataDir);
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    // writeFileSync only applies `mode` when it creates the file, so an existing
    // one keeps whatever permissions it had. Set it explicitly every time.
    chmodSync(file, 0o600);
  } catch {
    /* a filesystem without unix permissions — nothing to tighten */
  }
}

/**
 * What the user hands to their phone. The secret is in it, so this string is
 * the credential — it is shown on screen and copied, never logged or sent.
 */
function pairingPayload(state) {
  if (!state.secret) return null;
  const url = new URL('dsh-gui://pair');
  url.searchParams.set('relay', state.relayUrl);
  url.searchParams.set('secret', state.secret);
  return url.toString();
}

/**
 * Owns the link's lifecycle and the persisted state behind it.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {() => (method: string, payload: object) => Promise<any>} opts.engineCaller
 *        Resolved late: the engine's url is not known when this is constructed.
 * @param {(...a: any[]) => void} [opts.log]
 * @param {(url: string) => any} [opts.openSocket] injectable for tests
 */
function createPairing({ userDataDir, engineCaller, log = () => {}, openSocket }) {
  let state = loadState(userDataDir);
  let link = null;
  const listeners = new Set();

  const notify = () => { for (const fn of listeners) fn(snapshot()); };

  function snapshot() {
    const linkStatus = link ? link.status() : { connected: false, peerPresent: false, authenticated: false };
    return {
      enabled: state.enabled,
      relayUrl: state.relayUrl,
      hasSecret: Boolean(state.secret),
      // The room id is derived from the secret and cannot be reversed, so it is
      // safe to show — useful when someone is looking at relay logs.
      room: state.secret ? roomFor(state.secret) : null,
      ...linkStatus,
    };
  }

  function stopLink() {
    if (link) { link.stop(); link = null; }
  }

  function startLink() {
    stopLink();
    if (!state.enabled || !state.secret) return;
    link = createMobileLink({
      relayUrl: state.relayUrl,
      secret: state.secret,
      callEngine: engineCaller(),
      log,
      openSocket,
    });
    link.on(notify);
    link.start();
  }

  function persist(next) {
    state = next;
    saveState(userDataDir, state);
    startLink();
    notify();
  }

  return {
    status: snapshot,
    /** The pairing payload, on request only — it is the credential itself. */
    payload: () => pairingPayload(state),
    enable() {
      // A first enable mints a secret; re-enabling keeps the one the phone has.
      persist({ ...state, enabled: true, secret: state.secret ?? newPairingSecret() });
    },
    disable() {
      persist({ ...state, enabled: false });
    },
    /** New secret: the old phone stops working, which is the point. */
    rotate() {
      persist({ ...state, secret: newPairingSecret(), enabled: true });
    },
    setRelay(url) {
      if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new Error('relay must be a ws:// or wss:// url');
      persist({ ...state, relayUrl: url });
    },
    /** Called once the engine is up, so an enabled link dials on launch. */
    resume() { startLink(); notify(); },
    stop: stopLink,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

module.exports = { createPairing, loadState, saveState, pairingPayload, statePath, DEFAULT_RELAY };
