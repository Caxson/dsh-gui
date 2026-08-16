#!/usr/bin/env node
/**
 * verify-runtime-closure — engine-update safety gate.
 *
 * The DSH runtime is ~186 first-party packages (`@deepseek-ai/dsh*`) that
 * reference each other through peerDependencies, and the engine's own
 * package.json pins those siblings with a caret (`^0.1.0-rc.6`). That caret
 * means a fresh dependency resolution during an engine bump can float SOME
 * sub-packages to a newer release while others stay behind — an incoherent
 * mix that type-checks locally but breaks at runtime on a user's machine.
 *
 * This gate reads the committed lockfile (no install required) and fails loud
 * when the runtime closure is not internally coherent, so a bad engine bump is
 * caught in CI instead of in the field. Three assertions:
 *
 *   1. Exact pinning — every `@deepseek-ai/*` dependency declared in our own
 *      package.json is an exact version, never a range. We do not add our own
 *      drift on top of the engine's.
 *   2. Single family version — every installed `@deepseek-ai/dsh*` package
 *      resolves to one and the same version. A split (rc.6 + rc.7) fails.
 *   3. Peer closure — every required first-party peerDependency of every
 *      family package is actually present in the lockfile. A missing peer means
 *      the engine grew a package we never picked up.
 *
 * Exit 0 = coherent. Exit 1 = drift, with the offending packages printed.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '@deepseek-ai/'
// The runtime family: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`. Sibling
// scope packages (cordis*, cosmokit, schemastery) version independently and
// are deliberately excluded from the single-version rule.
const FAMILY_RE = /^@deepseek-ai\/dsh(-|$)/
const RANGE_CHARS = /[\^~><=|*x ]|\s-\s/

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
}

/** Package name = the segment after the last `node_modules/` in a lock key. */
function nameFromLockKey(key) {
  const i = key.lastIndexOf('node_modules/')
  return i === -1 ? key : key.slice(i + 'node_modules/'.length)
}

function main() {
  const pkg = readJson('package.json')
  const lock = readJson('package-lock.json')
  const failures = []

  // ── 1. exact pinning of our own declared @deepseek-ai/* deps ──────────────
  const deps = pkg.dependencies ?? {}
  for (const [name, range] of Object.entries(deps)) {
    if (!name.startsWith(SCOPE)) continue
    if (RANGE_CHARS.test(range)) {
      failures.push(`pin: ${name} is declared as "${range}" — must be an exact version (no range).`)
    }
  }

  // ── collect the installed family from the lockfile ────────────────────────
  const lockPackages = lock.packages ?? {}
  const familyVersions = new Map() // name -> version
  const familyPresent = new Set() // every @deepseek-ai/* name present (any scope)
  for (const [key, entry] of Object.entries(lockPackages)) {
    if (!key.includes('node_modules/')) continue
    const name = nameFromLockKey(key)
    if (!name.startsWith(SCOPE) || !entry.version) continue
    familyPresent.add(name)
    if (FAMILY_RE.test(name)) familyVersions.set(name, entry.version)
  }

  if (familyVersions.size === 0) {
    failures.push('closure: no @deepseek-ai/dsh* packages found in the lockfile — is it up to date?')
  }

  // ── 2. single family version ──────────────────────────────────────────────
  const byVersion = new Map()
  for (const [name, version] of familyVersions) {
    if (!byVersion.has(version)) byVersion.set(version, [])
    byVersion.get(version).push(name)
  }
  if (byVersion.size > 1) {
    const sorted = [...byVersion.entries()].sort((a, b) => b[1].length - a[1].length)
    const [, majorityNames] = sorted[0]
    const lines = ['closure: runtime family is split across versions —']
    for (const [version, names] of sorted) {
      const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')}, …(+${names.length - 8})` : names.join(', ')
      lines.push(`    ${version} × ${names.length}: ${shown}`)
    }
    lines.push(`  majority is ${sorted[0][0]} (${majorityNames.length}); align the rest to it.`)
    failures.push(lines.join('\n'))
  }

  // ── 3. peer closure — required first-party peers must be present ───────────
  const missingPeers = new Map() // peer -> set of dependents
  for (const [key, entry] of Object.entries(lockPackages)) {
    const name = nameFromLockKey(key)
    if (!FAMILY_RE.test(name)) continue
    const peers = entry.peerDependencies ?? {}
    const optional = entry.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(peers)) {
      if (!peer.startsWith(SCOPE)) continue
      if (optional[peer]?.optional) continue
      if (!familyPresent.has(peer)) {
        if (!missingPeers.has(peer)) missingPeers.set(peer, new Set())
        missingPeers.get(peer).add(name)
      }
    }
  }
  for (const [peer, dependents] of missingPeers) {
    const names = [...dependents]
    const shown = names.length > 6 ? `${names.slice(0, 6).join(', ')}, …(+${names.length - 6})` : names.join(', ')
    failures.push(`peer: ${peer} is required by ${shown} but is not in the lockfile — the engine grew a package we never picked up.`)
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  if (failures.length > 0) {
    console.error('✗ runtime closure check FAILED\n')
    for (const f of failures) console.error('  • ' + f + '\n')
    console.error('The engine dependency graph is incoherent. Regenerate the lockfile against a')
    console.error('single engine release, or align the declared versions, then re-run.')
    process.exit(1)
  }

  const version = [...byVersion.keys()][0]
  console.log(`✓ runtime closure coherent — ${familyVersions.size} @deepseek-ai/dsh* packages, all at ${version}.`)
}

main()
