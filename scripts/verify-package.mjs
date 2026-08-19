#!/usr/bin/env node
/**
 * verify-package — start the app that was actually built, and wait for it to
 * work.
 *
 * This exists because of a shipped outage. `electron-builder`'s file filter
 * excluded any directory named `doc`, on the reasoning that package
 * documentation is dead weight in an installer. But a directory name is not a
 * statement about its contents: `yaml/dist/doc/` is the YAML document model,
 * required by that package's own composer. The installer was well-formed, the
 * right size, correctly listed in the update feed, and downloadable — and the
 * app died on launch. It shipped that way from v1.4.0 to v1.5.3.
 *
 * Every gate we had measured the artifact. None of them ran it. Size, checksum
 * and reachability cannot answer the only question that matters, which is
 * whether the thing starts, so this asks that question directly: launch the
 * packaged binary, and require the engine to report a URL.
 *
 * Usage: node scripts/verify-package.mjs <path-to-.app-or-exe>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const target = process.argv[2]
if (!target) {
  console.error('usage: verify-package.mjs <path to built app>')
  process.exit(2)
}

/** The executable inside a macOS bundle; elsewhere the path is the binary. */
function binaryFor(path) {
  if (!path.endsWith('.app')) return path
  const name = path.split('/').pop().replace(/\.app$/, '')
  return join(path, 'Contents', 'MacOS', name)
}

const binary = binaryFor(target)
if (!existsSync(binary)) {
  console.error(`✗ no executable at ${binary}`)
  process.exit(1)
}

// Scratch directories: the check must not read or write anyone's real sessions,
// and must be identical on a fresh machine and a developer's.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-gui-pkg-'))

/**
 * Tidying up must never decide the verdict. The first version removed the
 * scratch directory the instant after killing the app, while it was still
 * writing into it — `rmdir` raised ENOTEMPTY and failed a release whose package
 * had just booted correctly. A leftover temp directory is not a reason to block
 * a release; the answer to "does it start" had already been yes.
 */
function cleanup() {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (err) {
    console.warn(`(could not remove ${scratch}: ${err.code ?? err.message} — ignoring)`)
  }
}

/** Give the process a moment to die before touching what it was writing to. */
function stop(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    const done = setTimeout(resolve, 3000)
    proc.once('exit', () => { clearTimeout(done); setTimeout(resolve, 300) })
    try { proc.kill('SIGTERM') } catch { clearTimeout(done); resolve() }
  })
}

const BOOT_TIMEOUT_MS = 180_000

console.log(`── starting ${binary} ──`)
const child = spawn(binary, [], {
  env: {
    ...process.env,
    DSH_GUI_HOME: join(scratch, 'home'),
    DSH_GUI_USER_DATA: join(scratch, 'user-data'),
    DSH_GUI_NO_SANDBOX: '1',
    // Never let a verification run reach for an update.
    DSH_GUI_UPDATE_URL: 'github',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
let settled = false

const finish = async (ok, message) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  await stop(child)
  cleanup()
  if (ok) {
    console.log(`\n✓ ${message}`)
    process.exit(0)
  }
  console.error(`\n✗ ${message}`)
  // The tail is the whole point of the failure: it carries the module that
  // could not be found.
  console.error('\n--- output ---\n' + output.slice(-4000))
  process.exit(1)
}

const timer = setTimeout(
  () => finish(false, `the app did not report an engine URL within ${BOOT_TIMEOUT_MS / 1000}s`),
  BOOT_TIMEOUT_MS,
)

const watch = (chunk) => {
  const text = String(chunk)
  output += text
  process.stdout.write(text)
  // The success signal is the engine's own readiness line, not merely that the
  // process is still alive: a window can open and the engine still be dead.
  if (/engine ready at http/.test(output)) {
    finish(true, 'the packaged app boots and the engine comes up')
  }
  // Fail fast on the app's own fatal path rather than waiting out the timeout.
  if (/the DSH engine exited unexpectedly|fatal load failure/.test(output)) {
    finish(false, 'the engine failed to load inside the packaged app')
  }
}

child.stdout.on('data', watch)
child.stderr.on('data', watch)
child.on('error', (err) => finish(false, `could not start it: ${err.message}`))
child.on('exit', (code) => finish(false, `it exited with code ${code} before the engine came up`))
