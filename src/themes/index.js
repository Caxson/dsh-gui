'use strict';

/**
 * Themes — one mapping, many palettes.
 *
 * A theme here is *data*: nine or so colours, in the shape every editor colour
 * scheme already publishes. Everything visual is derived from that by the one
 * function below, which writes the engine's design tokens and the panel's.
 *
 * That is the whole point of the design. If each theme were a stylesheet, then
 * adding one would mean writing CSS against the engine's markup — whose class
 * names are content hashed and change on every engine release — and users could
 * never contribute one. As data, a theme is a file anyone can drop into their
 * themes directory, and the fragile part (which token means what) exists once.
 *
 * The palettes shipped in palettes.json are ports of well-known open-source
 * schemes, all MIT licensed, each carrying its author and source.
 */

const { readFileSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const BUILTIN_PATH = join(__dirname, 'palettes.json');

/** Colour keys every palette must define; a theme missing one is rejected. */
const REQUIRED = [
  'bg', 'bgAlt', 'bgRaised', 'bgOverlay',
  'text', 'textMuted', 'textFaint',
  'border', 'accent', 'accentText',
  'green', 'red', 'yellow', 'purple', 'cyan',
];

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Check a theme before it is ever applied. A user-supplied file is untrusted
 * input: a bad colour would land inside a stylesheet, so every value has to be
 * a plain hex colour and nothing else.
 */
function validate(theme) {
  if (!theme || typeof theme !== 'object') return 'not an object';
  if (typeof theme.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,48}$/.test(theme.id)) {
    return 'id must be lowercase letters, digits and dashes';
  }
  if (typeof theme.name !== 'string' || !theme.name.trim()) return 'missing name';
  const colors = theme.colors;
  if (!colors || typeof colors !== 'object') return 'missing colors';
  for (const key of REQUIRED) {
    if (!HEX.test(String(colors[key] ?? ''))) return `colors.${key} must be a #rrggbb value`;
  }
  return null;
}

/** Built-in palettes, plus anything valid the user has dropped in. */
function loadThemes(userDir) {
  const themes = [];
  const seen = new Set();
  const add = (theme, origin) => {
    const bad = validate(theme);
    if (bad) {
      console.warn(`[dsh-gui] ignoring theme from ${origin}: ${bad}`);
      return;
    }
    if (seen.has(theme.id)) {
      console.warn(`[dsh-gui] ignoring duplicate theme id "${theme.id}" from ${origin}`);
      return;
    }
    seen.add(theme.id);
    themes.push({ ...theme, custom: origin !== 'built-in' });
  };

  try {
    for (const theme of JSON.parse(readFileSync(BUILTIN_PATH, 'utf8')).themes) add(theme, 'built-in');
  } catch (err) {
    console.warn(`[dsh-gui] built-in themes unreadable: ${err.message}`);
  }

  // A user theme is just a .json file in the themes directory — no install
  // step, no restart beyond a reload of the list.
  if (userDir && existsSync(userDir)) {
    for (const file of readdirSync(userDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        add(JSON.parse(readFileSync(join(userDir, file), 'utf8')), file);
      } catch (err) {
        console.warn(`[dsh-gui] ignoring theme file ${file}: ${err.message}`);
      }
    }
  }
  return themes;
}

/** #rrggbb → "r, g, b", for building rgba() values. */
function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
}

