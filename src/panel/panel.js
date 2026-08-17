'use strict';

/* Dsh GUI right panel — Codex-style browser tabs over the panes.
   Tab types: terminal (multi, 'agent' first), web/files (singleton),
   sidechat (multi, ephemeral). */

const tabstrip = document.getElementById('tabstrip');
const panesHost = document.getElementById('panes');
const newTabBtn = document.getElementById('new-tab-btn');
const newTabMenu = document.getElementById('newtab-menu');

const TAB_META = {
  terminal: { icon: '❯_', label: '终端', multi: true },
  tree: { icon: '⌸', label: '文件树', multi: false },
  web: { icon: '◐', label: '浏览器', multi: false },
  files: { icon: '±', label: '改动', multi: false },
  sidechat: { icon: '💬', label: '侧边聊天', multi: true },
};

const tabs = []; // {tabId, type, title, pane}
let activeTabId = null;
let tabSeq = 0;
let localPtySeq = 0;
let chatSeq = 0;
let latestState = null;

function tabById(tabId) {
  return tabs.find((t) => t.tabId === tabId);
}

function countType(type) {
  return tabs.filter((t) => t.type === type).length;
}

function makePane(type) {
  if (type === 'terminal') {
    const ptyId = countType('terminal') === 0 ? 'agent' : `local-${++localPtySeq}`;
    return window.dshPanes.createTerminalPane(ptyId);
  }
  if (type === 'files') return window.dshPanes.createFilesPane();
  if (type === 'tree') return window.dshPanes.createTreePane();
  if (type === 'web') return window.dshPanes.createWebPane();
  return window.dshPanes.createSidechatPane(`chat-${++chatSeq}`);
}

function syncTerminals() {
  const ids = tabs.filter((t) => t.type === 'terminal').map((t) => t.pane.ptyId);
  window.dshPanel.openTerminals(ids);
}

function openTab(type, activate = true) {
  const meta = TAB_META[type];
  if (!meta.multi) {
    const existing = tabs.find((t) => t.type === type);
    if (existing) {
      if (activate) activateTab(existing.tabId);
      return existing;
    }
  }
  const pane = makePane(type);
  const n = countType(type);
  const tab = {
    tabId: `tab-${++tabSeq}`,
    type,
    title: n === 0 ? meta.label : `${meta.label} ${n + 1}`,
    pane,
  };
  tabs.push(tab);
  pane.el.classList.remove('active');
  panesHost.appendChild(pane.el);
  if (latestState && pane.renderState) pane.renderState(latestState.activities, latestState.home);
  if (type === 'terminal') syncTerminals();
  renderTabs();
  if (activate) activateTab(tab.tabId);
  return tab;
}

function closeTab(tabId) {
  const idx = tabs.findIndex((t) => t.tabId === tabId);
  if (idx < 0) return;
  const [tab] = tabs.splice(idx, 1);
  if (tab.type === 'terminal' && tab.pane.ptyId !== 'agent') {
    window.dshPanel.ptyClose(tab.pane.ptyId);
  }
  tab.pane.el.remove();
  tab.pane.dispose();
  if (tab.type === 'terminal') syncTerminals();
  if (activeTabId === tab.tabId) {
    const next = tabs[idx] ?? tabs[idx - 1];
    activeTabId = null;
    if (next) activateTab(next.tabId);
    else {
      renderTabs();
      window.dshPanel.tabChanged('none');
    }
  } else {
    renderTabs();
  }
}

function activateTab(tabId) {
  const tab = tabById(tabId);
  if (!tab) return;
  activeTabId = tabId;
  for (const t of tabs) t.pane.el.classList.toggle('active', t.tabId === tabId);
  renderTabs();
  window.dshPanel.tabChanged(tab.type);
  tab.pane.onShow();
}

function renderTabs() {
  tabstrip.replaceChildren();
  for (const tab of tabs) {
    const chip = document.createElement('button');
    chip.className = `tab${tab.tabId === activeTabId ? ' active' : ''}`;
    chip.setAttribute('role', 'tab');
    chip.title = tab.title;

    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.textContent = TAB_META[tab.type].icon;
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tab.title;
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭标签页';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.tabId);
    });

    chip.append(icon, label, close);
    chip.addEventListener('click', () => activateTab(tab.tabId));
    tabstrip.appendChild(chip);
  }
}

