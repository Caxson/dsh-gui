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
  // Floating things belong to what was on screen a moment ago, not to what is
  // on screen now.
  dismissFloating();
}

/**
 * Anything that floats over the panel registers a way to dismiss itself, so
 * this works no matter where those widgets are created relative to here. A
 * `typeof` guard would not do: these are `const`, and `typeof` on a binding in
 * its temporal dead zone throws rather than returning "undefined".
 */
const floatingDismissers = [];
function dismissFloating() {
  for (const dismiss of floatingDismissers) dismiss();
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

    // Filled in by updateBadges(), which runs on every state update — the tab
    // strip itself is not re-rendered then, so hover and scroll position
    // survive.
    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    badge.hidden = true;

    chip.dataset.tabId = String(tab.tabId);
    chip.append(icon, label, badge, close);
    chip.addEventListener('click', () => activateTab(tab.tabId));
    tabstrip.appendChild(chip);
  }
  updateBadges();
}

/** Show how much a pane is holding, so it can be noticed without switching. */
function updateBadges() {
  for (const tab of tabs) {
    const chip = tabstrip.querySelector(`[data-tab-id="${tab.tabId}"]`);
    const badge = chip && chip.querySelector('.tab-badge');
    if (!badge) continue;
    const count = typeof tab.pane.count === 'number' ? tab.pane.count : 0;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count <= 0;
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
    // Panes that track the workspace itself (the file tree) need every state,
    // not just the ones that changed the activity list below.
    if (tab.pane.onState) tab.pane.onState(s);
  }
  const acts = s.activities ?? [];
  const last = acts[acts.length - 1];
  const key = `${acts.length}:${last ? last.at : 0}:${JSON.stringify(s).length}`;
  if (key === lastStateKey) return;
  lastStateKey = key;
  for (const tab of tabs) {
    if (tab.pane.renderState) tab.pane.renderState(acts, s.home ?? '');
  }
  updateBadges();
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

// ── themes ────────────────────────────────────────────────────────────────
// Main derives everything from a palette and pushes it here: a stylesheet for
// this document and a colour set for xterm. Applied live — no reload.
const themeStyle = document.createElement('style');
document.head.appendChild(themeStyle);

window.dshPanel.onTheme((payload) => {
  if (!payload) return;
  themeStyle.textContent = payload.css || '';
  if (payload.terminal) window.dshPanes.applyTerminalTheme(payload.terminal);
});

const themeBtn = document.getElementById('theme-btn');
const themeMenu = document.createElement('div');
themeMenu.className = 'menu theme-menu';
themeMenu.hidden = true;
document.body.appendChild(themeMenu);
floatingDismissers.push(() => { themeMenu.hidden = true; });

async function openThemeMenu() {
  const { themes, current, dir, following, house } = await window.dshPanel.themes();
  themeMenu.replaceChildren();

  // First entry, because it is the default and because someone who has wandered
  // off into the ported schemes needs a way back to "just match my machine".
  if (house) {
    const follow = document.createElement('button');
    follow.className = 'menu-item theme-item' + (following ? ' on' : '');
    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    // One dot from each house theme: the choice is between two faces, and the
    // swatch should say which two.
    for (const id of [house.dark, house.light]) {
      const from = themes.find((t) => t.id === id);
      for (const color of (from ? from.swatch : []).slice(0, 2)) {
        const dot = document.createElement('i');
        dot.style.background = color;
        swatch.appendChild(dot);
      }
    }
    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = '跟随系统';
    const by = document.createElement('span');
    by.className = 'theme-by';
    by.textContent = following ? (themes.find((t) => t.id === current)?.name ?? '') : '深色 / 浅色';
    follow.append(swatch, name, by);
    follow.addEventListener('click', async () => {
      await window.dshPanel.setTheme(house.follow);
      themeMenu.hidden = true;
    });
    themeMenu.appendChild(follow);
  }

  for (const t of themes) {
    const item = document.createElement('button');
    // Following the system means no individual palette is the chosen one, even
    // though one of them is currently showing.
    item.className = 'menu-item theme-item' + (!following && t.id === current ? ' on' : '');
    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    // Show what it looks like instead of making someone apply each one to find
    // out. Colours come from main, already validated as plain hex.
    for (const color of t.swatch) {
      const dot = document.createElement('i');
      dot.style.background = color;
      swatch.appendChild(dot);
    }
    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = t.name;
    const by = document.createElement('span');
    by.className = 'theme-by';
    by.textContent = t.custom ? '自定义' : t.author || '';
    if (t.source) item.title = `${t.name} — ${t.author}\n${t.source}`;
    item.append(swatch, name, by);
    item.addEventListener('click', async () => {
      themeMenu.hidden = true;
      await window.dshPanel.setTheme(t.id);
    });
    themeMenu.appendChild(item);
  }
  const hint = document.createElement('div');
  hint.className = 'theme-hint';
  hint.textContent = `把 .json 主题放进 ${dir} 即可出现在这里`;
  hint.title = dir;
  themeMenu.appendChild(hint);

  themeMenu.hidden = false;
  const rect = themeBtn.getBoundingClientRect();
  const box = themeMenu.getBoundingClientRect();
  themeMenu.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - box.width - 6))}px`;
  themeMenu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - box.height - 6)}px`;
}

