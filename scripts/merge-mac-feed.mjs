#!/usr/bin/env node
/**
 * merge-mac-feed — combine per-architecture update feeds into one.
 *
 * The app bundles a Chromium build for the browser pane, and Chromium is
 * architecture-specific, so each macOS architecture has to be built on a
 * runner of that architecture — producing one latest-mac.yml per arch, each
 * listing only its own artifacts.
 *
 * electron-updater's macOS path selects an update file by looking for "arm64"
 * in the file URL (and detects Rosetta), so a single feed listing both
 * architectures serves both correctly. This merges them into that one feed.
 *
 * Usage: node scripts/merge-mac-feed.mjs <out.yml> <in-a.yml> <in-b.yml> [...]
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** Parse the subset of latest-mac.yml we need, preserving file entry order. */
function parse(text) {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (!version) throw new Error('feed has no `version:` field')
  const releaseDate = /^releaseDate:\s*(.+)$/m.exec(text)?.[1]?.trim()
  const files = []
  const re = /-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    files.push({ url: m[1], sha512: m[2], size: Number(m[3]) })
  }
  if (files.length === 0) throw new Error('feed lists no files')
  return { version, releaseDate, files }
}

function main() {
  const [out, ...inputs] = process.argv.slice(2)
  if (!out || inputs.length === 0) {
    console.error('usage: node scripts/merge-mac-feed.mjs <out.yml> <in.yml> [in.yml ...]')
    process.exit(2)
  }

  const feeds = inputs.map((p) => parse(readFileSync(p, 'utf8')))

  // Every input must describe the same release — a mismatch means one arch
  // built from a different commit, which must never reach users.
  const versions = [...new Set(feeds.map((f) => f.version))]
  if (versions.length > 1) {
    console.error(`✗ refusing to merge feeds of different versions: ${versions.join(', ')}`)
    process.exit(1)
  }

  const seen = new Set()
  const files = []
  for (const feed of feeds) {
    for (const f of feed.files) {
      if (seen.has(f.url)) continue
      seen.add(f.url)
      files.push(f)
    }
  }

  // The legacy top-level path/sha512 fields point at the zip an older updater
  // would fetch blindly; prefer arm64, which is the overwhelming majority of
  // current Macs, and fall back to whatever zip exists.
  const zips = files.filter((f) => f.url.endsWith('.zip'))
  const primary = zips.find((f) => /arm64/i.test(f.url)) ?? zips[0] ?? files[0]

  const lines = [
    `version: ${versions[0]}`,
    'files:',
    ...files.flatMap((f) => [`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${feeds.find((f) => f.releaseDate)?.releaseDate?.replace(/^'|'$/g, '') ?? new Date().toISOString()}'`,
  ]
  writeFileSync(out, lines.join('\n') + '\n')

  const arches = files.filter((f) => f.url.endsWith('.dmg')).map((f) => (/arm64/i.test(f.url) ? 'arm64' : 'x64'))
  console.log(`✓ merged ${inputs.length} feeds → ${out} (${versions[0]}, dmg: ${arches.join(' + ') || 'none'})`)
}

main()
