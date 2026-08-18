#!/usr/bin/env node
/**
 * verify-ios-client — drive the iPhone client's own code against a real relay
 * and a real desktop link.
 *
 * The phone talks to the Mac over a protocol implemented twice, in two
 * languages. Anything the two disagree about — how the room id is derived, what
 * a reply frame looks like, whether a timestamp is seconds or milliseconds —
 * fails silently: the phone sits in a room nobody else is in, or renders a
 * conversation from 1970. So this runs the shipping Swift against the shipping
 * JavaScript and checks they actually agree.
 *
 * Only the SwiftUI layer is absent; the networking, pairing and decoding are
 * the app's own files, compiled straight out of ios/DshGUI.
 *
 * macOS only — it needs swiftc.
 */

import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createMobileLink } = require(join(ROOT, 'src', 'mobile-link.js'))

const PORT = 8583
const SECRET = 'ios-harness-secret-long-enough-ok'
const RELAY_URL = `ws://127.0.0.1:${PORT}/`

if (process.platform !== 'darwin') {
  console.error('✗ this check needs swiftc, so it only runs on macOS')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-ios-harness-'))
const binary = join(scratch, 'harness')

console.log('── compiling the client harness ──')
const compile = spawnSync(
  'swiftc',
  [
    '-swift-version', '6',
    '-o', binary,
    join(ROOT, 'ios', 'DshGUI', 'Pairing.swift'),
    join(ROOT, 'ios', 'DshGUI', 'RelayClient.swift'),
    join(ROOT, 'ios', 'DshGUI', 'Models.swift'),
    join(ROOT, 'ios', 'Harness', 'main.swift'),
  ],
  { stdio: 'inherit' },
)
if (compile.status !== 0) {
  rmSync(scratch, { recursive: true, force: true })
  console.error('✗ the harness did not compile')
  process.exit(1)
}

// ── the desktop half ───────────────────────────────────────────────────────
const relay = spawn(process.execPath, [join(ROOT, 'mobile', 'relay.mjs'), '--port', String(PORT)], {
  stdio: ['ignore', 'ignore', 'inherit'],
})

const history = [
  { role: 'user', content: '帮我看下 relay 的房间上限逻辑' },
  { role: 'assistant', content: '上限只拦新开房间，已有房间的第二方仍然放行。' },
  { role: 'user', content: '那心跳呢' },
  { role: 'assistant', content: 'ping/pong 清扫掉没有发 FIN 就消失的对端。' },
]

/** The engine, reduced to the shapes it actually returns. */
const callEngine = async (method, payload) => {
  switch (method) {
    case 'session.list':
      return {
        sessions: [
          { sessionId: 'sess-relay', title: 'relay 上限与心跳', updatedAt: Date.now() - 5 * 60_000 },
          { sessionId: 'sess-theme', title: '主题 token 覆盖', updatedAt: Date.now() - 3 * 3600_000 },
          // An untitled session: the phone has to show something readable.
          { sessionId: 'sess-empty', title: '', updatedAt: Date.now() - 26 * 3600_000 },
        ],
      }
    case 'session.history':
      return { messages: payload.sessionId === 'sess-relay' ? history : [] }
    case 'session.prompt':
      history.push({ role: 'user', content: payload.text })
      history.push({ role: 'assistant', content: `收到：${payload.text}` })
      return { ok: true }
    default:
      throw new Error(`stub engine has no ${method}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(900)

const link = createMobileLink({ relayUrl: RELAY_URL, secret: SECRET, callEngine })
link.start()
await sleep(700)

console.log('── running the client against it ──')
// Not spawnSync: the desktop link lives in *this* process, so blocking the
// event loop would stop it answering — the phone would sit waiting for a
// `welcome` from a Node process that cannot run any code until the phone
// exits. The two have to be concurrent because one is the other's peer.
const status = await new Promise((resolve) => {
  const child = spawn(binary, [SECRET, RELAY_URL], { stdio: 'inherit' })
  // A hung end-to-end test is worse than a failing one: it reports nothing and
  // holds a CI runner until the job times out.
  const watchdog = setTimeout(() => {
    console.error('✗ the client did not finish within 60s — killing it')
    child.kill('SIGKILL')
  }, 60_000)
  child.on('exit', (code) => { clearTimeout(watchdog); resolve(code ?? 1) })
  child.on('error', (err) => { clearTimeout(watchdog); console.error(err.message); resolve(1) })
})

link.stop()
relay.kill('SIGTERM')
rmSync(scratch, { recursive: true, force: true })

process.exit(status === 0 ? 0 : 1)
