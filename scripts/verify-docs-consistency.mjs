#!/usr/bin/env node
/**
 * verify-docs-consistency — bilingual documentation coherence gate.
 *
 * README.md is the single user-facing document, written bilingual inline
 * (Chinese + English in the same sections). Two failure modes recur: a doc
 * edit that drifts from what the code actually does (renamed env var, changed
 * artifact names, dropped npm script), and a rewrite that silently deletes one
 * of the two languages. Both are embarrassing in an open-source repo and
 * neither is caught by compilation.
 *
 * This gate reads only committed files (no install, no network) and asserts:
 *
 *   1. Bilingual presence — the README carries both CJK and English prose.
 *   2. Section parity — the four main sections each carry a "中文 / English"
 *      heading pair, so neither language can silently vanish.
 *   3. Script drift — every `npm run <name>` mentioned in the README exists in
 *      package.json (a removed/changed script breaks the doc immediately).
 *   4. Env-var drift — every `DSH_GUI_*` variable named in the README is
 *      actually read by src/main.js.
 *   5. Factual drift — product name, repo URL, arm64-only claim, update
 *      artifacts and license all match package.json / electron-builder.yml.
 *
 * Exit 0 = coherent. Exit 1 = drift, with each violation printed.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let checks = 0

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function check(ok, label, detail = '') {
  checks++
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/** A "中文 / English" heading pair on one line. */
function hasHeadingPair(text, zh, en) {
  const re = new RegExp(`^#{1,6}\\s+.*${zh}.*/.*${en}.*$`, 'm')
  return re.test(text)
}

function main() {
  const readme = read('README.md')
  const pkg = JSON.parse(read('package.json'))
  const builder = read('electron-builder.yml')
  const mainJs = read('src/main.js')

  // ── 1. bilingual presence ────────────────────────────────────────────────
  const hasCjk = /[\u4e00-\u9fff]/.test(readme)
  const hasLatin = /[A-Za-z]{4,}/.test(readme.replace(/[`#>*_\-|()0-9.\[\]:/\\ ]/g, ' '))
  check(hasCjk, 'bilingual: README has no Chinese text (CJK)')
  check(hasLatin, 'bilingual: README has no English prose')

  // ── 2. section heading parity ────────────────────────────────────────────
  const sections = [
    ['特性', 'Features'],
    ['安装', 'Install'],
    ['开发', 'Development'],
    ['发版', 'Release'],
  ]
  for (const [zh, en] of sections) {
    check(
      hasHeadingPair(readme, zh, en),
      `sections: "${zh} / ${en}" heading pair missing`,
      `expected a "# … ${zh} / ${en} …" line`,
    )
  }

  // ── 3. npm script drift ──────────────────────────────────────────────────
  const scripts = pkg.scripts ?? {}
  for (const m of readme.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    check(m[1] in scripts, `scripts: "npm run ${m[1]}" in README missing from package.json`)
  }

  // ── 4. env-var drift ─────────────────────────────────────────────────────
  for (const m of readme.matchAll(/DSH_GUI_[A-Z_]+/g)) {
    check(
      mainJs.includes(m[0]),
      `env: "${m[0]}" documented but never read in src/main.js`,
    )
  }

  // ── 5. factual drift ─────────────────────────────────────────────────────
  // product name: README display name ↔ electron-builder productName.
  const product = /^productName:\s*(\S.*)$/m.exec(builder)?.[1]?.trim()
  check(
    product && readme.includes(product),
    'facts: README does not mention the packaged product name',
    `electron-builder productName is "${product}"`,
  )

  // repo URL: README Releases link ↔ package.json repository.
  const repoUrl = pkg.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '')
  check(
    repoUrl && readme.includes(repoUrl),
    'facts: README does not link the canonical repo URL',
    `package.json repository.url is "${repoUrl}"`,
  )

  // arm64-only: README claim ↔ electron-builder mac.target (dmg + zip, arm64).
  const macBlock = builder.split(/^mac:/m)[1] ?? ''
  const targetBlock = (macBlock.split(/^publish:/m)[0] ?? macBlock)
  check(
    /arm64/.test(targetBlock),
    'facts: electron-builder no longer targets arm64 (README says arm64-only)',
  )
  check(
    !/x64/.test(targetBlock),
    'facts: electron-builder gained an x64 target the README does not mention',
  )
  check(
    /- target: dmg/.test(targetBlock) && /- target: zip/.test(targetBlock),
    'facts: electron-builder mac targets (dmg/zip) drifted from README claims',
  )

  // update artifacts: README artifact list ↔ electron-builder targets/publish.
  check(
    /provider: github/.test(builder),
    'facts: electron-builder publish provider is no longer github (README: GitHub Releases channel)',
  )

  // license: README ↔ package.json ↔ LICENSE file.
  check(
    /MIT/.test(readme) && /"license":\s*"MIT"/.test(read('package.json')),
    'facts: README/package.json license text drifted',
  )
  check(
    existsSync(join(ROOT, 'LICENSE')) && /MIT License/.test(read('LICENSE')),
    'facts: LICENSE file missing or not MIT',
  )

  // ── summary ──────────────────────────────────────────────────────────────
  if (failures.length > 0) {
    console.error(`✗ docs consistency broken — ${failures.length} violation(s):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`✓ docs consistency coherent — ${checks} assertions passed.`)
}

main()
