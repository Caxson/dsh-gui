'use strict';

/**
 * Dsh GUI — main process.
 *
 * The app is a thin native shell around the DeepSeek Harness (DSH) engine:
 *   1. it spawns the bundled `dsh web` server as a child process
 *      (ELECTRON_RUN_AS_NODE, so the Electron binary itself is the Node runtime);
 *   2. the server boots the `web` profile with the Dsh GUI plugin overlay
 *      (plugins/desktop.patch.yml) and picks a free port (--port 0);
 *   3. the shell reads the printed URL line, opens a Codex-like window,
 *      injects the desktop skin, and manages lifecycle.
 */

const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, shell, dialog, ipcMain, clipboard } = require('electron');
const { spawn } = require('node:child_process');
const { join, resolve: resolvePath, sep } = require('node:path');
const { existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } = require('node:fs');
const { autoUpdater } = require('electron-updater');
const { resolveBrowsersPath, isInstalled, ensureChromium } = require('./chromium');
const { insertIntoComposer } = require('./composer');
const { loadThemes, engineCss, panelCss, terminalTheme } = require('./themes');
const { createPairing } = require('./mobile-pairing');
const QRCode = require('qrcode');

const APP_NAME = 'Dsh GUI';
const APP_ROOT = join(__dirname, '..');
const DSH_BIN = join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const PATCH_FILE = join(APP_ROOT, 'plugins', 'desktop.patch.yml');