if (themeBtn) {
  themeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!themeMenu.hidden) { themeMenu.hidden = true; return; }
    openThemeMenu();
  });
  themeMenu.addEventListener('click', (e) => e.stopPropagation());
}

// ── quote a selection into the chat ───────────────────────────────────────
// Seeing something in a diff or in terminal output and asking about it should
// not mean retyping it. Selecting text anywhere in the panel offers to send it,
// fenced, with the file it came from — an affordance that appears where the
// user is looking rather than a shortcut they have to already know.
const quoteBtn = document.createElement('button');
quoteBtn.className = 'quote-btn';
quoteBtn.textContent = '引用到对话';
quoteBtn.hidden = true;
document.body.appendChild(quoteBtn);
floatingDismissers.push(() => { quoteBtn.hidden = true; });

/**
 * The current selection. The terminal keeps its own — xterm renders to a
 * canvas, so the document selection is empty there — and it is the only pane
 * that needs asking directly.
 */
function currentSelection() {
  const domText = (window.getSelection()?.toString() ?? '').trim();
  if (domText) {
    const node = window.getSelection().anchorNode;
    const host = node && (node.nodeType === 1 ? node : node.parentElement);
    const card = host && host.closest ? host.closest('.file-card') : null;
    return { text: domText, path: card ? card.dataset.path : null, rect: selectionRect() };
  }
  const tab = tabById(activeTabId);
  if (tab && tab.type === 'terminal' && tab.pane.term) {
    const termText = (tab.pane.term.getSelection() ?? '').trim();
    if (termText) return { text: termText, path: null, rect: null };
  }
  return null;
}

function selectionRect() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

function refreshQuoteButton() {
  const sel = currentSelection();
  if (!sel) {
    quoteBtn.hidden = true;
    return;
  }
  quoteBtn.hidden = false;
  // Above the selection when we know where it is; otherwise pinned bottom-right
  // (the terminal's selection has no DOM geometry to anchor to).
  if (sel.rect) {
    const top = Math.max(4, sel.rect.top - 30);
    const left = Math.min(
      Math.max(6, sel.rect.left),
      window.innerWidth - quoteBtn.offsetWidth - 6,
    );
    quoteBtn.style.top = `${top}px`;
    quoteBtn.style.left = `${left}px`;
  } else {
    quoteBtn.style.top = `${window.innerHeight - 44}px`;
    quoteBtn.style.left = '10px';
  }
}

document.addEventListener('mouseup', () => setTimeout(refreshQuoteButton, 0));
document.addEventListener('keyup', (e) => {
  if (e.shiftKey || e.key === 'Escape') setTimeout(refreshQuoteButton, 0);
});
// Both the quote button and the context menu are position:fixed, so anything
// scrolling underneath would leave them pointing at the wrong row.
document.addEventListener('scroll', dismissFloating, true);
window.addEventListener('resize', dismissFloating);

// ── context menu on anything that names a file ────────────────────────────
// Right-clicking a path is a desktop expectation; without it the only way to
// get a path out of the panel is to retype it.
const ctxMenu = document.createElement('div');
ctxMenu.className = 'menu';
ctxMenu.hidden = true;
document.body.appendChild(ctxMenu);
floatingDismissers.push(() => { ctxMenu.hidden = true; });

function hideContextMenu() {
  ctxMenu.hidden = true;
}

