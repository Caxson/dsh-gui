#!/usr/bin/env node
/**
 * verify-downloads — prove the mirror serves exactly what the update feeds
 * advertise.
 *
 * Uploading is not the same as being downloadable, and being downloadable is
 * not the same as being *the right file*. Two build targets that collide on a
 * filename leave the feed describing one artifact while the mirror stores
 * another: every URL still resolves, so an existence-only check passes, but the
 * auto-updater rejects the download on a hash mismatch and anyone clicking the
 * "installer" link gets the other build.
 *
 * So each advertised file is checked on two axes:
 *   1. it resolves (HTTP 200)
 *   2. its Content-Length equals the size recorded in the feed
 *
 * Usage: node scripts/verify-downloads.mjs <baseUrl> <feed.yml> [feed2.yml ...]
 */

import { readFileSync, existsSync } from 'node:fs'

/** electron-builder feed → [{ url, size }]; `size` is null when absent. */
function parseFeed(text) {
  const files = []
  const re = /-\s*url:\s*(\S+)([\s\S]*?)(?=\n\s*-\s*url:|\n\S|$)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const size = /size:\s*(\d+)/.exec(m[2])?.[1]
    // The mirror stores artifacts under the dashed name; the feed may carry
    // either form depending on how electron-builder rendered it.
    files.push({ url: m[1].replace(/ /g, '-'), size: size ? Number(size) : null })
  }
  return files
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
  const [base, ...feedPaths] = process.argv.slice(2)
  if (!base || feedPaths.length === 0) {
    console.error('usage: node scripts/verify-downloads.mjs <baseUrl> <feed.yml> [feed2.yml ...]')
    process.exit(2)
  }

  const advertised = new Map()
  for (const p of feedPaths) {
    if (!existsSync(p)) {
      console.log(`  (no ${p} — skipped)`)
      continue
    }
    for (const f of parseFeed(readFileSync(p, 'utf8'))) advertised.set(f.url, f)
  }

  if (advertised.size === 0) {
    console.error('✗ the feeds advertise no files at all')
    process.exit(1)
  }

  let failed = 0
  for (const { url, size } of advertised.values()) {
    const full = `${base.replace(/\/$/, '')}/${url}`
    const got = await head(full)
    if (got.status !== 200) {
      console.error(`  MISSING (${got.status}${got.error ? ` ${got.error}` : ''})  ${url}`)
      failed++
    } else if (size !== null && got.size !== null && got.size !== size) {
      // The classic symptom of two build targets overwriting each other.
      console.error(`  MISMATCH  ${url} — feed says ${size} bytes, mirror serves ${got.size}`)
      failed++
    } else {
      console.log(`  ok  ${url}${size === null ? '' : ` (${size} bytes)`}`)
    }
  }

  if (failed > 0) {
    console.error(`✗ ${failed} of ${advertised.size} advertised downloads are missing or are not the file the feed describes`)
    process.exit(1)
  }
  console.log(`✓ all ${advertised.size} advertised downloads resolve and match the feed`)
}

main()
