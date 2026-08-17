#!/usr/bin/env node
/**
 * smoke — boot the real app and assert every probe reported ok.
 *
 * Two things this fixes over running electron directly:
 *
 * **It cannot pass silently.** Electron's single-instance lock is keyed on the
 * user data directory, so on a machine where the installed Dsh GUI is already
 * running, a second instance quits immediately — printing nothing and exiting
 * 0. That reads as a pass. Here the run must produce a smoke result and every
 * probe in it must be ok, or this exits non-zero and says which one failed.
 *
 * **It runs in its own identity.** Unless overridden, the app gets a scratch
 * user data directory (no lock fight with a running copy) and a scratch DSH
 * home (the probe drives a real engine — it must not write sessions into the
 * user's own ~/.dsh).
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// A probe may report a qualified pass — "ok(not-launched)" for a browser that
// was never opened — which is still a pass.
const PASSED = (value) => typeof value === 'string' && value.startsWith('ok')
const TIMEOUT_MS = Number(process.env.DSH_GUI_SMOKE_TIMEOUT || 180_000)

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function run() {
  const electron = require('electron') // resolves to the binary path
  const env = {
    ...process.env,
    DSH_GUI_SMOKE: '1',
    DSH_GUI_USER_DATA: process.env.DSH_GUI_USER_DATA || scratch('dsh-gui-smoke-ud-'),
    DSH_GUI_HOME: process.env.DSH_GUI_HOME || scratch('dsh-gui-smoke-home-'),
  }

  return new Promise((resolve) => {
    const child = spawn(electron, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ out, err, code: null, timedOut: true })
    }, TIMEOUT_MS)

    child.stdout.on('data', (c) => {
      const text = c.toString()
      out += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (c) => {
      const text = c.toString()
      err += text
      process.stderr.write(text)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ out, err, code, timedOut: false })
    })
  })
}

/** The last line that parses as the smoke result object. */
function resultFrom(text) {
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.includes('"smoke"')) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      /* keep looking */
    }
  }
  return null
}

const { out, code, timedOut } = await run()

if (timedOut) {
  console.error(`\n✗ smoke timed out after ${TIMEOUT_MS / 1000}s without a result`)
  process.exit(1)
}

const result = resultFrom(out)
if (!result) {
  console.error(
    '\n✗ smoke produced no result' +
      (code === 0
        ? ' but exited 0 — the app most likely quit as a second instance ' +
          '(is Dsh GUI already running?). This is why the run is not trusted on exit code alone.'
        : ` (exit ${code})`),
  )
  process.exit(1)
}

const probes = Object.entries(result).filter(([k]) => k.endsWith('Probe'))
const failed = probes.filter(([, v]) => !PASSED(v))

if (probes.length === 0) {
  console.error('\n✗ smoke result carried no probes at all')
  process.exit(1)
}

if (failed.length) {
  console.error('\n✗ smoke failed:')
  for (const [k, v] of failed) console.error(`  - ${k}: ${v}`)
  process.exit(1)
}

console.log(`\n✓ smoke passed — ${probes.map(([k]) => k).join(', ')}`)
