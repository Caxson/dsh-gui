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
document.addEventListener('scroll', () => { quoteBtn.hidden = true; }, true);

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
