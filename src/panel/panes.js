'use strict';

/* Dsh GUI right panel — pane factories (terminal / files / web / sidechat).
   panel.js owns the tab strip and routes events into the panes built here. */

(function () {
  // ── shared helpers ────────────────────────────────────────────────────
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

  const REF_FAILURE = {
    'no-composer': '没找到输入框，先打开一个会话',
    'not-editable': '输入框未就绪，先选择工作区',
    'no-view': '聊天视图未就绪',
  };

  /**
   * Hand a reference to the chat composer and say what happened on the row
   * itself — a silent no-op is indistinguishable from a broken button.
   */
  async function sendRef(text, anchor) {
    const mark = (cls, label) => {
      if (!anchor) return;
      anchor.classList.remove('ref-ok', 'ref-bad');
      anchor.classList.add(cls);
      if (label) anchor.title = label;
      setTimeout(() => anchor.classList.remove(cls), 1400);
    };
    try {
      const res = await window.dshPanel.composeInsert(text);
      window.__lastRef = res; // read by the smoke probe
      if (res && res.ok) mark('ref-ok', '已加入输入框');
      else mark('ref-bad', REF_FAILURE[res && res.reason] || `未能加入输入框：${res && res.reason}`);
    } catch (err) {
      window.__lastRef = { ok: false, reason: err.message };
      mark('ref-bad', `未能加入输入框：${err.message}`);
    }
  }

  const ACTION_LABEL = {
    edit: '修改', create: '新建', write: '写入', insert: '插入',
    search: '搜索', fetch: '抓取',
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

  // Replaced when a theme arrives; the literal below is the starting point for
  // terminals opened before the first theme message lands.
  let XTERM_THEME = {
    background: '#151517', foreground: '#dfe3e8',
    cursor: '#4176e6', cursorAccent: '#151517',
    selectionBackground: 'rgba(65, 118, 230, 0.32)',
    black: '#2c2c2e', red: '#f85149', green: '#3fb950', yellow: '#d29922',
    blue: '#4176e6', magenta: '#b48cf2', cyan: '#67e8f9', white: '#dfe3e8',
    brightBlack: '#61666b', brightRed: '#ffa198', brightGreen: '#7ee2a8',
    brightYellow: '#e3b341', brightBlue: '#7ba2f0', brightMagenta: '#d2b6f8',
    brightCyan: '#a5f3fc', brightWhite: '#f4f6f9',
  };

  // ── terminal pane ─────────────────────────────────────────────────────
  function createTerminalPane(ptyId) {
    const root = el('section', 'pane');
    const termHost = el('div', 'term-host');
    const status = el('footer', 'statusbar');
    root.append(termHost, status);

    const FitAddonCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
    const term = new window.Terminal({
      fontSize: 12,
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      theme: XTERM_THEME,
    });
    let fit = null;
    if (FitAddonCtor) {
      fit = new FitAddonCtor();
      term.loadAddon(fit);
    }
    term.open(termHost);
    liveTerminals.add(term); // so a later theme switch reaches this one too
    term.onData((d) => window.dshPanel.ptyInput(ptyId, d));
    term.onResize(({ cols, rows }) => window.dshPanel.ptyResize(ptyId, cols, rows));

    const refit = () => {
      if (!fit) return;
      try {
        fit.fit();
      } catch { /* not laid out yet */ }
    };

    return {
      type: 'terminal', ptyId, el: root, term,
      onShow() {
        refit();
        window.dshPanel.ptyOpen(ptyId, term.cols, term.rows);
        term.focus();
      },
      onResize: refit,
      write(data) { term.write(data); },
      setCwd(text) { status.textContent = text; },
      dispose() { liveTerminals.delete(term); term.dispose(); },
    };
  }

  // ── files pane ────────────────────────────────────────────────────────
  const diffCache = new Map();
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
        adds: lines.length, dels: 0,
        truncated: lines.length > 120 ? lines.length - 120 : 0,
      };
    }
    diffCache.set(key, result);
    if (diffCache.size > 600) diffCache.delete(diffCache.keys().next().value);
    return result;
  }

  function diffBlock(diff) {
    const pre = el('pre', 'diff');
    const rows = diff.rows.slice(0, 300);
    for (const row of rows) {
      if (row.kind === 'skip') {
        // Openable in place: being told 12 lines are hidden is only useful if
        // they can be seen.
        const gap = el('div', 'skip', `⋯ 展开 ${row.count} 行未更改`);
        if (row.lines && row.lines.length) {
          gap.classList.add('can-expand');
          gap.addEventListener('click', () => {
            const frag = document.createDocumentFragment();
            for (const line of row.lines) frag.appendChild(el('div', 'row ctx', line.text || ' '));
            gap.replaceWith(frag);
          });
        } else {
          gap.textContent = `⋯ ${row.count} 行未更改`;
        }
        pre.appendChild(gap);
      } else {
        pre.appendChild(el('div', `row ${row.kind}`, row.text || ' '));
      }
    }
    const hidden = diff.rows.length - rows.length + (diff.truncated ?? 0);
    if (hidden > 0) pre.appendChild(el('div', 'skip', `⋯ 其余 ${hidden} 行已省略`));
    return pre;
  }

  function splitPath(path, homeDir) {
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

  /**
   * Express a path the way the workspace does. An absolute path works as a
   * reference, but the engine and the file tree both speak workspace-relative,
   * so a mention should match what the user sees everywhere else.
   */
  function workspaceRelative(path, root) {
    if (!root || typeof path !== 'string') return path;
    if (path === root) return '.';
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  }

  function fileCard(group, autoOpen, homeDir, workspaceRoot) {
    const open = userToggled.has(group.path) ? userToggled.get(group.path) : autoOpen;
    const card = el('div', `file-card${open ? ' open' : ''}`);
    // Lets a selection made anywhere inside this card carry the file it came
    // from, without the quote affordance knowing anything about diff internals.
    card.dataset.path = workspaceRelative(group.path, workspaceRoot);
    const head = el('div', 'file-head');
    head.appendChild(el('span', 'chev', '▶'));
    const { dir, name } = splitPath(group.path, homeDir);
    head.appendChild(el('span', 'file-name', name));
    head.appendChild(el('span', 'file-dir', dir));
    if (group.adds) head.appendChild(el('span', 'stat add', `+${group.adds}`));
    if (group.dels) head.appendChild(el('span', 'stat del', `−${group.dels}`));

    // Ask about this change without retyping the path. Same affordance as the
    // file tree, so the gesture means one thing throughout the panel.
    const ref = el('button', 'tree-ref card-ref', '@');
    ref.title = '在对话中引用它';
    ref.addEventListener('click', (ev) => {
      ev.stopPropagation(); // the header click toggles the card
      sendRef(`@${workspaceRelative(group.path, workspaceRoot)}`, ref);
    });
    head.appendChild(ref);

    head.addEventListener('click', () => {
      const nowOpen = !card.classList.contains('open');
      card.classList.toggle('open', nowOpen);
      if (userToggled.size > 800) userToggled.delete(userToggled.keys().next().value);
      userToggled.set(group.path, nowOpen);
    });
    card.appendChild(head);

    const body = el('div', 'file-body');
    for (const a of [...group.entries].sort((x, y) => y.at - x.at)) {
      const entry = el('div', 'entry');
      const meta = el('div', 'entry-meta');
      meta.appendChild(badge(a.action));
      meta.appendChild(el('span', 'time', timeText(a.at)));
      entry.appendChild(meta);
      const diff = computeEntryDiff(a);
      if (diff && diff.rows.length) entry.appendChild(diffBlock(diff));
      else if (a.action === 'insert' && a.line !== undefined) entry.appendChild(el('div', 'note', `在第 ${a.line} 行插入内容`));
      else if (a.action === 'edit' && !diff) entry.appendChild(el('div', 'note', '改动过大，未展示逐行 diff'));
      else entry.appendChild(el('div', 'note', '（无内容详情）'));
      body.appendChild(entry);
    }
    card.appendChild(body);
    return card;
  }

  function createFilesPane() {
    const root = el('section', 'pane');
    const list = el('div', 'scroll');
    root.appendChild(list);
    let workspaceRoot = null;
    return {
      type: 'files', el: root,
      count: 0,
      onShow() {}, onResize() {}, dispose() {},
      // Kept so references from this pane read the same as the file tree's:
      // workspace-relative, not absolute.
      onState(state) {
        workspaceRoot = (state && state.cwd) || null;
      },
      renderState(acts, homeDir) {
        const groups = groupFileActivities(acts ?? []);
        this.count = groups.length;
        const scrollTop = list.scrollTop;
        list.replaceChildren();
        if (groups.length === 0) {
          list.appendChild(emptyState('◇', '暂无文件变更', 'agent 编辑文件后，改动会按文件聚合显示在这里'));
          return;
        }
        groups.forEach((g, i) => list.appendChild(fileCard(g, i === 0, homeDir, workspaceRoot)));
        list.scrollTop = scrollTop;
      },
    };
  }

  // ── file tree pane ────────────────────────────────────────────────────
  /**
   * Browse the workspace. Each directory is fetched only when it is opened,
   * so a large repository costs nothing until someone looks inside it.
   */
  function createTreePane() {
    const root = el('section', 'pane');

    const head = el('div', 'tree-head');
    const title = el('div', 'tree-title', '文件树');
    const sub = el('div', 'tree-sub', '');
    const actions = el('div', 'tree-actions');
    const hiddenBtn = el('button', 'tree-btn', '⋯');
    hiddenBtn.title = '显示被忽略的目录与隐藏文件';
    const reloadBtn = el('button', 'tree-btn', '⟳');
    reloadBtn.title = '刷新';
    actions.append(hiddenBtn, reloadBtn);
    const headText = el('div', 'tree-headtext');
    headText.append(title, sub);
    head.append(headText, actions);

    const body = el('div', 'scroll tree-body');
    root.append(head, body);

    let showAll = false;
    const open = new Set(); // directories the user has expanded, by relative path

    async function list(path) {
      const data = await window.dshPanel.filesList(path, showAll);
      if (!data || data.error) throw new Error((data && data.error) || '无响应');
      return data;
    }

    function row(entry, path, depth) {
      const r = el('div', `tree-row${entry.dir ? ' is-dir' : ''}`);
      r.style.paddingLeft = `${8 + depth * 14}px`;
      const chev = el('span', 'tree-chev', entry.dir ? '▸' : '');
      const icon = el('span', 'tree-icon', entry.dir ? '📁' : '📄');
      const name = el('span', 'tree-name', entry.name);
      if (entry.hidden) r.classList.add('is-hidden-entry');
      r.append(chev, icon, name);
      if (!entry.dir && entry.size) r.appendChild(el('span', 'tree-size', fmtSize(entry.size)));

      // Reference this path in the chat. Directories already use the row click
      // to expand, so the button carries the action for every row rather than
      // giving files a click meaning that folders cannot have.
      const ref = el('button', 'tree-ref', '@');
      ref.title = '在对话中引用它';
      ref.addEventListener('click', (ev) => {
        ev.stopPropagation(); // never also toggle the folder
        sendRef(`@${path}`, ref);
      });
      r.appendChild(ref);

      r.title = path;
      return { r, chev };
    }

    function fmtSize(n) {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${(n / 1048576).toFixed(1)} MB`;
    }

    /** Render one directory's children into `into`, recursing where opened. */
    async function renderInto(into, path, depth) {
      let data;
      try {
        data = await list(path);
      } catch (err) {
        into.appendChild(el('div', 'tree-error', `读取失败: ${err.message}`));
        return;
      }
      if (data.waiting) {
        // No session yet, so no workspace to show. Say what unlocks it rather
        // than leaving an empty box; the tree loads itself once one starts.
        title.textContent = '文件树';
        sub.textContent = '';
        into.appendChild(el('div', 'tree-empty', '开始一个会话后，这里显示它的工作区'));
        return;
      }
      if (depth === 0) {
        const rootName = (data.root || '').split('/').filter(Boolean).pop() || '/';
        title.textContent = rootName;
        sub.textContent = `${data.total} 项${data.truncated ? '（已截断）' : ''}`;
      }
      if (data.entries.length === 0) {
        into.appendChild(el('div', 'tree-empty', '空目录'));
        return;
      }
      for (const entry of data.entries) {
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        const { r, chev } = row(entry, childPath, depth);
        into.appendChild(r);
        if (!entry.dir) continue;

        const kids = el('div', 'tree-kids');
        kids.hidden = !open.has(childPath);
        into.appendChild(kids);
        if (open.has(childPath)) {
          chev.textContent = '▾';
          renderInto(kids, childPath, depth + 1);
        }
        r.addEventListener('click', async () => {
          const nowOpen = kids.hidden;
          kids.hidden = !nowOpen;
          chev.textContent = nowOpen ? '▾' : '▸';
          if (nowOpen) {
            open.add(childPath);
            if (kids.childElementCount === 0) await renderInto(kids, childPath, depth + 1);
          } else {
            open.delete(childPath);
          }
        });
      }
    }

    async function reload() {
      body.replaceChildren();
      body.appendChild(el('div', 'tree-empty', '正在读取…'));
      const fresh = el('div', 'tree-kids');
      await renderInto(fresh, '', 0);
      body.replaceChildren(fresh);
    }

    reloadBtn.addEventListener('click', reload);
    hiddenBtn.addEventListener('click', () => {
      showAll = !showAll;
      hiddenBtn.classList.toggle('on', showAll);
      reload();
    });

    let loaded = false;
    let knownRoot = null;
    return {
      type: 'tree', el: root,
      onShow() {
        if (loaded) return;
        loaded = true;
        reload();
      },
      /**
       * The workspace only becomes known once a session starts, and it changes
       * when the user switches to a session in another directory. Reload on
       * both, so the tree is never quietly showing somewhere else's files or
       * an empty state that is no longer true.
       */
      onState(state) {
        const cwd = (state && state.cwd) || null;
        if (cwd === knownRoot) return;
        knownRoot = cwd;
        if (loaded) reload();
      },
      onResize() {}, dispose() {},
    };
  }

  // ── web pane ──────────────────────────────────────────────────────────
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

  function createWebPane() {
    const root = el('section', 'pane');
    const bar = el('div', 'urlbar');
    bar.id = 'browser-bar';
    const view = el('div', 'browser-view');
    const img = el('img');
    img.id = 'browser-img';
    img.alt = '';
    const empty = el('div', 'empty');
    empty.id = 'browser-empty';
    const glyph = el('div', 'empty-glyph', '◐');
    const title = el('div', '', '浏览器未启动');
    const sub = el('div', 'empty-sub', 'agent 调用 browser 工具后，这里会显示实时画面');
    // Chromium ships separately from the app; offer to fetch it rather than
    // letting the first browser call fail with a missing-executable error.
    const getBtn = el('button', 'empty-action', '下载浏览器组件');
    getBtn.hidden = true;
    const log = el('pre', 'empty-log');
    log.hidden = true;
    empty.append(glyph, title, sub, getBtn, log);
    view.append(img, empty);

    function showNeedsInstall() {
      title.textContent = '需要下载浏览器组件';
      sub.textContent = '约 150MB，只需下载一次，之后浏览器功能即可使用';
      getBtn.hidden = false;
    }

    window.dshPanel.browserStatus().then((s) => {
      if (!s.installed) showNeedsInstall();
    }).catch(() => { /* older shell without the check — leave the default copy */ });

    window.dshPanel.onBrowserProgress((text) => {
      log.hidden = false;
      log.textContent = (log.textContent + text).slice(-1200);
      log.scrollTop = log.scrollHeight;
    });

    getBtn.addEventListener('click', async () => {
      getBtn.disabled = true;
      getBtn.textContent = '正在下载…';
      log.hidden = false;
      log.textContent = '';
      const r = await window.dshPanel.browserInstall().catch((e) => ({ ok: false, output: String(e) }));
      if (r && r.ok) {
        getBtn.hidden = true;
        log.hidden = true;
        title.textContent = '浏览器未启动';
        sub.textContent = 'agent 调用 browser 工具后，这里会显示实时画面';
      } else {
        getBtn.disabled = false;
        getBtn.textContent = '重试下载';
        sub.textContent = '下载失败，可重试或检查网络';
      }
    });
    const split = el('div', 'pane-split');
    split.appendChild(el('div', 'pane-title', '活动记录'));
    const list = el('div', 'scroll');
    split.appendChild(list);
    root.append(bar, view, split);
    return {
      type: 'web', el: root,
      onShow() {}, onResize() {}, dispose() {},
      renderState(acts) {
        const items = (acts ?? []).filter((a) => a.kind === 'web').slice(-100).reverse();
        const scrollTop = list.scrollTop;
        list.replaceChildren();
        if (items.length === 0) list.appendChild(emptyState('◇', '暂无浏览器活动'));
        else for (const a of items) list.appendChild(webCard(a));
        list.scrollTop = scrollTop;
      },
      renderShot(s) {
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
      },
    };
  }

  // ── side chat pane (ephemeral) ────────────────────────────────────────
  function createSidechatPane(chatId) {
    const root = el('section', 'pane');
    const list = el('div', 'scroll chat-list');
    const hero = el('div', 'chat-hero');
    hero.appendChild(el('div', 'chat-hero-glyph', '💬'));
    hero.appendChild(el('div', 'chat-hero-title', '侧边聊天'));
    hero.appendChild(el('div', 'chat-hero-sub', '侧边聊天是临时聊天，关闭应用后会消失。'));
    list.appendChild(hero);
    const composer = el('div', 'chat-composer');
    const input = el('textarea', 'chat-input');
    input.placeholder = '随心输入';
    input.rows = 1;
    const send = el('button', 'chat-send');
    send.title = '发送';
    send.textContent = '↑';
    composer.append(input, send);
    root.append(list, composer);

    const history = []; // {role, text}
    let streaming = null; // bubble element receiving chunks

    function bubble(role, text) {
      const b = el('div', `chat-msg ${role}`);
      b.textContent = text;
      list.appendChild(b);
      list.scrollTop = list.scrollHeight;
      return b;
    }

    function submit() {
      const text = input.value.trim();
      if (text === '' || streaming !== null) return;
      input.value = '';
      hero.remove();
      history.push({ role: 'user', text });
      bubble('user', text);
      streaming = bubble('assistant', '…');
      window.dshPanel.sidechatSend(chatId, history.slice());
    }

    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });

    return {
      type: 'sidechat', chatId, el: root,
      onShow() { input.focus(); },
      onResize() {},
      dispose() {
        // Closing the tab mid-stream must stop the model call (and its billing).
        if (streaming !== null) window.dshPanel.sidechatAbort(chatId);
      },
      onChunk(text, done, error) {
        if (streaming === null) return;
        if (streaming.textContent === '…') streaming.textContent = '';
        if (text) {
          streaming.textContent += text;
          list.scrollTop = list.scrollHeight;
        }
        if (done) {
          if (error && streaming.textContent === '') streaming.textContent = `出错了: ${error}`;
          history.push({ role: 'assistant', text: streaming.textContent });
          streaming = null;
        }
      },
    };
  }

  /** Live terminals, so a theme switch reaches the ones already open. */
  const liveTerminals = new Set();

  function applyTerminalTheme(theme) {
    XTERM_THEME = theme;
    for (const term of liveTerminals) {
      try { term.options.theme = theme; } catch { /* a disposed terminal */ }
    }
  }

  window.dshPanes = {
    createTerminalPane, createFilesPane, createTreePane, createWebPane, createSidechatPane,
    applyTerminalTheme, liveTerminals,
    // Shared so the selection-quote affordance in panel.js reports success and
    // failure exactly the way the per-row buttons do.
    sendRef, workspaceRelative,
  };
})();