/** Blend two hex colours, for the shades a palette does not name. */
function mix(a, b, weight) {
  const parts = [1, 3, 5].map((i) => {
    const left = parseInt(a.slice(i, i + 2), 16);
    const right = parseInt(b.slice(i, i + 2), 16);
    return Math.round(left + (right - left) * weight);
  });
  return `#${parts.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The single place that knows which engine token means what.
 *
 * Written for both selectors: the engine sets its dark tokens on
 * `body[data-ds-dark-theme]`, so a bare `body` rule alone loses to it.
 */
function engineCss(theme) {
  const c = theme.colors;
  const sel = 'body, body[data-ds-dark-theme]';
  const lines = [
    // Marker: lets a caller tell "the sheet is applied" apart from "the sheet
    // is applied but something else wins", which are very different bugs.
    `--dsh-gui-theme: "${theme.id}"`,
    `--dsw-alias-bg-base: ${c.bg}`,
    `--dsw-alias-bg-layer-1: ${c.bgAlt}`,
    `--dsw-alias-bg-layer-2: ${c.bgRaised}`,
    `--dsw-alias-bg-overlay: ${c.bgOverlay}`,
    `--dsw-alias-bg-module-platform: ${c.bgAlt}`,
    `--dsw-alias-bg-multi-select: ${c.bgRaised}`,
    `--dsw-alias-bg-skeleton: ${mix(c.bg, c.text, 0.08)}`,
    `--dsw-alias-bg-mask-1: rgba(${rgb(c.bg)}, 0.72)`,
    `--dsw-alias-text-1: ${c.text}`,
    `--dsw-alias-text-2: ${c.textMuted}`,
    `--dsw-alias-text-3: ${c.textFaint}`,
    `--dsw-alias-text-4: ${mix(c.textFaint, c.bg, 0.35)}`,
    `--dsw-alias-border-l1: ${c.border}`,
    `--dsw-alias-border-l2: ${mix(c.border, c.bg, 0.4)}`,
    `--dsw-alias-brand-primary: ${c.accent}`,
    // The engine really does define a token by this name; it looks like a
    // build accident on their side, but overriding only the tidy one leaves
    // brand-coloured surfaces on the original palette.
    `--dsw-alias-brand-primary-new-colorprimary-new-color: ${c.accent}`,
    `--dsw-alias-brand-primary-invert: ${c.accentText}`,
    `--dsw-alias-brand-text: ${c.accent}`,
    `--dsw-alias-button-elevated-fill: ${c.bgRaised}`,
    `--dsw-alias-button-floating-fill: ${c.bgRaised}`,
    `--dsw-alias-button-floating-hover: ${c.bgOverlay}`,
    `--dsw-alias-markdown-code-block: ${c.bgAlt}`,
    `--dsw-alias-success: ${c.green}`,
    `--dsw-alias-error: ${c.red}`,
    `--dsw-alias-warning: ${c.yellow}`,
  ];
  // !important on every declaration, and it is not paranoia: the engine writes
  // its own theme stylesheet after the page hydrates, so it lands later in the
  // cascade than anything injected at did-finish-load and wins ties on order.
  // Measured — an earlier version without this applied cleanly (a marker
  // property did change) while every contested token kept the engine's value.
  return `${sel} {\n  ${lines.map((l) => `${l} !important`).join(';\n  ')};\n}\n`;
}

/** The same palette, expressed in the panel's own variables. */
function panelCss(theme) {
  const c = theme.colors;
  const lines = [
    `--bg: ${c.bg}`,
    `--bg-2: ${c.bgAlt}`,
    `--bg-3: ${c.bgRaised}`,
    `--bg-hover: ${c.bgOverlay}`,
    `--border: rgba(${rgb(c.text)}, 0.07)`,
    `--border-strong: rgba(${rgb(c.text)}, 0.13)`,
    `--text: ${c.text}`,
    `--text-mid: ${c.textMuted}`,
    `--text-dim: ${c.textFaint}`,
    `--accent: ${c.accent}`,
    `--green: ${c.green}`,
    `--red: ${c.red}`,
    `--yellow: ${c.yellow}`,
    `--purple: ${c.purple}`,
    `--add-bg: rgba(${rgb(c.green)}, 0.12)`,
    `--rem-bg: rgba(${rgb(c.red)}, 0.12)`,
  ];
  return `:root {\n  ${lines.join(';\n  ')};\n}\n`;
}

/** Terminal colours, so xterm follows the theme rather than staying fixed. */
function terminalTheme(theme) {
  const c = theme.colors;
  return {
    background: c.bg,
    foreground: c.text,
    cursor: c.accent,
    cursorAccent: c.bg,
    selectionBackground: `rgba(${rgb(c.accent)}, 0.32)`,
    black: c.bgRaised,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.accent,
    magenta: c.purple,
    cyan: c.cyan,
    white: c.text,
    brightBlack: c.textFaint,
    brightRed: mix(c.red, '#ffffff', 0.25),
    brightGreen: mix(c.green, '#ffffff', 0.25),
    brightYellow: mix(c.yellow, '#ffffff', 0.25),
    brightBlue: mix(c.accent, '#ffffff', 0.25),
    brightMagenta: mix(c.purple, '#ffffff', 0.25),
    brightCyan: mix(c.cyan, '#ffffff', 0.25),
    brightWhite: '#ffffff',
  };
}

module.exports = { loadThemes, validate, engineCss, panelCss, terminalTheme, REQUIRED };
