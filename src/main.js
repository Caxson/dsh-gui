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

const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } = require('node:fs');
const { autoUpdater } = require('electron-updater');

const APP_NAME = 'Dsh GUI';
const APP_ROOT = join(__dirname, '..');
const DSH_BIN = join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const PATCH_FILE = join(APP_ROOT, 'plugins', 'desktop.patch.yml');
const SKIN_CSS = join(APP_ROOT, 'src', 'codex-skin.css');

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
// Canonical channel: GitHub Releases (electron-builder embeds the feed into
// app-update.yml at build time; no runtime config needed). Mainland-China
// users can point DSH_GUI_UPDATE_URL at a generic static mirror (Aliyun OSS)
// hosting the same dmg/zip/latest-mac.yml artifacts.
const UPDATE_URL_OVERRIDE = (process.env.DSH_GUI_UPDATE_URL || '').trim();
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
  if (SMOKE) {
    panelView.webContents.on('did-finish-load', () => {
      console.log(JSON.stringify({ panel: 'ok' }));
    });
  }
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
  for (const pkg of ['dsh-gui-bridge', 'dsh-gui-browser', 'dsh-gui-market', 'dsh-gui-flow', 'dsh-gui-import']) {
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

  // Bundled Chromium for the browser plugin lives at resources/browsers in
  // packaged builds; in dev Playwright uses its own download cache.
  const browsersPath = join(process.resourcesPath, 'browsers');

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
    if (existsSync(SKIN_CSS)) {
      try {
        await mainView.webContents.insertCSS(readFileSync(SKIN_CSS, 'utf8'));
      } catch (err) {
        console.warn('[dsh-gui] skin injection failed:', err.message);
      }
    }
    // The splash (data: URL) also fires did-finish-load — the probe must only
    // run once the real engine page is up, or its typed input hits a dropped
    // engineUrl and the terminal read comes back empty.
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
            ipcMain.emit('panel:pty-input', null, 'agent', 'echo PANEL_PTY_OK\r');
            // Poll the terminal buffer until the echo lands (CI runners are
            // slower than a fixed wait) — up to ~8s, then read whatever's there.
            const readTerm = () => panelView.webContents.executeJavaScript(`__panelProbe.agentTermText()`);
            const awaitEcho = async () => {
              for (let i = 0; i < 40; i++) {
                const t = await readTerm();
                if (String(t).includes('PANEL_PTY_OK')) return t;
                await new Promise((r) => setTimeout(r, 200));
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
                finish({
                  smoke: 'ok',
                  url: mainView.webContents.getURL(),
                  title: win.getTitle(),
                  panel: 'ok',
                  ptyProbe: String(text).includes('PANEL_PTY_OK') ? 'ok' : `see:${String(text).slice(0, 120)}`,
                  browserProbe: browserState.emptyVisible === true ? 'ok(not-launched)' : `see:${JSON.stringify(browserState)}`,
                  layoutProbe: layoutOk ? 'ok' : `see:${JSON.stringify({ shown, hidden })}`,
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
