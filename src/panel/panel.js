'use strict';

/* Dsh GUI right panel — Codex-style 终端 / 文件 / 浏览器 tabs. */

// ── terminal ──────────────────────────────────────────────────────────────
const FitAddonCtor =
  (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;

const term = new window.Terminal({
  fontSize: 12,
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  lineHeight: 1.25,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 5000,
  theme: {
    background: '#0b0d12',
    foreground: '#d7dde8',
    cursor: '#5b7cff',
    cursorAccent: '#0b0d12',
    selectionBackground: 'rgba(91, 124, 255, 0.30)',
    black: '#1c212e',
    red: '#f85149',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#5b7cff',
    magenta: '#b48cf2',
    cyan: '#67e8f9',
    white: '#d7dde8',
    brightBlack: '#566079',
    brightRed: '#ffa198',
    brightGreen: '#7ee2a8',
    brightYellow: '#e3b341',
    brightBlue: '#93b4ff',
    brightMagenta: '#d2b6f8',
    brightCyan: '#a5f3fc',
    brightWhite: '#f1f5fb',
  },
});
let fit = null;
if (FitAddonCtor) {
  fit = new FitAddonCtor();
  term.loadAddon(fit);
}
term.open(document.getElementById('term'));
refit();
term.onData((d) => window.dshPanel.ptyInput(d));
term.onResize(({ cols, rows }) => window.dshPanel.ptyResize(cols, rows));
window.dshPanel.ptyOpen(term.cols, term.rows);

window.dshPanel.onPtyData((d) => term.write(d));
window.dshPanel.onPtyExit(() => term.writeln('\r\n\x1b[90m[终端会话已结束]\x1b[0m'));

function refit() {
  if (!fit) return;
  try {
    fit.fit();
  } catch {
    /* container not laid out yet — refit on next tab focus */
  }
}

window.addEventListener('resize', refit);

// ── tabs ──────────────────────────────────────────────────────────────────
const paneIds = { terminal: 'terminal', files: 'files', web: 'web' };
const tabButtons = document.querySelectorAll('.segmented .seg');

// Global on purpose: the smoke probe drives tabs via executeJavaScript.
function switchTab(tab) {
  for (const btn of tabButtons) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const [key, id] of Object.entries(paneIds)) {
    document.getElementById(id).classList.toggle('active', key === tab);
  }
  if (tab === 'terminal') {
    refit();
    window.dshPanel.ptyOpen(term.cols, term.rows);
    term.focus();
  }
  window.dshPanel.tabChanged(tab);
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

document.getElementById('collapse-btn').addEventListener('click', () => {
  window.dshPanel.collapsePanel();
});

// ── shared render helpers ─────────────────────────────────────────────────
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeText(at) {
  const d = new Date(at);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const ACTION_LABEL = {
  edit: '修改',
  create: '新建',
  write: '写入',
  insert: '插入',
  search: '搜索',
  fetch: '抓取',
};

function badge(action) {
  return el('span', `badge ${action}`, ACTION_LABEL[action] ?? action);
}

function emptyState(glyph, title, sub) {
  const wrap = el('div', 'empty');
  wrap.appendChild(el('div', 'empty-glyph', glyph));
  wrap.appendChild(el('div', '', title));
  if (sub) wrap.appendChild(el('div', 'empty-sub', sub));
  return wrap;
}

// ── files pane: per-file cards with real diffs ────────────────────────────
// Cache computed diffs by activity identity (path+at survives re-polls).
const diffCache = new Map();
// Paths the user explicitly toggled; wins over the auto-expand default.
const userToggled = new Map();

function computeEntryDiff(a) {
  const key = `${a.path}@${a.at}#${a.action}`;
  if (diffCache.has(key)) return diffCache.get(key);
  let result = null;
  if (a.action === 'edit' && (a.oldText !== undefined || a.newText !== undefined)) {
    result = window.dshDiff.compute(a.oldText ?? '', a.newText ?? '');
  } else if (a.action === 'create' || a.action === 'write') {
    const lines = window.dshDiff.splitLines(a.newText ?? '');
    result = {
      rows: lines.slice(0, 120).map((text) => ({ kind: 'add', text })),
      adds: lines.length,
      dels: 0,
      truncated: lines.length > 120 ? lines.length - 120 : 0,
    };
  }
  diffCache.set(key, result);
  if (diffCache.size > 600) {
    diffCache.delete(diffCache.keys().next().value);
  }
  return result;
}

function diffBlock(diff) {
  const pre = el('pre', 'diff');
  const rows = diff.rows.slice(0, 300);
  for (const row of rows) {
    if (row.kind === 'skip') {
      pre.appendChild(el('div', 'skip', `⋯ ${row.count} 行未更改`));
    } else {
      pre.appendChild(el('div', `row ${row.kind}`, row.text || ' '));
    }
  }
  const hidden = diff.rows.length - rows.length + (diff.truncated ?? 0);
  if (hidden > 0) {
    pre.appendChild(el('div', 'skip', `⋯ 其余 ${hidden} 行已省略`));
  }
  return pre;
}

let homeDir = '';

function splitPath(path) {
  const idx = (path ?? '').lastIndexOf('/');
  if (idx < 0) return { dir: '', name: path ?? '' };
  let dir = path.slice(0, idx);
  if (homeDir && dir.startsWith(homeDir)) dir = `~${dir.slice(homeDir.length)}`;
  return { dir, name: path.slice(idx + 1) };
}

function groupFileActivities(acts) {
  const groups = new Map();
  for (const a of acts) {
    if (a.kind !== 'file' || !a.path) continue;
    let g = groups.get(a.path);
    if (!g) {
      g = { path: a.path, entries: [], adds: 0, dels: 0, latestAt: 0 };
      groups.set(a.path, g);
    }
    g.entries.push(a);
    g.latestAt = Math.max(g.latestAt, a.at);
    const diff = computeEntryDiff(a);
    if (diff) {
      g.adds += diff.adds;
      g.dels += diff.dels;
    }
  }
  return [...groups.values()].sort((x, y) => y.latestAt - x.latestAt);
}

function fileCard(group, autoOpen) {
  const open = userToggled.has(group.path) ? userToggled.get(group.path) : autoOpen;
  const card = el('div', `file-card${open ? ' open' : ''}`);
  const head = el('div', 'file-head');
  head.appendChild(el('span', 'chev', '▶'));
  const { dir, name } = splitPath(group.path);
  head.appendChild(el('span', 'file-name', name));
  head.appendChild(el('span', 'file-dir', dir));
  if (group.adds) head.appendChild(el('span', 'stat add', `+${group.adds}`));
  if (group.dels) head.appendChild(el('span', 'stat del', `−${group.dels}`));
  head.addEventListener('click', () => {
    const nowOpen = !card.classList.contains('open');
    card.classList.toggle('open', nowOpen);
    userToggled.set(group.path, nowOpen);
  });
  card.appendChild(head);

  const body = el('div', 'file-body');
  const entries = [...group.entries].sort((x, y) => y.at - x.at);
  for (const a of entries) {
    const entry = el('div', 'entry');
    const meta = el('div', 'entry-meta');
    meta.appendChild(badge(a.action));
    meta.appendChild(el('span', 'time', timeText(a.at)));
    entry.appendChild(meta);
    const diff = computeEntryDiff(a);
    if (diff && diff.rows.length) {
      entry.appendChild(diffBlock(diff));
    } else if (a.action === 'insert' && a.line !== undefined) {
      entry.appendChild(el('div', 'note', `在第 ${a.line} 行插入内容`));
    } else if (a.action === 'edit' && !diff) {
      entry.appendChild(el('div', 'note', '改动过大，未展示逐行 diff'));
    } else {
      entry.appendChild(el('div', 'note', '（无内容详情）'));
    }
    body.appendChild(entry);
  }
  card.appendChild(body);
  return card;
}

function renderFiles(acts) {
  const container = document.getElementById('files-list');
  const groups = groupFileActivities(acts ?? []);
  const countEl = document.getElementById('files-count');
  countEl.hidden = groups.length === 0;
  countEl.textContent = String(groups.length);

  const scrollTop = container.scrollTop;
  container.replaceChildren();
  if (groups.length === 0) {
    container.appendChild(
      emptyState('◇', '暂无文件变更', 'agent 编辑文件后，改动会按文件聚合显示在这里'),
    );
    return;
  }
  groups.forEach((g, i) => container.appendChild(fileCard(g, i === 0)));
  container.scrollTop = scrollTop;
}

// ── web pane ──────────────────────────────────────────────────────────────
function webCard(a) {
  const card = el('div', 'web-card');
  const head = el('div', 'web-head');
  head.appendChild(badge(a.type));
  head.appendChild(el('span', 'time', timeText(a.at)));
  card.appendChild(head);
  if (a.query) card.appendChild(el('div', 'web-query', a.query));
  if (a.url) card.appendChild(el('div', 'web-query', a.url));
  if (a.links && a.links.length) {
    const wrap = el('div', 'web-links');
    for (const link of a.links) {
      const aEl = el('a', '', link);
      aEl.href = link;
      aEl.target = '_blank';
      aEl.rel = 'noreferrer';
      wrap.appendChild(aEl);
    }
    card.appendChild(wrap);
  } else if (a.result) {
    card.appendChild(el('div', 'web-result', a.result.slice(0, 400)));
  }
  return card;
}

function renderWeb(acts) {
  const container = document.getElementById('web-list');
  const items = (acts ?? []).filter((a) => a.kind === 'web').slice(-100).reverse();
  const scrollTop = container.scrollTop;
  container.replaceChildren();
  if (items.length === 0) {
    container.appendChild(emptyState('◇', '暂无浏览器活动'));
    return;
  }
  for (const a of items) container.appendChild(webCard(a));
  container.scrollTop = scrollTop;
}

// ── live browser view ─────────────────────────────────────────────────────
window.dshPanel.onBrowserShot((s) => {
  const img = document.getElementById('browser-img');
  const empty = document.getElementById('browser-empty');
  const bar = document.getElementById('browser-bar');
  if (s.live && s.jpeg) {
    img.src = 'data:image/jpeg;base64,' + s.jpeg;
    img.style.display = 'block';
    empty.style.display = 'none';
    bar.textContent = [s.title, s.url].filter(Boolean).join(' — ');
  } else {
    img.style.display = 'none';
    empty.style.display = 'flex';
    bar.textContent = s.error ? `浏览器错误: ${s.error}` : '';
  }
});

// ── state stream ──────────────────────────────────────────────────────────
// Skip re-render when the snapshot is unchanged so scroll and expansion
// survive the 1.2s poll loop.
let lastStateKey = '';

function stateKey(s) {
  const acts = s.activities ?? [];
  const last = acts[acts.length - 1];
  return `${acts.length}:${last ? last.at : 0}:${JSON.stringify(s).length}`;
}

window.dshPanel.onState((s) => {
  homeDir = s.home ?? homeDir;
  const hint = document.getElementById('term-hint');
  if (s.cwd) {
    hint.textContent = homeDir && s.cwd.startsWith(homeDir) ? `~${s.cwd.slice(homeDir.length)}` : s.cwd;
  }
  const key = stateKey(s);
  if (key === lastStateKey) return;
  lastStateKey = key;
  renderFiles(s.activities);
  renderWeb(s.activities);
});
