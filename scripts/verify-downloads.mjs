#!/usr/bin/env node
/**
 * verify-downloads — prove a release is internally consistent and actually
 * downloadable.
 *
 * Three different things can go wrong, and only the third needs the network:
 *
 *   1. A feed can describe an artifact that is not the file on disk. Two build
 *      targets that collide on a filename do exactly this: the second build
 *      overwrites the first, the feed keeps the first one's size and checksum,
 *      and the updater later rejects the download it is told to fetch. This is
 *      checkable locally, before anything is uploaded.
 *   2. A feed can reference a file that was never produced at all.
 *   3. An artifact can fail to reach the mirror, or reach it truncated.
 *
 * Existence checks alone catch only the third. All three are asserted here.
 *
 * Usage: node scripts/verify-downloads.mjs <artifactsDir> [baseUrl]
 *
 * Without baseUrl only the local assertions run, which is what makes this
 * usable as a pre-upload gate.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FEED_RE = /^latest.*\.ya?ml$/i
// electron-builder names files after the product ("Dsh GUI-1.4.1-arm64.dmg")
// but writes dashed URLs into the feeds, and the mirror stores the dashed name.
const dashed = (name) => name.replace(/ /g, '-')

/** Feed → [{ url, size }]; size is null when the feed omits it. */
function parseFeed(text) {
  const out = []
  const re = /-\s*url:\s*(\S+)([\s\S]*?)(?=\n\s*-\s*url:|\n\S|$)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const size = /size:\s*(\d+)/.exec(m[2])?.[1]
    out.push({ url: dashed(m[1]), size: size ? Number(size) : null })
  }
  return out
}

async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    const len = res.headers.get('content-length')
    return { status: res.status, size: len === null ? null : Number(len) }
  } catch (err) {
    return { status: 0, size: null, error: err.message }
  }
}

async function main() {
  const [dir, base] = process.argv.slice(2)
  if (!dir || !existsSync(dir)) {
    console.error('usage: node scripts/verify-downloads.mjs <artifactsDir> [baseUrl]')
    process.exit(2)
  }

  // What was actually produced, keyed by the name it is published under.
  const onDisk = new Map()
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) continue
    onDisk.set(dashed(name), statSync(full).size)
  }

  const problems = []

  // ── 1 + 2: every feed entry must match a file we really built ────────────
  const feeds = readdirSync(dir).filter((f) => FEED_RE.test(f))
  if (feeds.length === 0) problems.push('no update feed found in the release')
  const advertised = new Set()
  for (const feed of feeds) {
    for (const { url, size } of parseFeed(readFileSync(join(dir, feed), 'utf8'))) {
      advertised.add(url)
      const actual = onDisk.get(url)
      if (actual === undefined) {
        problems.push(`${feed} references ${url}, which was not produced`)
      } else if (size !== null && size !== actual) {
        problems.push(
          `${feed} describes ${url} as ${size} bytes but the file is ${actual} — ` +
            'two build targets most likely wrote the same filename',
        )
      } else {
        console.log(`  ok  ${feed} → ${url}`)
      }
    }
  }

  // ── 3: everything published must be retrievable, at the right size ───────
  if (base) {
    const root = base.replace(/\/$/, '')
    for (const [name, size] of onDisk) {
      if (/\.ya?ml$/i.test(name)) continue // feeds are refreshed every release
      const got = await head(`${root}/${name}`)
      if (got.status !== 200) {
        problems.push(`${name} is not downloadable from the mirror (HTTP ${got.status}${got.error ? ` ${got.error}` : ''})`)
      } else if (got.size !== null && got.size !== size) {
        problems.push(`${name} is ${size} bytes locally but ${got.size} on the mirror`)
      } else {
        console.log(`  ok  mirror → ${name}${advertised.has(name) ? '' : ' (not in any feed; offered on the download page)'}`)
      }
    }
  } else {
    console.log('  (no base URL given — local consistency only)')
  }

  if (problems.length) {
    console.error('\n✗ this release is not consistent:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`\n✓ release consistent — ${onDisk.size} artifacts, ${advertised.size} advertised by feeds`)
}

main()
