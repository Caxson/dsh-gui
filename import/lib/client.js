/**
 * dsh-gui-import — browser half.
 *
 * Sidebar footer action (官方 sidebar.footer.action 槽位) opens a frame-level
 * modal (shell.overlay) listing local Claude Code / Codex / pi transcripts.
 * Picking one: host compresses it into a continuation brief → create/reuse a
 * workspace at the transcript's cwd → new session → (optional preset select,
 * before the first prompt while the session is still blank) → prompt the brief.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gui-import',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')
    var h = react.createElement

    exports.name = 'dsh-gui-import-client'
    exports.inject = ['slots', 'sessions', 'workspaces', 'connection']

    // ── shared open/close store (button ↔ overlay) ────────────────────────
    var store = { open: false, subs: new Set() }
    function emit() {
      store.subs.forEach(function (fn) {
        try { fn() } catch (e) {}
      })
    }
    function setOpen(v) {
      store.open = v
      emit()
    }
    function useStore() {
      var forcePair = react.useState(0)
      react.useEffect(function () {
        var fn = function () { forcePair[1](function (x) { return x + 1 }) }
        store.subs.add(fn)
        return function () { store.subs.delete(fn) }
      }, [])
    }

    var SOURCE_LABEL = { claude: 'Claude Code', codex: 'Codex', pi: 'pi' }
    var SOURCE_COLOR = { claude: '#d97757', codex: '#7ba2f0', pi: '#3fb950' }

    var S = {
      backdrop: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'auto', zIndex: 60,
      },
      modal: {
        width: 'min(680px, 92vw)', maxHeight: '78vh', display: 'flex',
        flexDirection: 'column', borderRadius: 14, overflow: 'hidden',
        background: 'var(--dsw-alias-bg-base, #1b1b1c)',
        border: '1px solid rgba(128,138,160,0.25)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)', color: 'inherit',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px',
        borderBottom: '1px solid rgba(128,138,160,0.18)',
      },
      title: { fontSize: 14, fontWeight: 600, flex: '0 0 auto' },
      search: {
        flex: '1 1 auto', fontSize: 12.5, padding: '6px 12px', borderRadius: 8,
        border: '1px solid rgba(128,138,160,0.3)', background: 'transparent',
        color: 'inherit', outline: 'none',
      },
      close: {
        flex: '0 0 auto', width: 26, height: 26, border: 'none', borderRadius: 6,
        background: 'transparent', color: 'inherit', opacity: 0.6,
        fontSize: 16, cursor: 'pointer',
      },
      filters: {
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '9px 16px 3px', flexWrap: 'wrap',
      },
      chip: function (active) {
        return {
          fontSize: 11.5, padding: '3px 12px', borderRadius: 999, cursor: 'pointer',
          border: '1px solid rgba(128,138,160,' + (active ? '0.55' : '0.25') + ')',
          background: active ? 'rgba(128,138,160,0.16)' : 'transparent',
          color: 'inherit', opacity: active ? 1 : 0.7,
        }
      },
      presetSel: {
        marginLeft: 'auto', fontSize: 11.5, padding: '3px 8px', borderRadius: 7,
        border: '1px solid rgba(128,138,160,0.3)', background: 'transparent', color: 'inherit',
      },
      list: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '8px 10px 12px' },
      row: {
        display: 'flex', alignItems: 'center', gap: 9, width: '100%',
        textAlign: 'left', padding: '9px 10px', borderRadius: 9, cursor: 'pointer',
        border: 'none', background: 'transparent', color: 'inherit', font: 'inherit',
      },
      badge: function (source) {
        return {
          flex: '0 0 auto', fontSize: 10, fontWeight: 600, padding: '1px 8px',
          borderRadius: 999, color: SOURCE_COLOR[source] || 'inherit',
          border: '1px solid ' + (SOURCE_COLOR[source] || 'rgba(128,138,160,0.4)'),
          opacity: 0.9,
        }
      },
      rowTitle: {
        flex: '1 1 auto', fontSize: 12.5, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      },
      rowMeta: {
        flex: '0 0 auto', fontSize: 10.5, opacity: 0.55,
        fontFamily: 'ui-monospace, monospace', maxWidth: 180,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      center: {
        flex: '1 1 auto', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 10,
        padding: 32, textAlign: 'center',
      },
      spinner: { fontSize: 22, opacity: 0.8 },
      err: {
        fontSize: 12, color: '#f85149', whiteSpace: 'pre-wrap',
        wordBreak: 'break-all', maxWidth: 480,
      },
      btn: {
        fontSize: 12, padding: '5px 16px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid rgba(128,138,160,0.3)', background: 'transparent', color: 'inherit',
      },
      footerBtn: function (wide) {
        return {
          display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center',
          gap: 8, width: '100%', padding: wide ? '7px 10px' : '7px 0',
          border: 'none', borderRadius: 8, background: 'transparent',
          color: 'inherit', font: 'inherit', fontSize: 12.5, cursor: 'pointer', opacity: 0.85,
        }
      },
    }

    function timeText(mtime) {
      var d = new Date(mtime)
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    function continuationPrompt(source, summary, transcriptPath) {
      // The brief is a lossy compression of a much longer transcript. Hand the
      // agent the original file path as an index so it can go read the raw
      // record itself when it needs a detail the brief dropped (an exact error
      // string, a command that was run, the wording of a decision) instead of
      // guessing or asking the user to repeat it.
      var index = transcriptPath
        ? '\n\n---\n\n原始会话记录（简报是它的有损压缩）：`' + transcriptPath + '`\n' +
          '简报里缺少的细节——具体报错、跑过的命令、某个决定的原话——直接读这个文件检索，不要凭空猜测。'
        : ''
      return '我把一段在 ' + (SOURCE_LABEL[source] || source) + ' 里进行的历史会话迁移了过来。' +
        '下面是它的接续简报，请通读后直接接着干活：优先处理「未完成事项与下一步」，' +
        '遵守简报里的约定与偏好，不要重做已完成的工作。\n\n---\n\n' + summary + index
    }

    async function runImport(ctx, row, preset, setPhase) {
      setPhase({ kind: 'working', text: '正在用模型压缩理解这段会话（可能要一两分钟）…' })
      var res = await fetch('/dsh-gui/import/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: row.path }),
      })
      var data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status)
      var cwd = data.cwd
      if (!cwd) throw new Error('未能从这份记录里识别出仍然存在的工作目录，无法定位工作区')

      setPhase({ kind: 'working', text: '正在创建接续会话…' })
      var ws = await ctx.workspaces.create({ path: cwd })
      var sessionId = await ctx.workspaces.connectWorkspace(ws.workspaceId)
      ctx.sessions.open(sessionId)

      if (preset && preset !== 'standard') {
        // Must happen before the first prompt — presets lock once the
        // session stops being blank.
        var sel = await ctx.get('connection').api.agentPresets.select({
          sessionId: sessionId,
          agentPreset: preset,
        })
        if (sel.result && sel.result.ok) {
          ctx.sessions.noteAgentPreset(sessionId, sel.result.value.agentPreset)
        }
      }

      var binding = ctx.sessions.binding(sessionId)
      var sent = await binding.session.prompt(
        [{ type: 'text', text: continuationPrompt(row.source, data.summary, data.path || row.path) }],
        'queue',
      )
      if (!sent.ok) throw new Error(sent.error.code + ': ' + sent.error.message)
    }

    function ImportModal(props) {
      var ctx = props.ctx
      var listPair = react.useState({ status: 'loading' })
      var queryPair = react.useState('')
      var sourcePair = react.useState('all')
      var presetPair = react.useState('standard')
      var phasePair = react.useState({ kind: 'list' })

      react.useEffect(function () {
        fetch('/dsh-gui/import/sessions', { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (d) { listPair[1]({ status: 'ready', sessions: d.sessions || [] }) })
          .catch(function (e) { listPair[1]({ status: 'error', error: String(e) }) })
      }, [])

      function close() {
        if (phasePair[0].kind !== 'working') setOpen(false)
      }

      function pick(row) {
        runImport(ctx, row, presetPair[0], phasePair[1])
          .then(function () {
            phasePair[1]({ kind: 'list' })
            setOpen(false)
          })
          .catch(function (e) {
            phasePair[1]({ kind: 'error', error: String(e && e.message ? e.message : e) })
          })
      }

      var body
      if (phasePair[0].kind === 'working') {
        body = h('div', { style: S.center },
          h('div', { style: S.spinner }, '⏳'),
          h('div', { style: { fontSize: 13 } }, phasePair[0].text))
      } else if (phasePair[0].kind === 'error') {
        body = h('div', { style: S.center },
          h('div', { style: S.err }, phasePair[0].error),
          h('button', { style: S.btn, onClick: function () { phasePair[1]({ kind: 'list' }) } }, '返回列表'))
      } else if (listPair[0].status === 'loading') {
        body = h('div', { style: S.center }, h('div', { style: S.spinner }, '…'))
      } else if (listPair[0].status === 'error') {
        body = h('div', { style: S.center }, h('div', { style: S.err }, listPair[0].error))
      } else {
        var q = queryPair[0].trim().toLowerCase()
        var rows = listPair[0].sessions.filter(function (s) {
          if (sourcePair[0] !== 'all' && s.source !== sourcePair[0]) return false
          if (q === '') return true
          return (s.title + ' ' + s.cwd).toLowerCase().indexOf(q) >= 0
        })
        body = h('div', { style: S.list },
          rows.length === 0
            ? h('div', { style: S.center }, h('div', { style: { opacity: 0.6, fontSize: 12.5 } }, '没有匹配的会话'))
            : rows.map(function (row) {
                return h('button', {
                  key: row.path, style: S.row,
                  onMouseEnter: function (e) { e.currentTarget.style.background = 'rgba(128,138,160,0.12)' },
                  onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' },
                  onClick: function () { pick(row) },
                },
                  h('span', { style: S.badge(row.source) }, SOURCE_LABEL[row.source] || row.source),
                  h('span', { style: S.rowTitle }, row.title),
                  h('span', { style: S.rowMeta }, row.cwd),
                  h('span', { style: Object.assign({}, S.rowMeta, { maxWidth: 78 }) }, timeText(row.mtime)))
              }))
      }

      return h('div', { style: S.backdrop, onClick: close },
        h('div', { style: S.modal, onClick: function (e) { e.stopPropagation() } },
          h('div', { style: S.head },
            h('span', { style: S.title }, '导入会话'),
            h('input', {
              style: S.search, type: 'search', autoFocus: true,
              placeholder: '搜索 Claude Code / Codex / pi 的历史会话…',
              value: queryPair[0],
              onChange: function (e) { queryPair[1](e.currentTarget.value) },
            }),
            h('button', { style: S.close, onClick: close, title: '关闭' }, '×')),
          h('div', { style: S.filters },
            ['all', 'claude', 'codex', 'pi'].map(function (key) {
              return h('button', {
                key: key, style: S.chip(sourcePair[0] === key),
                onClick: function () { sourcePair[1](key) },
              }, key === 'all' ? '全部' : SOURCE_LABEL[key])
            }),
            h('select', {
              style: S.presetSel, value: presetPair[0], title: '接续会话使用的模式',
              onChange: function (e) { presetPair[1](e.currentTarget.value) },
            },
              h('option', { value: 'standard' }, '标准模式'),
              h('option', { value: 'flow' }, '心流模式'))),
          body))
    }

    function ImportOverlay(props) {
      useStore()
      if (!store.open) return null
      return h(ImportModal, { ctx: props.ctx })
    }

    function ImportButton(props) {
      return h('button', {
        style: S.footerBtn(props.wide),
        title: '导入 Claude Code / Codex / pi 的历史会话',
        onClick: function () { setOpen(true) },
      }, h('span', { 'aria-hidden': true }, '⤵'), props.wide ? '导入会话' : null)
    }

    exports.apply = function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'session-import', order: 90, label: '导入会话' },
          ImportButton,
        )
      })
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'session-import-modal', order: 60 },
          function () { return h(ImportOverlay, { ctx: ctx }) },
        )
      })
    }

    return exports
  },
})
