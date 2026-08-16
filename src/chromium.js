'use strict';

/**
 * On-demand Chromium for the browser pane.
 *
 * Chromium is ~355MB unpacked — 40% of the whole app — and most people never
 * open the browser tab. So it is not shipped inside the bundle; the first time
 * someone needs it we fetch it into the user data directory, where it also
 * survives app updates instead of being re-downloaded with every release.
 *
 * The download goes through Playwright's own installer so the on-disk layout
 * and its completion markers stay exactly what Playwright expects to find.
 * We only redirect where the archive comes from: our CDN first (Playwright's
 * default host is slow and frequently unreachable from mainland China), the
 * official host as a fallback.
 */

const { spawn } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

// Mirrors Playwright's published layout, so its downloader can be pointed here
// unchanged. Populated by the release workflow.
const MIRROR_HOST = 'https://merefusion-static.oss-cn-hangzhou.aliyuncs.com/playwright';

/** Browsers shipped inside the bundle, when a build chose to include them. */
function bundledDir() {
  return join(process.resourcesPath ?? '', 'browsers');
}

/** Writable location used for on-demand installs. */
function userDir(app) {
  return join(app.getPath('userData'), 'browsers');
}

/**
 * Where Playwright should look. A bundled copy wins when present so a build
 * that still embeds Chromium keeps working untouched.
 */
function resolveBrowsersPath(app) {
  const bundled = bundledDir();
  return existsSync(bundled) ? bundled : userDir(app);
}

/**
 * Chromium counts as installed only when Playwright's completion marker is
 * there — a half-extracted directory would otherwise look installed and then
 * fail at launch.
 */
function isInstalled(browsersPath) {
  if (!existsSync(browsersPath)) return false;
  try {
    return readdirSync(browsersPath)
      .filter((name) => name.startsWith('chromium-'))
      .some((name) => existsSync(join(browsersPath, name, 'INSTALLATION_COMPLETE')));
  } catch {
    return false;
  }
}

/** Playwright's CLI, run through Electron's bundled Node. */
function cliPath() {
  try {
    return require.resolve('playwright/cli.js');
  } catch {
    return null;
  }
}

function runInstaller({ browsersPath, downloadHost, onOutput }) {
  return new Promise((resolve) => {
    const cli = cliPath();
    if (cli === null) {
      resolve({ ok: false, output: '找不到 Playwright 安装器' });
      return;
    }
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      NO_COLOR: '1',
    };
    if (downloadHost) env.PLAYWRIGHT_DOWNLOAD_HOST = downloadHost;

    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const collect = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 20_000) output = output.slice(-20_000);
      if (onOutput) onOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ ok: false, output: `${output}\n${err.message}` }));
    child.on('exit', (code) => resolve({ ok: code === 0, output }));
  });
}

/**
 * Fetch Chromium if it is missing. Tries our CDN first and falls back to
 * Playwright's default host, so a mirror that is missing this particular
 * revision degrades to a slow download rather than a broken feature.
 *
 * @returns {Promise<{ok: boolean, alreadyInstalled?: boolean, output?: string}>}
 */
async function ensureChromium(app, onOutput) {
  const browsersPath = resolveBrowsersPath(app);
  if (isInstalled(browsersPath)) return { ok: true, alreadyInstalled: true };

  const viaMirror = await runInstaller({ browsersPath, downloadHost: MIRROR_HOST, onOutput });
  if (viaMirror.ok && isInstalled(browsersPath)) return { ok: true };

  if (onOutput) onOutput('\n镜像不可用，改用官方源重试…\n');
  const viaOfficial = await runInstaller({ browsersPath, downloadHost: null, onOutput });
  if (viaOfficial.ok && isInstalled(browsersPath)) return { ok: true };

  return { ok: false, output: viaOfficial.output || viaMirror.output };
}

module.exports = { resolveBrowsersPath, isInstalled, ensureChromium };
