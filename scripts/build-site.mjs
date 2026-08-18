#!/usr/bin/env node
/**
 * build-site — bake the current release into the download page.
 *
 * The page is rebuilt and re-uploaded on every release (and served no-cache),
 * so what is baked here is what visitors get; the page does no network work of
 * its own. That is deliberate: fetching the update feed at load time made the
 * page depend on a cross-origin request, and — worse — the feed is not the list
 * a human wants.
 *
 * The update feed and the download page describe different sets:
 *
 *   - the feed carries what electron-updater needs (the mac .zip; only one
 *     Windows target, since a portable .exe cannot update itself in place)
 *   - the page carries what a person installs (.dmg, both .exe flavours)
 *
 * Deriving the page from the feed therefore hid the portable build even though
 * it was published. So the page is built from the artifacts actually being
 * released, and the feed is consulted only for the version number.
 *
 * It also emits changelog.html. The download page used to send people to the
 * GitHub Releases page for older versions, and that page lists every asset with
 * its size — so the one number the download page deliberately never shows was
 * two clicks away the whole time. The changelog carries release notes only.
 *
 * Usage: node scripts/build-site.mjs <artifactsDir> [out.html] [releases.json]
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = /\/\*__FEED__\*\/[\s\S]*?\/\*__FEED__\*\//

// Update feeds and their checksum sidecars are machinery, not downloads.
const NOT_A_DOWNLOAD = /(\.blockmap|\.ya?ml)$/i
// What a person can actually install. The page classifies these further; here
// we only need to keep machinery out.
const INSTALLABLE = /\.(dmg|exe)$/i

/** The version every artifact in this release shares, per the update feeds. */
function versionFrom(dir) {
  const feeds = readdirSync(dir).filter((f) => /^latest.*\.ya?ml$/i.test(f))
  const found = new Set()
  for (const f of feeds) {
    const m = /^version:\s*(.+)$/m.exec(readFileSync(join(dir, f), 'utf8'))
    if (m) found.add(m[1].trim().replace(/^['"]|['"]$/g, ''))
  }
  if (found.size === 0) throw new Error(`no version found in any feed under ${dir}`)
  // Feeds disagreeing means the release is half-built; do not paper over it by
  // picking one and advertising downloads from two different versions.
  if (found.size > 1) throw new Error(`feeds disagree on the version: ${[...found].join(', ')}`)
  return [...found][0]
}

const RELEASES_MARKER = /\/\*__RELEASES__\*\/[\s\S]*?\/\*__RELEASES__\*\//

/**
 * `gh release list --json` output → what the changelog shows. Notes only:
 * no asset list, no sizes, and no links back to a page that has them.
 */
function changelogFrom(jsonPath) {
  if (!jsonPath || !existsSync(jsonPath)) return []
  let raw
  try {
    raw = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch (err) {
    console.warn(`! ignoring release list: ${err.message}`)
    return []
  }
  if (!Array.isArray(raw)) return []
  // Accepts either shape: the REST list (snake_case, carries the notes) or
  // `gh release list --json` (camelCase, does not).
  return raw
    .filter((r) => !(r.isDraft ?? r.draft) && !(r.isPrerelease ?? r.prerelease))
    .map((r) => ({
      tag: String(r.tagName ?? r.tag_name ?? ''),
      name: String(r.name ?? r.tagName ?? r.tag_name ?? ''),
      date: String(r.publishedAt ?? r.published_at ?? '').slice(0, 10),
      // Auto-generated notes link commits and contributors, which is fine, but
      // strip the asset section if a hand-written note ever includes one.
      body: String(r.body ?? '')
        .split(/\n#+\s*(?:Assets|资产|下载)\b/i)[0]
        .trim()
        .slice(0, 4000),
    }))
    .filter((r) => r.tag)
}

function main() {
  const [dir, outPath = join(ROOT, 'dist-site', 'index.html'), releasesPath] = process.argv.slice(2)
  if (!dir) {
    console.error('usage: node scripts/build-site.mjs <artifactsDir> [out.html]')
    process.exit(2)
  }

  const version = versionFrom(dir)
  const files = readdirSync(dir)
    .filter((f) => !NOT_A_DOWNLOAD.test(f) && INSTALLABLE.test(f))
    // The mirror stores artifacts under the dashed name (electron-builder names
    // files after the product, "Dsh GUI-…"), so link them that way.
    .map((f) => ({ url: f.replace(/ /g, '-') }))
    .sort((a, b) => a.url.localeCompare(b.url))

  if (files.length === 0) throw new Error(`no installable artifacts in ${dir}`)

  const page = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8')
  if (!MARKER.test(page)) throw new Error('site/index.html has no /*__FEED__*/ marker to fill')

  const baked = page.replace(MARKER, `/*__FEED__*/${JSON.stringify({ version, files })}/*__FEED__*/`)
  const outDir = dirname(outPath)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outPath, baked)

  // Page assets (the contact QR) sit next to the page and are referenced by
  // relative path, so they must travel with it.
  const assets = join(ROOT, 'site', 'assets')
  if (existsSync(assets)) cpSync(assets, join(outDir, 'assets'), { recursive: true })

  // Changelog, so "all versions" stays on a page we control.
  const releases = changelogFrom(releasesPath)
  const changelogSrc = readFileSync(join(ROOT, 'site', 'changelog.html'), 'utf8')
  if (!RELEASES_MARKER.test(changelogSrc)) throw new Error('site/changelog.html has no /*__RELEASES__*/ marker')
  writeFileSync(
    join(outDir, 'changelog.html'),
    changelogSrc.replace(RELEASES_MARKER, `/*__RELEASES__*/${JSON.stringify(releases)}/*__RELEASES__*/`),
  )

  console.log(`✓ site built for ${version} → ${outPath}`)
  for (const f of files) console.log(`  offers ${f.url}`)
  console.log(`  changelog: ${releases.length} release(s)`)
}

main()