// Test/CI hooks (no effect in normal use): redirect Chromium user data and
// disable the Chromium sandbox so the app can run inside a restricted file
// sandbox (e.g. an agent's workspace) that blocks ~/Library writes.
if (process.env.DSH_GUI_USER_DATA && process.env.DSH_GUI_USER_DATA.trim() !== '') {
  app.setPath('userData', process.env.DSH_GUI_USER_DATA);
}
if (process.env.DSH_GUI_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

const SMOKE = process.env.DSH_GUI_SMOKE === '1';
const BOOT_TIMEOUT_MS = 120_000;

// ── auto-update ───────────────────────────────────────────────────────────
// Artifacts are published to GitHub Releases and mirrored to a static CDN that
// serves the same dmg/zip/blockmap/latest-mac.yml. The mirror is the default
// update feed: most users are in mainland China, where pulling a ~440MB delta
// from GitHub is slow and often fails outright. Set DSH_GUI_UPDATE_URL to
// override (use "github" to fall back to the embedded GitHub feed).
const UPDATE_MIRROR_URL = 'https://merefusion-static.oss-cn-hangzhou.aliyuncs.com/dsh-gui/';
const UPDATE_URL_RAW = (process.env.DSH_GUI_UPDATE_URL || '').trim();
// Empty → mirror (default). "github" → embedded GitHub feed. Anything else →
// that URL, so a self-hosted mirror stays one env var away.
const UPDATE_URL_OVERRIDE =
  UPDATE_URL_RAW.toLowerCase() === 'github' ? '' : UPDATE_URL_RAW || UPDATE_MIRROR_URL;
const UPDATE_DOWNLOAD_PAGE =
  process.env.DSH_GUI_DOWNLOAD_PAGE ||
  'https://github.com/Caxson/dsh-gui/releases/latest';

let checkingManually = false;

function setupAutoUpdater() {
  if (UPDATE_URL_OVERRIDE) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: UPDATE_URL_OVERRIDE.replace(/\/?$/, '/'),
    });
  }
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true; // autoInstallOnAppQuit defaults to true

  autoUpdater.on('update-available', (info) => {
    console.log(`[dsh-gui] update available: ${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    if (checkingManually) {
      checkingManually = false;
      dialog.showMessageBox({
        type: 'info',
        message: '已是最新版本',
        detail: '当前没有可用的更新。',
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      buttons: ['立即重启更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      message: `新版本 ${info.version} 已下载完成`,
      detail: '重启后会自动完成更新。',
    });
    if (choice === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    console.error('[dsh-gui] updater error:', err.message);
    if (checkingManually) {
      checkingManually = false;
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['打开下载页', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '自动更新不可用',
        detail:
          '检查更新失败（未签名 App 或更新服务器不可达）。可打开下载页手动获取最新版本。\n\n' +
          err.message,
      });
      if (choice === 0) shell.openExternal(UPDATE_DOWNLOAD_PAGE);
    }
  });

  return autoUpdater;
}

function checkForUpdates(manual) {
  checkingManually = manual;
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    console.error('[dsh-gui] updater check failed:', err.message);
    checkingManually = false;
  }
}

let dshChild = null;
let win = null;
let mainView = null;
let bootLog = [];

// ── Codex-style right panel (tabbed: 终端 / 文件 / 浏览器 / 侧边聊天) ────────
const PANEL_WIDTH = 400;
let panelView = null;
let popupWin = null; // panel popped out into its own window
let chromiumInstall = null; // in-flight on-demand Chromium download, if any
// Smoke-only: whether the run has already created its workspace + session, and
// what came of it (reported alongside the probes).
let smokeSeeded = false;
let smokeSeed = 'skipped';
// Hidden by default (Codex-style: surface the panel on demand via Cmd+B).
// Smoke mode forces it visible so the layout probe can exercise both states.
let panelVisible = SMOKE;
let activeTab = 'terminal';
const termSeqs = new Map(); // pty id → last delivered output seq
let openTerminalIds = ['agent'];
let engineUrl = null;
let stateTimer = null;
let termTimer = null;
let shotTimer = null;
let lastBridgeState = null;
// ── phone link ─────────────────────────────────────────────────────────────
let pairing = null;      // created once userData is known (after app ready)
let pairingWin = null;

/** All live panel renderers (docked view + popped-out window). */
function panelTargets() {
  const targets = [];
  if (panelView && !panelView.webContents.isDestroyed()) targets.push(panelView.webContents);
  if (popupWin && !popupWin.isDestroyed()) targets.push(popupWin.webContents);
  return targets;
}

function sendToPanels(channel, ...args) {
  for (const wc of panelTargets()) wc.send(channel, ...args);
}

/**
 * Every window we skin ourselves. The pairing window is a separate surface with
 * its own preload, and leaving it out of the theme broadcast is how it ended up
 * carrying its own copy of the palette — which then ignored every theme switch.
 */
function themedTargets() {
  const targets = panelTargets();
  if (pairingWin && !pairingWin.isDestroyed()) targets.push(pairingWin.webContents);
  return targets;
}

function layoutViews() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  const mainW = Math.max(0, width - (panelVisible ? PANEL_WIDTH : 0));
  if (mainView) mainView.setBounds({ x: 0, y: 0, width: mainW, height });
  if (panelView) {
    panelView.setBounds({
      x: mainW,
      y: 0,
      width: panelVisible ? PANEL_WIDTH : 0,
      height,
    });
  }
}

function createPanelView() {
  panelView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'panel', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(panelView);
  panelView.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.warn('[panel]', message);
  });
  panelView.setBackgroundColor('#151517');
  panelView.webContents.loadFile(join(__dirname, 'panel', 'panel.html'));
  panelView.webContents.on('did-finish-load', () => {
    // Covers a reload of the docked panel; on the first load this is a no-op,
    // because the shared cursor has not moved yet and the poll delivers the
    // history anyway.
    replayTerminalsTo(panelView.webContents);
    if (SMOKE) console.log(JSON.stringify({ panel: 'ok' }));
  });
  layoutViews();
}

function togglePanel() {
  panelVisible = !panelVisible;
  layoutViews();
  try {
    writeFileSync(panelPrefPath(), JSON.stringify({ panelVisible }));
  } catch {
    /* non-fatal */
  }
}

function panelPrefPath() {
  return join(app.getPath('userData'), 'panel-pref.json');
}

function readPanelPref() {
  if (SMOKE) return; // keep the forced-visible default for the layout probe
  try {
    const raw = readFileSync(panelPrefPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.panelVisible === 'boolean') panelVisible = parsed.panelVisible;
  } catch {
    /* default shown */
  }
}

async function ptyPost(path, body) {
  if (!engineUrl) {
    if (process.env.DSH_GUI_DEBUG) console.log(`[pty-debug] drop ${path}: no engineUrl`);
    return;
  }
  try {
    const res = await fetch(`${engineUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (process.env.DSH_GUI_DEBUG) console.log(`[pty-debug] ${path} -> ${res.status}`);
  } catch (err) {
    if (process.env.DSH_GUI_DEBUG) console.log(`[pty-debug] ${path} failed: ${err.message}`);
  }
}

let pollDebugAt = 0;
async function pollTerminalOut() {
  let debugTick = false;
  if (process.env.DSH_GUI_DEBUG && Date.now() - pollDebugAt > 2000) {
    pollDebugAt = Date.now();
    debugTick = true;
    console.log(`[pty-debug] poll url=${!!engineUrl} targets=${panelTargets().length} ids=${JSON.stringify(openTerminalIds)}`);
  }
  if (!engineUrl || panelTargets().length === 0) return;
  for (const id of openTerminalIds) {
    try {
      const since = termSeqs.get(id) ?? -1;
      const res = await fetch(
        `${engineUrl}/dsh-gui/terminal/out?id=${encodeURIComponent(id)}&since=${since}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        if (process.env.DSH_GUI_DEBUG) console.log(`[pty-debug] out ${id} http ${res.status}`);
        continue;
      }
      const data = await res.json();
      termSeqs.set(id, data.seq);
      if (debugTick) console.log(`[pty-debug] out ${id} seq=${data.seq} n=${data.chunks?.length ?? 'nil'}`);
      if (data.chunks?.length) {
        for (const chunk of data.chunks) sendToPanels('panel:pty-data', id, chunk);
      }
    } catch (err) {
      if (process.env.DSH_GUI_DEBUG) console.log(`[pty-debug] out ${id} failed: ${err.message}`);
    }
  }
}

// ── themes ────────────────────────────────────────────────────────────────
// A theme is a palette; src/themes turns it into engine tokens, panel
// variables and a terminal palette. Switching one re-injects those, so it takes
// effect without a restart.

/** Where a user drops their own theme files. */
function userThemeDir() {
  return join(app.getPath('userData'), 'themes');
}

function themePrefPath() {
  return join(app.getPath('userData'), 'theme.json');
}

function currentThemeId() {
  try {
    const saved = JSON.parse(readFileSync(themePrefPath(), 'utf8'));
    if (typeof saved.id === 'string') return saved.id;
  } catch {
    /* no preference yet */
  }
  return 'midnight';
}

/** The CSS key of what we last injected, so a switch can replace it. */
let injectedThemeKey = null;

async function applyTheme(id) {
  const themes = loadThemes(userThemeDir());
  const theme = themes.find((t) => t.id === id) ?? themes[0];
  if (!theme) return { ok: false, reason: 'no themes available' };

  if (mainView && !mainView.webContents.isDestroyed()) {
    try {
      // Remove the previous sheet first; insertCSS stacks otherwise, and the
      // older rule would keep winning wherever specificity ties.
      if (injectedThemeKey) await mainView.webContents.removeInsertedCSS(injectedThemeKey);
      injectedThemeKey = await mainView.webContents.insertCSS(engineCss(theme));
    } catch (err) {
      console.warn('[dsh-gui] theme injection failed:', err.message);
    }
  }
  const payload = { css: panelCss(theme), terminal: terminalTheme(theme), id: theme.id };
  for (const wc of themedTargets()) wc.send('panel:theme', payload);
  try {
    writeFileSync(themePrefPath(), JSON.stringify({ id: theme.id }));
  } catch {
    /* non-fatal: the theme still applies for this run */
  }
  return { ok: true, id: theme.id };
}

/**
 * Give a freshly attached panel renderer the terminal history it missed.
 *
 * Output is polled once per terminal and broadcast to every panel, with a
 * single shared cursor per pty. That is right for keeping panels in step, but
 * it means a renderer that attaches later — the popped-out window, or the
 * docked panel after a reload — starts at a cursor that has already moved past
 * everything the agent did, and shows an empty terminal.
 *
 * So replay the ring buffer from the start, to that renderer only. The buffer
 * is capped by the bridge, so this is bounded.
 */
async function replayTerminalsTo(webContents) {
  if (!engineUrl || !webContents || webContents.isDestroyed()) return;
  for (const id of openTerminalIds) {
    // Only for terminals the shared cursor has already moved past. On the very
    // first attach it has not, and the normal poll will deliver the same
    // history — replaying as well would print everything twice.
    if (!termSeqs.has(id)) continue;
    try {
      const res = await fetch(
        `${engineUrl}/dsh-gui/terminal/out?id=${encodeURIComponent(id)}&since=-1`,
        { cache: 'no-store' },
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (webContents.isDestroyed()) return;
      for (const chunk of data.chunks ?? []) webContents.send('panel:pty-data', id, chunk);
    } catch (err) {
      if (process.env.DSH_GUI_DEBUG) console.log(`[pty-debug] replay ${id} failed: ${err.message}`);
    }
  }
}

async function pollBrowserShot() {
  if (!engineUrl || activeTab !== 'web') return;
  try {
    const res = await fetch(`${engineUrl}/dsh-gui/browser/shot`, { cache: 'no-store' });
    if (!res.ok) return;
    const shot = await res.json();
    sendToPanels('panel:browser-shot', shot);
  } catch {
    /* transient */
  }
}

async function pollBridgeState() {
  if (!engineUrl) return;
  try {
    const res = await fetch(`${engineUrl}/dsh-gui/state`, { cache: 'no-store' });
    if (!res.ok) return;
    lastBridgeState = await res.json();
    sendToPanels('panel:state', lastBridgeState);
  } catch {
    /* engine not ready / restarted — next tick retries */
  }
}

// chatId → AbortController for the in-flight side-chat stream; aborting the
// fetch drops the HTTP connection, which the bridge observes (req 'close') and
// cancels the model call — so closing a chat tab stops billing.
const sidechatAborts = new Map();

/** Stream one side-chat completion from the bridge and forward the chunks. */
async function runSidechat(chatId, messages) {
  if (!engineUrl) {
    sendToPanels('panel:sidechat-chunk', chatId, '', true, '引擎还没就绪');
    return;
  }
  sidechatAborts.get(chatId)?.abort(); // supersede any prior stream for this chat
  const abort = new AbortController();
  sidechatAborts.set(chatId, abort);
  try {
    const res = await fetch(`${engineUrl}/dsh-gui/sidechat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: abort.signal,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        detail = (await res.json()).error ?? detail;
      } catch { /* non-JSON error body */ }
      sendToPanels('panel:sidechat-chunk', chatId, '', true, detail);
      return;
    }
    const decoder = new TextDecoder();
    for await (const part of res.body) {
      sendToPanels('panel:sidechat-chunk', chatId, decoder.decode(part, { stream: true }), false);
    }
    sendToPanels('panel:sidechat-chunk', chatId, '', true);
  } catch (err) {
    if (err.name === 'AbortError') return; // tab closed — no error to surface
    sendToPanels('panel:sidechat-chunk', chatId, '', true, err.message);
  } finally {
    if (sidechatAborts.get(chatId) === abort) sidechatAborts.delete(chatId);
  }
}

/** Pop the panel out into its own window; the docked view collapses meanwhile. */
function popOutPanel() {
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.focus();
    return;
  }
  popupWin = new BrowserWindow({
    width: 460,
    height: 820,
    minWidth: 340,
    minHeight: 480,
    title: 'Dsh GUI 面板',
    backgroundColor: '#151517',
    webPreferences: {
      preload: join(__dirname, 'panel', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  popupWin.loadFile(join(__dirname, 'panel', 'panel.html'));
  popupWin.webContents.on('did-finish-load', () => {
    if (lastBridgeState) popupWin.webContents.send('panel:state', lastBridgeState);
    // Without this the popped-out terminal opens blank: the shared output
    // cursor is already past everything the agent has done.
    replayTerminalsTo(popupWin.webContents);
  });
  // Remember whether the dock was visible before popping out, so closing the
  // popup restores exactly that state (never un-collapses a panel the user
  // had deliberately hidden).
  const dockWasVisible = panelVisible;
  popupWin.on('closed', () => {
    popupWin = null;
    if (dockWasVisible && !panelVisible) togglePanel();
  });
  if (panelVisible) togglePanel();
}

let panelIpcWired = false;
function wirePanelIpc() {
  if (panelIpcWired) return; // idempotent: window rebuild must not double-register
  panelIpcWired = true;
  ipcMain.on('panel:pty-open', (_e, id, cols, rows) => ptyPost('/dsh-gui/terminal/open', { id, cols, rows }));
  ipcMain.on('panel:pty-input', (_e, id, data) => ptyPost('/dsh-gui/terminal/input', { id, data }));
  ipcMain.on('panel:pty-resize', (_e, id, cols, rows) => ptyPost('/dsh-gui/terminal/resize', { id, cols, rows }));
  ipcMain.on('panel:pty-close', (_e, id) => {
    // The engine keeps the shared agent PTY; only local tab PTYs are killed.
    ptyPost('/dsh-gui/terminal/close', { id });
    termSeqs.delete(id);
  });
  ipcMain.on('panel:terminals', (_e, ids) => {
    if (process.env.DSH_GUI_DEBUG) console.log(`[pty-debug] terminals=${JSON.stringify(ids)}`);
    if (Array.isArray(ids)) openTerminalIds = ids.filter((v) => typeof v === 'string');
  });
  ipcMain.on('panel:sidechat-send', (_e, chatId, messages) => {
    if (typeof chatId === 'string' && Array.isArray(messages)) runSidechat(chatId, messages);
  });
  ipcMain.on('panel:sidechat-abort', (_e, chatId) => {
    sidechatAborts.get(chatId)?.abort();
  });
  ipcMain.on('panel:popout', () => popOutPanel());
  ipcMain.on('panel:tab', (_e, tab) => {
    activeTab = tab;
  });
  ipcMain.on('panel:collapse', () => togglePanel());

  // Chromium is fetched on demand, so the browser pane asks whether it is
  // there and can trigger the download itself.
  ipcMain.handle('panel:browser-status', () => ({
    installed: isInstalled(resolveBrowsersPath(app)),
  }));

  ipcMain.handle('panel:browser-install', async () => {
    if (chromiumInstall) return chromiumInstall; // one download, not one per click
    chromiumInstall = ensureChromium(app, (text) => {
      sendToPanels('panel:browser-progress', text);
    }).finally(() => {
      chromiumInstall = null;
    });
    return chromiumInstall;
  });

  // The panel is a file:// document, so it cannot address the engine with a
  // relative URL — every other pane already talks through IPC, and the file
  // tree does too. Main holds the engine's address and proxies the call.
  ipcMain.handle('panel:files-list', async (_e, path, showAll) => {
    if (!engineUrl) return { error: '引擎尚未就绪' };
    try {
      const res = await fetch(`${engineUrl}/dsh-gui/files/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: String(path ?? ''), showAll: showAll === true }),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || `HTTP ${res.status}` };
      return data;
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('panel:themes', () => ({
    themes: loadThemes(userThemeDir()).map((t) => ({
      id: t.id, name: t.name, author: t.author ?? '', source: t.source ?? '',
      dark: t.dark !== false, custom: !!t.custom,
      // A few colours so the picker can show what it looks like rather than
      // making the user apply each one to find out.
      swatch: [t.colors.bg, t.colors.bgRaised, t.colors.accent, t.colors.text],
    })),
    current: currentThemeId(),
    dir: userThemeDir(),
  }));

  ipcMain.handle('panel:theme-set', (_e, id) => applyTheme(typeof id === 'string' ? id : ''));

  ipcMain.handle('panel:copy-text', (_e, text) => {
    if (typeof text !== 'string' || !text) return { ok: false, reason: 'empty' };
    clipboard.writeText(text);
    return { ok: true };
  });

  // Reveal a workspace file in the OS file manager. The path is checked against
  // the workspace root here rather than trusted from the renderer: the panel is
  // our own code today, but a reveal is a filesystem action and the check costs
  // nothing.
  ipcMain.handle('panel:reveal-path', (_e, absPath) => {
    const root = lastBridgeState && lastBridgeState.cwd;
    if (!root) return { ok: false, reason: 'no-workspace' };
    if (typeof absPath !== 'string' || !absPath) return { ok: false, reason: 'empty' };
    const resolved = resolvePath(absPath);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return { ok: false, reason: 'outside-workspace' };
    }
    if (!existsSync(resolved)) return { ok: false, reason: 'missing' };
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  // Backflow: the panel hands a reference (a file path, a diff excerpt) to the
  // chat composer. Reaching into the engine's page is confined to
  // src/composer.js; here we only route it and make sure the chat is visible,
  // since text arriving in an off-screen composer reads as nothing happening.
  ipcMain.handle('panel:compose-insert', async (_e, text) => {
    // Focus first, not after: the insertion uses execCommand, which the
    // browser only honours in a focused document — and the click that triggers
    // this happens in the panel, so the chat view is exactly what does *not*
    // have focus at that moment.
    if (mainView && !mainView.webContents.isDestroyed()) mainView.webContents.focus();
    return insertIntoComposer(mainView && mainView.webContents, text);
  });
}

/**
 * DSH home resolution, in priority order:
 *  1. DSH_GUI_HOME env override;
 *  2. the user's existing ~/.dsh — sessions/models/plugins stay in sync with
 *     a locally run `dsh web` instead of forking into a second universe;
 *  3. an app-owned home for machines that never used the dsh CLI.
 */
function resolveDshHome() {
  if (process.env.DSH_GUI_HOME && process.env.DSH_GUI_HOME.trim() !== '') {
    return process.env.DSH_GUI_HOME;
  }
  const cliHome = join(app.getPath('home'), '.dsh');
  if (existsSync(cliHome)) return cliHome;
  return join(app.getPath('appData'), APP_NAME, 'dsh-home');
}

/** First run: seed a dark-theme preference so the GUI opens Codex-like. */
function seedSettings(dshHome) {
  const settingsFile = join(dshHome, 'settings.yaml');
  if (existsSync(settingsFile)) return;
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(
    settingsFile,
    '# First-run defaults written by Dsh GUI.\n' +
      'ui-theme:\n' +
      '  preference: dark\n',
  );
}

/**
 * Seed the 心流模式 (Flow Mode) agent preset: the engine's standard assembly
 * plus the dsh-gui-flow triage row. Regenerated every boot so the copied
 * standard manifest tracks engine upgrades; preset discovery is unmemoized,
 * so the preset shows up in the new-session mode picker without a restart.
 */
function seedFlowPreset(dshHome) {
  const standardManifest = join(
    APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml',
  );
  if (!existsSync(standardManifest)) {
    console.warn('[dsh-gui] standard preset manifest missing; flow preset not seeded');
    return;
  }
  const presetDir = join(dshHome, '.agent-presets', 'flow');
  try {
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(
      join(presetDir, 'preset.yml'),
      'name: 心流模式\n' +
        'description: 边跑边聊 —— 运行中排队的消息由轻量裁判模型分诊，相关的即时并入上下文，独立请求留作新轮次\n' +
        'order: 50\n',
    );
    writeFileSync(
      join(presetDir, 'agent.cordis.yml'),
      readFileSync(standardManifest, 'utf8') +
        '\n# ── dsh-gui flow mode: pre-step triage of queued user messages ──────────\n' +
        '- id: flow-triage\n' +
        "  name: 'dsh-gui-flow'\n",
    );
  } catch (err) {
    console.warn('[dsh-gui] could not seed flow preset:', err.message);
  }
}

/**
 * Make the dsh-gui-bridge package resolvable by the engine's loader.
 * The engine symlinks only dsh's own dependency closure into
 * <dsh-home>/profiles/node_modules; our bridge is an app-level package, so we
 * link it there ourselves — same mechanism, idempotent, survives updates.
 */
function linkBridgeModules(dshHome) {
  const modulesDir = join(dshHome, 'profiles', 'node_modules');
  for (const pkg of ['dsh-gui-bridge', 'dsh-gui-browser', 'dsh-gui-market', 'dsh-gui-flow', 'dsh-gui-import', 'dsh-gui-shell']) {
    const linkPath = join(modulesDir, pkg);
    const target = join(APP_ROOT, 'node_modules', pkg);
    if (!existsSync(target) || existsSync(linkPath)) continue;
    mkdirSync(modulesDir, { recursive: true });
    try {
      symlinkSync(target, linkPath, 'dir');
      console.log(`[dsh-gui] linked ${pkg} into profile node_modules`);
    } catch (err) {
      console.warn(`[dsh-gui] could not link ${pkg}:`, err.message);
    }
  }
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Start `dsh web` and resolve the served URL from its stdout. */
function startDshServer(dshHome, onUrl, onFail) {
  // Launcher flags (--patch) must come before the web app's own flags (--port).
  // --expose-internals: the DSH loader needs access to Node's internal ESM
  // loader (HMR service) and can't use its native fallback under Electron's
  // Node 24, so hand it the flag directly.
  const args = ['--expose-internals', DSH_BIN, 'web'];
  if (existsSync(PATCH_FILE)) args.push('--patch', PATCH_FILE);
  args.push('--port', '0');

  // Chromium is fetched on demand into the user data directory (see
  // src/chromium.js); a build that still bundles it keeps priority. Point the
  // engine at whichever applies so the browser plugin finds it either way.
  const browsersPath = resolveBrowsersPath(app);

  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
      ...(existsSync(browsersPath) ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString();
    bootLog.push(chunk.toString());
    const m = stripAnsi(out).match(/dsh web:\s*(https?:\/\/[^\s]+)/);
    if (m) {
      out = '';
      onUrl(m[1]);
    }
  });
  child.stderr.on('data', (chunk) => bootLog.push(chunk.toString()));

  child.on('error', (err) => onFail(`failed to start the DSH engine: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && !app.isQuitting) {
      onFail(
        `the DSH engine exited unexpectedly (code ${code}, signal ${signal}).\n\n` +
          `Log tail:\n${bootLog.slice(-30).join('')}`,
      );
    }
  });

  return child;
}

// ── phone link ─────────────────────────────────────────────────────────────

/**
 * The engine call the gateway is given. It is a function of the *method name*,
 * never of anything the phone sends: the gateway resolves an allowed operation
 * to an engine method itself, so no string from the network is ever used to
 * build this URL.
 */
function engineRpc() {
  return async (method, payload) => {
    if (!engineUrl) throw new Error('engine not ready');
    const res = await fetch(`${engineUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `phone-${Date.now()}`, method, payload }),
    });
    const body = await res.json();
    if (!body?.result?.ok) throw new Error(body?.result?.error?.message ?? `${method} failed`);
    return body.result.value;
  };
}

function setupPairing() {
  pairing = createPairing({
    userDataDir: app.getPath('userData'),
    engineCaller: engineRpc,
    // The secret must never reach a log file, so nothing here interpolates it —
    // mobile-link only ever logs states, not frames.
    log: (...args) => console.log('[dsh-gui]', ...args),
  });
  pairing.on((status) => {
    if (pairingWin && !pairingWin.isDestroyed()) pairingWin.webContents.send('pairing:status', status);
  });

  ipcMain.handle('pairing:status', () => pairing.status());
  ipcMain.handle('pairing:enable', () => { pairing.enable(); return pairing.status(); });
  ipcMain.handle('pairing:disable', () => { pairing.disable(); return pairing.status(); });
  ipcMain.handle('pairing:rotate', () => { pairing.rotate(); return pairing.status(); });
  ipcMain.handle('pairing:set-relay', (_e, url) => { pairing.setRelay(url); return pairing.status(); });
  ipcMain.handle('pairing:reveal', async () => {
    const payload = pairing.payload();
    if (!payload) return { payload: null, qr: null };
    // Rendered here rather than in the page: the page has no network access and
    // no library, and this keeps the encoder out of a renderer entirely.
    const qr = await QRCode.toDataURL(payload, { margin: 0, width: 512, errorCorrectionLevel: 'M' });
    return { payload, qr };
  });
  ipcMain.handle('pairing:copy', () => {
    const payload = pairing.payload();
    if (payload) clipboard.writeText(payload);
    return Boolean(payload);
  });
}

function openPairingWindow() {
  if (pairingWin && !pairingWin.isDestroyed()) {
    pairingWin.focus();
    return;
  }
  pairingWin = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    title: '手机连接',
    backgroundColor: '#151517',
    parent: win ?? undefined,
    webPreferences: {
      preload: join(__dirname, 'pairing', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pairingWin.loadFile(join(__dirname, 'pairing', 'pairing.html'));
  // A window that only learns the theme on the *next* switch opens wearing the
  // fallback palette, which is a different look from the rest of the app.
  pairingWin.webContents.on('did-finish-load', () => {
    const themes = loadThemes(userThemeDir());
    const theme = themes.find((t) => t.id === currentThemeId()) ?? themes[0];
    if (!theme || !pairingWin || pairingWin.isDestroyed()) return;
    pairingWin.webContents.send('panel:theme', { css: panelCss(theme), id: theme.id });
  });
  pairingWin.on('closed', () => { pairingWin = null; });
}

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Open DSH Home…',
          click: () => shell.openPath(resolveDshHome()),
        },
        { type: 'separator' },
        {
          label: '检查更新…',
          click: () => checkForUpdates(true),
        },
        { type: 'separator' },
        {
          label: '切换右侧面板',
          accelerator: 'CmdOrCtrl+B',
          click: () => togglePanel(),
        },
        {
          label: '手机连接…',
          click: () => openPairingWindow(),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#151517',
    title: APP_NAME,
    show: false,
  });

  mainView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(mainView);

  readPanelPref();
  wirePanelIpc();
  createPanelView();
  layoutViews();

  win.on('resize', layoutViews);
  win.on('resized', layoutViews);
  win.once('ready-to-show', () => win.show());
  win.show();

  mainView.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(APP_NAME);
  });
  mainView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainView.webContents.on('will-navigate', (event, url) => {
    let origin = 'null';
    try {
      origin = new URL(mainView.webContents.getURL()).origin;
    } catch {
      /* splash page — nothing to compare against */
    }
    if (origin !== 'null' && !url.startsWith(origin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Splash while the engine boots.
  mainView.webContents.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<!doctype html><html><body style="margin:0;background:#151517;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#8b93a7">
        <div style="text-align:center"><div style="font-size:34px;font-weight:700;color:#e8ecf4">Dsh GUI</div>
        <div style="margin-top:10px;font-size:14px">Starting the DeepSeek Harness engine…</div></div></body></html>`,
      ),
  );

  mainView.webContents.on('did-finish-load', async () => {
    await applyTheme(currentThemeId());
    // The splash (data: URL) also fires did-finish-load — the probe must only
    // run once the real engine page is up, or its typed input hits a dropped
    // engineUrl and the terminal read comes back empty.
    // A smoke run starts from an empty DSH home, where the app sits on the
    // "choose a workspace" screen: no workspace root for the file tree, and a
    // read-only composer. That is not the state a user is in, so give the run
    // the same starting point they have — one workspace, one session — and
    // reload, since the page decides what to open at load time. The flag keeps
    // that reload from re-entering this handler forever.
    if (SMOKE && !smokeSeeded && mainView.webContents.getURL().startsWith('http')) {
      smokeSeeded = true;
      try {
        const rpc = async (method, payload) => {
          const res = await fetch(`${engineUrl}/api/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: `smoke-${method}`, method, payload }),
          });
          const body = await res.json();
          if (!body?.result?.ok) throw new Error(`${method}: ${JSON.stringify(body?.result?.error ?? body)}`);
          return body.result.value;
        };
        const { workspace } = await rpc('workspace.create', { path: APP_ROOT });
        await rpc('session.create', { workspaceId: workspace.workspaceId });
        smokeSeed = 'ok';
      } catch (err) {
        smokeSeed = `see:${err.message}`;
      }
      mainView.webContents.reload();
      return;
    }

    if (SMOKE && mainView.webContents.getURL().startsWith('http')) {
      // End-to-end probe: open the panel's terminal tab, type a command
      // through the real IPC/PTY path, and read the buffer back to prove the
      // whole terminal chain works.
      const probe = async () => {
        const finish = (result) => {
          console.log(JSON.stringify(result));
          if (dshChild) dshChild.kill('SIGTERM');
          app.exit(0);
        };

        try {
          if (!panelView || panelView.webContents.isDestroyed()) {
            finish({ smoke: 'ok', url: mainView.webContents.getURL(), title: win.getTitle(), panel: 'missing' });
            return;
          }
          await panelView.webContents.executeJavaScript(`__panelProbe.open('terminal')`);
          setTimeout(() => {
            const readTerm = () => panelView.webContents.executeJavaScript(`__panelProbe.agentTermText()`);
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            // On a slow runner (GitHub's macOS shell is bash 3.2, slower to
            // read its init files than local zsh), keystrokes sent before the
            // shell is ready are lost. So: wait for a prompt, THEN type, THEN
            // poll for the echo — resending if it doesn't land.
            const awaitEcho = async () => {
              for (let i = 0; i < 30; i++) {
                if (/[$%#]\s*$/.test(String(await readTerm()))) break;
                await sleep(200);
              }
              for (let attempt = 0; attempt < 5; attempt++) {
                ipcMain.emit('panel:pty-input', null, 'agent', 'echo PANEL_PTY_OK\r');
                for (let i = 0; i < 15; i++) {
                  const t = await readTerm();
                  if (String(t).includes('PANEL_PTY_OK')) return t;
                  await sleep(200);
                }
              }
              return readTerm();
            };
            setTimeout(async () => {
              try {
                const text = await awaitEcho();
                // open the browser tab and verify the shot IPC loop
                await panelView.webContents.executeJavaScript(`__panelProbe.open('web')`);
                await new Promise((r) => setTimeout(r, 2200));
                const browserState = await panelView.webContents.executeJavaScript(
                  `__panelProbe.browserState()`,
                );
                // backflow probe: click the reference button on the first tree
                // row and check the engine's own composer received it. The
                // send button is the honest signal — text can be present in
                // the DOM while the engine still believes the box is empty,
                // which is exactly the failure mode this path has to avoid.
                await panelView.webContents.executeJavaScript(`__panelProbe.open('tree')`);
                // Wait for the listing rather than guessing how long it takes:
                // a fixed delay passes on this machine and fails on a slower
                // runner, which is worse than failing outright because it makes
                // the probe flaky instead of informative.
                for (let i = 0; i < 40; i++) {
                  const rows = await panelView.webContents.executeJavaScript(
                    `__panelProbe.treeRowCount()`,
                  );
                  if (rows > 0) break;
                  await new Promise((r) => setTimeout(r, 250));
                }
                // Which controls are disabled right now. The engine enables its
                // send control once it believes the composer is non-empty, so
                // the transition is the proof that the text was accepted —
                // identified by that state change rather than by a label, which
                // is localized (the CI runner speaks English, this machine does
                // not) or by a class name, which is content hashed.
                const disabledMap = `(() => [...document.querySelectorAll('button')].map((b) => b.disabled))()`;
                const before = await mainView.webContents.executeJavaScript(disabledMap, true);
                const ref = await panelView.webContents.executeJavaScript(
                  `__panelProbe.treeRefFirst()`,
                );
                const readComposer = `(() => {
                  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
                  const ta = [...document.querySelectorAll('textarea')].filter(vis)
                    .sort((a, b) => {
                      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                      return rb.width * rb.height - ra.width * ra.height;
                    })[0];
                  return { value: ta ? ta.value : null, readOnly: ta ? ta.readOnly : null };
                })()`;
                // Poll for the text instead of assuming a round trip and a
                // React render fit in a fixed delay.
                let composer = null;
                for (let i = 0; i < 20; i++) {
                  composer = await mainView.webContents.executeJavaScript(readComposer, true);
                  if (ref.clicked && composer.value && composer.value.includes(ref.path)) break;
                  await new Promise((r) => setTimeout(r, 250));
                }
                const refResult = await panelView.webContents.executeJavaScript(
                  `__panelProbe.lastRef()`,
                );
                const after = await mainView.webContents.executeJavaScript(disabledMap, true);
                // Some control must have gone from disabled to enabled. Compare
                // position-wise when the button set is unchanged; otherwise fall
                // back to "fewer are disabled than before".
                const countDisabled = (list) => list.filter(Boolean).length;
                const enabledSomething =
                  before.length === after.length
                    ? before.some((wasDisabled, i) => wasDisabled && !after[i])
                    : countDisabled(after) < countDisabled(before);

                // Right-click a path and copy it: asserted through the real
                // clipboard, since "the menu item ran" says nothing about
                // whether anything reached it.
                // The clipboard belongs to whoever is using this machine; the
                // probe borrows it and puts back what it found.
                const clipboardBefore = clipboard.readText();
                clipboard.writeText('SMOKE_CLIPBOARD_UNSET');
                const ctx = await panelView.webContents.executeJavaScript(
                  `__panelProbe.contextMenuOn('复制路径')`,
                );
                await new Promise((r) => setTimeout(r, 300));
                const clipped = clipboard.readText();
                clipboard.writeText(clipboardBefore);
                const contextMenuProbe = !ctx.ran
                  ? `see:${ctx.reason}${ctx.entries ? ` entries=${JSON.stringify(ctx.entries)}` : ''}`
                  : clipped === ctx.path
                    ? 'ok'
                    : `see:${JSON.stringify({ wanted: ctx.path, clipboard: clipped })}`;

                // The other half of the backflow: select text in the panel and
                // click the quote button that appears over it.
                const quote = await panelView.webContents.executeJavaScript(
                  `__panelProbe.quoteFirstSelection()`,
                );
                let quoted = null;
                for (let i = 0; i < 20; i++) {
                  quoted = await mainView.webContents.executeJavaScript(readComposer, true);
                  if (quoted.value && quoted.value.includes('```')) break;
                  await new Promise((r) => setTimeout(r, 250));
                }
                const quoteProbe = !quote.quoted
                  ? `see:${quote.reason} ${JSON.stringify(quote.diag ?? {})}`
                  : quoted.value && quoted.value.includes('```') && quoted.value.includes(quote.text)
                    ? 'ok'
                    : `see:${JSON.stringify({ quote, value: quoted && quoted.value })}`;

                // A pass means the engine agrees the text is there: the value
                // carries the referenced path AND a control left its disabled
                // state. Value alone is not enough — that is exactly what a
                // plain .value assignment produces while the engine still
                // treats the composer as empty.
                const backflowProbe = !ref.clicked
                  ? `see:${ref.reason} (seed:${smokeSeed})`
                  : composer.value && composer.value.includes(ref.path) && enabledSomething
                    ? 'ok'
                    : `see:${JSON.stringify({ ref, refResult, composer, before, after, seed: smokeSeed })}`;

                // A theme must actually reach the engine's page. Read the token
                // it sets before and after switching: the panel updating its
                // own colours would prove nothing about the main view.
                const readToken = `(() => {
                  const mine = [];
                  for (const sheet of document.styleSheets) {
                    let rules; try { rules = sheet.cssRules; } catch { continue; }
                    for (const r of rules) {
                      if (r.style && r.style.getPropertyValue('--dsw-alias-bg-base') && !sheet.href) {
                        mine.push(r.selectorText + ' => ' + r.style.getPropertyValue('--dsw-alias-bg-base').trim());
                      }
                    }
                  }
                  const cs = getComputedStyle(document.body);
                  return JSON.stringify({
                    computed: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
                    marker: cs.getPropertyValue('--dsh-gui-theme').trim(),
                    dark: document.body.hasAttribute('data-ds-dark-theme'),
                  });
                })()`;
                const themeBefore = await mainView.webContents.executeJavaScript(readToken, true);
                const switched = await applyTheme('dracula');
                await new Promise((r) => setTimeout(r, 400));
                const themeAfter = await mainView.webContents.executeJavaScript(readToken, true);
                await applyTheme(themeBefore ? 'midnight' : 'midnight');
                const parseTheme = (raw) => {
                  try { return JSON.parse(raw); } catch { return {}; }
                };
                const themeWas = parseTheme(themeBefore);
                const themeNow = parseTheme(themeAfter);
                // A pass means the engine's own token changed to the new
                // palette's colour — not merely that our sheet was applied,
                // which was true even while the engine kept winning.
                const themeProbe = !switched.ok
                  ? `see:${switched.reason}`
                  : themeNow.computed && themeNow.computed.toLowerCase() === '#282a36' && themeWas.computed !== themeNow.computed
                    ? 'ok'
                    : `see:${JSON.stringify({ themeWas, themeNow })}`;

                // Our own UI must actually render inside the engine's page.
                // Loading the plugin proves nothing: a registration into a slot
                // whose host is not mounted succeeds and shows nothing.
                const shellProbe = await mainView.webContents.executeJavaScript(
                  `document.querySelectorAll('.dshgui-shell-status').length > 0 ? 'ok' : 'see:not rendered'`,
                  true,
                );

                // Popping the panel out must not lose the terminal history —
                // the shared output cursor has already moved past it, so the
                // new window only sees it if it is replayed.
                popOutPanel();
                let popupTerm = '';
                for (let i = 0; i < 30; i++) {
                  await new Promise((r) => setTimeout(r, 250));
                  if (!popupWin || popupWin.isDestroyed()) continue;
                  popupTerm = String(
                    await popupWin.webContents.executeJavaScript(`__panelProbe.agentTermText()`),
                  );
                  if (popupTerm.includes('PANEL_PTY_OK')) break;
                }
                const replayProbe = popupTerm.includes('PANEL_PTY_OK')
                  ? 'ok'
                  : `see:${popupTerm.slice(0, 120) || '(empty)'}`;
                if (popupWin && !popupWin.isDestroyed()) popupWin.destroy();

                // layout probe: the panel must take space from the window,
                // never overlay the main view (Codex-style reallocation)
                const winW = win.getContentBounds().width;
                const shown = { main: mainView.getBounds().width, panel: panelView.getBounds().width, win: winW };
                togglePanel();
                const hidden = { main: mainView.getBounds().width, panel: panelView.getBounds().width, win: win.getContentBounds().width };
                togglePanel();
                const layoutOk =
                  shown.main === winW - PANEL_WIDTH &&
                  shown.panel === PANEL_WIDTH &&
                  hidden.main === win.getContentBounds().width &&
                  hidden.panel === 0;

                // ── the phone link, end to end on this machine ────────────
                // Three things can only break here and nowhere else: the link
                // uses the global WebSocket, which has to exist in Electron's
                // main process; the QR encoder has to survive packaging; and
                // the pairing window has its own preload, so its IPC is not
                // covered by any other probe. The relay is pointed at the
                // discard port — the link is exercised without the run
                // depending on a network service.
                let pairingProbe = 'skipped';
                try {
                  const hasWebSocket = typeof WebSocket === 'function';
                  pairing.setRelay('ws://127.0.0.1:9');
                  const offAtStart = pairing.status().enabled === false;
                  openPairingWindow();
                  await new Promise((r) => pairingWin.webContents.once('did-finish-load', r));
                  await pairingWin.webContents.executeJavaScript(
                    `(async () => { await window.dshPairing.enable(); })()`,
                  );
                  const revealed = await pairingWin.webContents.executeJavaScript(
                    `(async () => {
                       const r = await window.dshPairing.reveal();
                       document.getElementById('qr').src = r.qr;
                       return {
                         qr: String(r.qr || '').slice(0, 22),
                         inDom: (document.getElementById('qr').src || '').slice(0, 22),
                         // The payload carries the secret; only its shape is reported.
                         payloadOk: /^dsh-gui:\\/\\/pair\\?/.test(r.payload || ''),
                         state: document.getElementById('state').textContent,
                         // This window is skinned by a sheet main pushes it. It
                         // once carried its own copy of the palette instead and
                         // sat out every theme switch, so check the sheet
                         // actually arrived — the wiring existed before and
                         // nothing fed it.
                         themed: Array.from(document.head.querySelectorAll('style'))
                           .some((s) => s.textContent.includes('--bg-hover')
                                     && s.textContent.includes('--shadow-hard')),
                       };
                     })()`,
                  );
                  await pairingWin.webContents.executeJavaScript(
                    `(async () => { await window.dshPairing.disable(); })()`,
                  );
                  const offAtEnd = pairing.status().enabled === false;
                  const ok =
                    hasWebSocket && offAtStart && offAtEnd &&
                    revealed.payloadOk &&
                    revealed.themed &&
                    revealed.qr.startsWith('data:image/png;base64') &&
                    revealed.inDom.startsWith('data:image/png;base64');
                  pairingProbe = ok
                    ? 'ok'
                    : `see:${JSON.stringify({ hasWebSocket, offAtStart, offAtEnd, ...revealed })}`;
                  if (pairingWin && !pairingWin.isDestroyed()) pairingWin.close();
                } catch (err) {
                  pairingProbe = `see:${err.message}`;
                }

                finish({
                  smoke: 'ok',
                  url: mainView.webContents.getURL(),
                  title: win.getTitle(),
                  panel: 'ok',
                  ptyProbe: String(text).includes('PANEL_PTY_OK') ? 'ok' : `see:${String(text).slice(0, 120)}`,
                  browserProbe: browserState.emptyVisible === true ? 'ok(not-launched)' : `see:${JSON.stringify(browserState)}`,
                  backflowProbe,
                  quoteProbe,
                  contextMenuProbe,
                  themeProbe,
                  shellProbe,
                  replayProbe,
                  layoutProbe: layoutOk ? 'ok' : `see:${JSON.stringify({ shown, hidden })}`,
                  pairingProbe,
                });
              } catch (err) {
                finish({ smoke: 'ok', ptyProbe: `error:${err.message}` });
              }
            }, 3000);
          }, 1500);
        } catch (err) {
          finish({ smoke: 'ok', ptyProbe: `error:${err.message}` });
        }
      };
      probe();
    }
  });

  win.on('closed', () => {
    win = null;
    mainView = null;
  });
}

function fail(message) {
  console.error('[dsh-gui]', message);
  if (dshChild) dshChild.kill('SIGTERM');
  if (SMOKE) {
    console.log(JSON.stringify({ smoke: 'failed', error: message, logTail: bootLog.slice(-20).join('') }));
    app.exit(1);
    return;
  }
  dialog.showErrorBox(APP_NAME, message);
  app.quit();
}

// ── lifecycle ─────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    setupAutoUpdater();
    // Registers the IPC and reads the persisted state; it does not dial. The
    // link only opens once the engine can actually answer — see below.
    setupPairing();

    // Silent background update check on startup (packaged builds only;
    // skipped in smoke mode so tests never hit the network).
    if (app.isPackaged && !SMOKE) {
      setTimeout(() => checkForUpdates(false), 8000);
    }

    const dshHome = resolveDshHome();
    seedSettings(dshHome);
    seedFlowPreset(dshHome);
    linkBridgeModules(dshHome);
    console.log(`[dsh-gui] DSH_HOME=${dshHome}`);

    let bootTimer = setTimeout(() => {
      fail(`the DSH engine did not report a URL within ${BOOT_TIMEOUT_MS / 1000}s.` +
        `\n\nLog tail:\n${bootLog.slice(-30).join('')}`);
    }, BOOT_TIMEOUT_MS);

    dshChild = startDshServer(
      dshHome,
      (url) => {
        clearTimeout(bootTimer);
        engineUrl = url;
        if (!stateTimer) {
          stateTimer = setInterval(pollBridgeState, 1200);
          termTimer = setInterval(pollTerminalOut, 150);
          shotTimer = setInterval(pollBrowserShot, 900);
        }
        console.log(`[dsh-gui] engine ready at ${url}`);
        // Dial only now. Connecting earlier would put a phone in front of an
        // engine that cannot answer, which reads as "the app is broken" rather
        // than "it is still starting". A smoke run never opens the link: it
        // must not depend on a network service to pass.
        if (pairing && !SMOKE) pairing.resume();
        if (mainView && !mainView.webContents.isDestroyed()) mainView.webContents.loadURL(url);
      },
      (message) => {
        clearTimeout(bootTimer);
        fail(message);
      },
    );
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (stateTimer) {
      clearInterval(stateTimer);
      clearInterval(termTimer);
      clearInterval(shotTimer);
      stateTimer = null;
      termTimer = null;
      shotTimer = null;
    }
    if (pairing) pairing.stop();
    if (dshChild) {
      dshChild.kill('SIGTERM');
      dshChild = null;
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (win === null && app.isReady()) createWindow();
  });
}
