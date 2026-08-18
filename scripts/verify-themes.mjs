#!/usr/bin/env node
/**
 * verify-themes — the palettes are data a user can supply, and their values end
 * up inside a stylesheet that is injected into the engine's page. So this
 * checks the validator the way an attacker would use it, not the way a
 * well-formed theme would.
 */

import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { loadThemes, validate, engineCss, panelCss, terminalTheme, REQUIRED } =
  require(join(ROOT, 'src', 'themes', 'index.js'))

let failures = []
const check = (ok, label) => {
  if (ok) console.log(`  ok  ${label}`)
  else { failures.push(label); console.error(`  FAIL  ${label}`) }
}

const good = () => ({
  id: 'test-theme',
  name: 'Test',
  colors: Object.fromEntries(REQUIRED.map((k) => [k, '#123456'])),
})

console.log('built-in palettes:')
const builtin = loadThemes(null)
check(builtin.length >= 8, `${builtin.length} palettes load`)
check(builtin.every((t) => validate(t) === null), 'every shipped palette validates')
check(new Set(builtin.map((t) => t.id)).size === builtin.length, 'ids are unique')
check(builtin.some((t) => t.dark === false), 'at least one light theme ships')
check(
  builtin.filter((t) => t.source).every((t) => t.author && t.source.startsWith('https://')),
  'ported themes carry their author and source',
)

console.log('\nrejecting malformed themes:')
{
  const t = good(); delete t.colors.accent
  check(validate(t) !== null, 'a missing colour is rejected')
}
for (const bad of [
  'red',                       // a named colour would be valid CSS but is not our shape
  '#fff',                      // short hex
  '#12345g',                   // not hex
  '#123456; } body { display:none',  // trying to close the rule and add one
  'red; background-image: url(http://evil/x)',
  'var(--something)',
  '#123456 !important',
  'expression(alert(1))',
  '',
]) {
  const t = good(); t.colors.bg = bad
  check(validate(t) !== null, `colour ${JSON.stringify(bad)} is rejected`)
}
for (const id of ['../../etc', 'UPPER', 'has space', '', 'x'.repeat(60), './x']) {
  const t = good(); t.id = id
  check(validate(t) !== null, `id ${JSON.stringify(id)} is rejected`)
}
for (const junk of [null, undefined, 42, 'theme', []]) {
  check(validate(junk) !== null, `${JSON.stringify(junk) ?? 'undefined'} is not a theme`)
}

console.log('\ngenerated css:')
{
  const t = good()
  const css = engineCss(t) + panelCss(t)
  // Anything that got through would appear here, so assert on the output too.
  check(!/[<>]/.test(css), 'no angle brackets can appear in the generated css')
  check((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, 'braces stay balanced')
  check(css.includes('--dsw-alias-bg-base'), 'engine tokens are written')
  check(css.includes('body[data-ds-dark-theme]'), 'the engine dark selector is targeted too')
  check(css.includes('--bg-hover'), 'panel variables are written')
  const term = terminalTheme(t)
  check(typeof term.background === 'string' && typeof term.brightRed === 'string',
    'the terminal palette is derived as well')
}
{
  // Every shipped palette must produce sane css, not just the synthetic one.
  const bad = builtin.filter((t) => {
    const css = engineCss(t) + panelCss(t)
    return /undefined|NaN|#NaN/.test(css)
  })
  check(bad.length === 0, `no shipped palette produces undefined/NaN values${bad.length ? ` (${bad.map((t) => t.id)})` : ''}`)
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} theme check(s) failed`)
  process.exit(1)
}
console.log(`\n✓ ${builtin.length} palettes, and only well-formed colours reach the stylesheet`)
