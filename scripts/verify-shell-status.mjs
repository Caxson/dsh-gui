#!/usr/bin/env node
/**
 * verify:shell — the sidebar status line's pure logic, without a browser.
 *
 * The interesting part is the path trim. It has to fit a fixed strip in the
 * engine's footer, and it trims from the *front*: CSS `text-overflow` cuts the
 * end, and the end of a path is the half that identifies it. Budgeting in
 * characters was wrong for Chinese — there is no true monospace CJK face, so
 * those glyphs take two columns and a Chinese path silently overflowed to
 * twice its budget, at which point CSS cut the tail after all.
 *
 * The file is written for the engine's module loader, so it is evaluated here
 * with that loader stubbed out rather than imported.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadShell() {
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { factory = mod.factory } } },
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
  }
  runInNewContext(readFileSync(join(ROOT, 'shell', 'client.js'), 'utf8'), sandbox)
  if (!factory) throw new Error('shell/client.js did not register a module')
  // Only the pure helpers are exercised, so the React stubs never get called.
  const stub = { jsx: () => null, jsxs: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f }
  return factory(() => stub)
}

const shell = loadShell()
const { shortenPath, columnsOf, PATH_COLUMNS } = shell

let failures = 0
const check = (name, got, want) => {
  const ok = got === want
  if (!ok) {
    failures += 1
    console.error(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`)
  }
  return ok
}
const atMost = (name, got, limit) => {
  if (got > limit) {
    failures += 1
    console.error(`✗ ${name}: ${got} columns, budget is ${limit}`)
  }
}

// Home collapses to ~, and a short path is left alone.
check('home collapses', shortenPath('/Users/x/code', '/Users/x'), '~/code')
check('short path untouched', shortenPath('/tmp/a', null), '/tmp/a')
check('non-string', shortenPath(null, null), '')

// Long latin path: trimmed from the front, tail intact, within budget.
const long = '/Users/someone/Public/code/dsh-desktop/worktrees/market'
const cutLatin = shortenPath(long, null)
check('latin keeps the tail', cutLatin.endsWith('market'), true)
check('latin trims the front', cutLatin.startsWith('…'), true)
atMost('latin fits', columnsOf(cutLatin), PATH_COLUMNS)

// Chinese path: this is the case character-counting got wrong. Twenty-four
// Chinese characters are forty-eight columns — twice the strip.
const cn = '/Users/x/文稿/项目/深度求索/工作区/客户端/面板重构'
const cutCn = shortenPath(cn, null)
check('cjk keeps the tail', cutCn.endsWith('面板重构'), true)
atMost('cjk fits the same strip', columnsOf(cutCn), PATH_COLUMNS)
check('cjk actually got shorter', columnsOf(cutCn) < columnsOf(cn), true)

// Mixed scripts land in between rather than following either rule.
const mixed = '/Users/x/code/寻风-geo/monitoring/dashboards/latest'
atMost('mixed fits', columnsOf(shortenPath(mixed, null)), PATH_COLUMNS)
check('mixed keeps the tail', shortenPath(mixed, null).endsWith('latest'), true)

// Astral-plane characters are single code points made of two UTF-16 units;
// slicing by index can cut one in half and render two replacement glyphs.
const emoji = '/Users/x/code/🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀/build'
const cutEmoji = shortenPath(emoji, null)
check('no broken surrogate', /[\uD800-\uDFFF]/.test(cutEmoji.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), false)
check('emoji keeps the tail', cutEmoji.endsWith('build'), true)

// A single unbroken segment longer than the budget still has to fit.
atMost('one long segment fits', columnsOf(shortenPath('/' + 'a'.repeat(200), null)), PATH_COLUMNS)
atMost('one long cjk segment fits', columnsOf(shortenPath('/' + '重'.repeat(200), null)), PATH_COLUMNS)

// Column counting itself.
check('columns: latin', columnsOf('abc'), 3)
check('columns: cjk', columnsOf('重构'), 4)
check('columns: mixed', columnsOf('a重'), 3)

// The change count is read off the activity log, deduped by path.
const { countChangedFiles } = shell
check('changed files dedupe', countChangedFiles({
  activities: [
    { kind: 'file', path: '/a' }, { kind: 'file', path: '/a' },
    { kind: 'file', path: '/b' }, { kind: 'shell', path: '/c' }, null,
  ],
}), 2)
check('changed files empty', countChangedFiles(null), 0)

if (failures > 0) {
  console.error(`\n✗ shell status: ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('✓ shell status coherent — path trim fits its strip in latin, Chinese and mixed paths.')