// ── new-tab menu ──────────────────────────────────────────────────────────
function hideMenu() {
  newTabMenu.hidden = true;
}

newTabBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!newTabMenu.hidden) return hideMenu();
  const rect = newTabBtn.getBoundingClientRect();
  newTabMenu.style.left = `${Math.min(rect.left, window.innerWidth - 190)}px`;
  newTabMenu.style.top = `${rect.bottom + 6}px`;
  newTabMenu.hidden = false;
});

document.addEventListener('click', hideMenu);
for (const item of newTabMenu.querySelectorAll('.menu-item')) {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    hideMenu();
    openTab(item.dataset.type);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  const key = e.key.toLowerCase();
  if (key === 't' && !e.altKey) {
    e.preventDefault();
    openTab('terminal');
  } else if (key === 'p' && !e.altKey) {
    e.preventDefault();
    openTab('files');
  } else if (key === 'e' && !e.altKey) {
    e.preventDefault();
    openTab('tree');
  } else if (key === 's' && e.altKey) {
    e.preventDefault();
    openTab('sidechat');
  }
});

// ── window controls ───────────────────────────────────────────────────────
document.getElementById('collapse-btn').addEventListener('click', () => {
  window.dshPanel.collapsePanel();
});
document.getElementById('popout-btn').addEventListener('click', () => {
  window.dshPanel.popOut();
});

// ── event routing ─────────────────────────────────────────────────────────
window.dshPanel.onPtyData((ptyId, data) => {
  for (const tab of tabs) {
    if (tab.type === 'terminal' && tab.pane.ptyId === ptyId) tab.pane.write(data);
  }
});

let lastStateKey = '';
window.dshPanel.onState((s) => {
  latestState = s;
  const cwdText =
    s.cwd && s.home && s.cwd.startsWith(s.home) ? `~${s.cwd.slice(s.home.length)}` : s.cwd ?? '';
  for (const tab of tabs) {
    if (tab.type === 'terminal' && tab.pane.ptyId === 'agent') tab.pane.setCwd(cwdText);
  }
  const acts = s.activities ?? [];
  const last = acts[acts.length - 1];
  const key = `${acts.length}:${last ? last.at : 0}:${JSON.stringify(s).length}`;
  if (key === lastStateKey) return;
  lastStateKey = key;
  for (const tab of tabs) {
    if (tab.pane.renderState) tab.pane.renderState(acts, s.home ?? '');
  }
});

window.dshPanel.onBrowserShot((shot) => {
  for (const tab of tabs) {
    if (tab.type === 'web') tab.pane.renderShot(shot);
  }
});

window.dshPanel.onSidechatChunk((chatId, text, done, error) => {
  for (const tab of tabs) {
    if (tab.type === 'sidechat' && tab.pane.chatId === chatId) tab.pane.onChunk(text, done, error);
  }
});

window.addEventListener('resize', () => {
  const tab = tabById(activeTabId);
  if (tab) tab.pane.onResize();
});

// ── boot + smoke probe surface ────────────────────────────────────────────
openTab('terminal');

window.__panelProbe = {
  open(type) {
    // Multi-instance types (terminal) must not spawn a second tab here —
    // the probe wants the boot tab (the shared agent terminal) re-shown.
    const existing = tabs.find((t) => t.type === type);
    if (existing) activateTab(existing.tabId);
    else openTab(type);
  },
  tabCount() { return tabs.length; },
  agentTermText() {
    const tab = tabs.find((t) => t.type === 'terminal' && t.pane.ptyId === 'agent');
    if (!tab) return 'NO_TERM';
    try {
      const b = tab.pane.term.buffer.active;
      const lines = [];
      for (let i = 0; i < Math.min(b.length, 60); i++) lines.push(b.getLine(i).translateToString(true));
      return lines.join('\n');
    } catch (e) {
      return 'ERR:' + e.message;
    }
  },
  browserState() {
    const empty = document.getElementById('browser-empty');
    const bar = document.getElementById('browser-bar');
    return {
      emptyVisible: empty !== null && empty.style.display !== 'none',
      bar: bar === null ? '' : bar.textContent,
    };
  },
};
