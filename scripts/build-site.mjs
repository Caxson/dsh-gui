#!/usr/bin/env node
/**
 * build-site — bake the current release feed into the download page.
 *
 * site/index.html reads the update feed at load time so an already-deployed
 * page picks up new releases on its own. That fetch is cross-origin whenever
 * the page and the artifacts are not served from the same host, and browsers
 * block it unless CORS is configured — so the page must not depend on it.
 *
 * This script reads a latest-mac.yml (the one produced by the release build)
 * and inlines version + file list into the page, making the live fetch a pure
 * enhancement instead of a requirement.
 *
 * Usage: node scripts/build-site.mjs <latest-mac.yml> [out.html]
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = /\/\*__FEED__\*\/[\s\S]*?\/\*__FEED__\*\//

/** electron-builder's latest-mac.yml → { version, files: [{url, size}] }. */
function parseFeed(text) {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (!version) throw new Error('no `version:` field in the feed')
  const files = []
  const re = /-\s*url:\s*(\S+)[\s\S]*?size:\s*(\d+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    // The mirror stores artifacts under the dashed name (electron-builder
    // names the files after the product, "Dsh GUI-…", but writes dashed URLs
    // into the feed). Normalize so the page's links resolve either way.
    files.push({ url: m[1].replace(/ /g, '-'), size: Number(m[2]) })
  }
  if (files.length === 0) throw new Error('no files listed in the feed')
  return { version, files }
}

function main() {
  const [feedPath, outPath = join(ROOT, 'dist-site', 'index.html')] = process.argv.slice(2)
  if (!feedPath) {
    console.error('usage: node scripts/build-site.mjs <latest-mac.yml> [out.html]')
    process.exit(2)
  }

  const feed = parseFeed(readFileSync(feedPath, 'utf8'))
  const page = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8')
  if (!MARKER.test(page)) throw new Error('site/index.html has no /*__FEED__*/ marker to fill')

  const baked = page.replace(MARKER, `/*__FEED__*/${JSON.stringify(feed)}/*__FEED__*/`)
  const outDir = dirname(outPath)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outPath, baked)

  // Page assets (the contact QR) sit next to the page and are referenced by
  // relative path, so they must travel with it.
  const assets = join(ROOT, 'site', 'assets')
  if (existsSync(assets)) cpSync(assets, join(outDir, 'assets'), { recursive: true })

  const dmgs = feed.files.filter((f) => f.url.endsWith('.dmg')).map((f) => f.url)
  console.log(`✓ site built for ${feed.version} → ${outPath}`)
  console.log(`  dmg: ${dmgs.length ? dmgs.join(', ') : '(none — page will link GitHub Releases)'}`)
}

main()