function showContextMenu(x, y, items) {
  ctxMenu.replaceChildren();
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'menu-item';
    btn.textContent = item.label;
    btn.addEventListener('click', async () => {
      hideContextMenu();
      await item.run();
    });
    ctxMenu.appendChild(btn);
  }
  ctxMenu.hidden = false;
  // Place it fully on screen — the panel is narrow, so a menu opened near the
  // right edge would otherwise be clipped.
  const { width, height } = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - width - 6)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - height - 6)}px`;
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest ? e.target.closest('.tree-row, .file-card') : null;
  if (!row) return;
  // `title` on a tree row holds its workspace-relative path; a change card
  // stores its own.
  const rel = row.classList.contains('file-card') ? row.dataset.path : row.title;
  if (!rel) return;
  e.preventDefault();

  const root = latestState && latestState.cwd;
  const absolute = root ? `${root}/${rel}` : null;
  const items = [
    { label: '引用到对话', run: () => window.dshPanes.sendRef(`@${rel}`, null) },
    { label: '复制路径', run: () => window.dshPanel.copyText(rel) },
  ];
  if (absolute) {
    items.push({ label: '复制绝对路径', run: () => window.dshPanel.copyText(absolute) });
    items.push({
      label: navigator.platform.startsWith('Win') ? '在文件资源管理器中显示' : '在访达中显示',
      run: () => window.dshPanel.revealPath(absolute),
    });
  }
  showContextMenu(e.clientX, e.clientY, items);
});

quoteBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
quoteBtn.addEventListener('click', () => {
  const sel = currentSelection();
  if (!sel) return;
  // Fenced, so the agent sees the excerpt as content rather than as prose, and
  // labelled with the file when the selection came from one.
  const body = ['```', sel.text, '```'].join('\n');
  window.dshPanes.sendRef(sel.path ? `@${sel.path}\n${body}` : body, quoteBtn);
  quoteBtn.hidden = true;
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
  /**
   * Exercise the backflow the way a user does — click the reference button on
   * the first tree row — and report which path was sent, so the smoke run can
   * then assert the engine's composer actually received it.
   */
  /** How many tree rows are on screen — polled, since listing is async. */
  treeRowCount() {
    return document.querySelectorAll('.tree-row').length;
  },
  /** Right-click the first tree row and run the named menu entry. */
  async contextMenuOn(label) {
    const row = document.querySelector('.tree-row');
    if (!row) return { ran: false, reason: 'no tree row rendered yet' };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 40 }));
    await new Promise((r) => setTimeout(r, 30));
    const menu = document.querySelectorAll('.menu')[document.querySelectorAll('.menu').length - 1];
    if (!menu || menu.hidden) return { ran: false, reason: 'context menu did not open' };
    const entries = [...menu.querySelectorAll('.menu-item')].map((b) => b.textContent);
    const item = [...menu.querySelectorAll('.menu-item')].find((b) => b.textContent === label);
    if (!item) return { ran: false, reason: `no "${label}" entry`, entries };
    item.click();
    return { ran: true, path: row.title, entries };
  },
  treeRefFirst() {
    const row = document.querySelector('.tree-row');
    const btn = row && row.querySelector('.tree-ref');
    if (!btn) return { clicked: false, reason: 'no tree row rendered yet' };
    btn.click();
    return { clicked: true, path: row.title };
  },
  /** What the last reference attempt reported back from the main process. */
  lastRef() {
    return window.__lastRef ?? null;
  },
  /**
   * Drive the selection-quote affordance the way a user does: select some text
   * in the panel, then click the button that appears over it.
   */
  async quoteFirstSelection() {
    // Tree rows carry `user-select: none` (clicking a row should not smear a
    // selection across it), so pick text the user could actually select — a
    // diff line when there is one, otherwise the tree header.
    const sel = window.getSelection();
    let target = null;
    for (const candidate of document.querySelectorAll('.diff .row, .tree-sub, .tree-title')) {
      if (!candidate.textContent.trim()) continue;
      const probe = document.createRange();
      probe.selectNodeContents(candidate);
      sel.removeAllRanges();
      sel.addRange(probe);
      if (sel.toString().trim()) { target = candidate; break; }
      sel.removeAllRanges();
    }
    if (!target) return { quoted: false, reason: 'no selectable text rendered' };
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // The handler defers a tick on purpose — after a real mouseup the selection
    // is not always final yet — so wait for it the same way.
    await new Promise((r) => setTimeout(r, 50));
    const btn = document.querySelector('.quote-btn');
    if (!btn || btn.hidden) {
      return {
        quoted: false,
        reason: 'quote button did not appear',
        diag: {
          buttonExists: !!btn,
          hidden: btn ? btn.hidden : null,
          selText: sel.toString(),
          from: target.className,
        },
      };
    }
    const text = sel.toString();
    btn.click();
    return { quoted: true, text };
  },
};
