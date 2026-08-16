/**
 * dsh-gui-market — browser half.
 *
 * Registers the third tab (市场) in Settings → 插件 via the official
 * `settings.plugins.tab` slot (ids `configurable`/0 and `all`/10 are taken by
 * the engine; we sit at 20). Talks to the Node half over same-origin fetch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gui-market',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')
    var h = react.createElement

    var NS = 'dsh-gui-market'
    var zh = {
      tab: '市场',
      installedTitle: '已安装',
      searchTitle: '搜索安装',
      searchPlaceholder: '搜索 dsh 插件（留空列出 dsh-plugin 生态）…',
      searchBtn: '搜索',
      installBtn: '安装',
      installingBtn: '安装中…',
      noDescription: '（该插件未提供描述）',
      builtin: '内置',
      disabled: '已停用',
      instances: '个实例',
      restartNotice: '✅ 安装成功。插件层在引擎启动时组合，重启 Dsh GUI 后生效。',
      loadFailed: '加载失败',
      retry: '重试',
      empty: '没有找到匹配的插件',
      onlyDsh: '仅 dsh 生态',
      onlyCurated: '仅精选',
      tierVerified: '已验证',
      tierCommunity: '社区',
      viewSource: '查看源码',
      showing: '显示',
      of: '/',
      confirmInstall: '将从 GitHub 拉取并安装（固定提交）。仅安装你信任的插件，确定继续？',
    }
    var en = {
      tab: 'Market',
      installedTitle: 'Installed',
      searchTitle: 'Search & install',
      searchPlaceholder: 'Search dsh plugins (empty lists the dsh-plugin ecosystem)…',
      searchBtn: 'Search',
      installBtn: 'Install',
      installingBtn: 'Installing…',
      noDescription: '(no description provided)',
      builtin: 'built-in',
      disabled: 'disabled',
      instances: 'instances',
      restartNotice: '✅ Installed. Bundles compose at engine boot — restart Dsh GUI to take effect.',
      loadFailed: 'Failed to load',
      retry: 'Retry',
      empty: 'No matching plugins',
      onlyDsh: 'dsh ecosystem only',
      onlyCurated: 'Curated only',
      tierVerified: 'verified',
      tierCommunity: 'community',
      viewSource: 'View source',
      showing: 'Showing',
      of: 'of',
      confirmInstall: 'This fetches and installs from GitHub at a pinned commit. Only install plugins you trust — continue?',
    }

    exports.name = 'dsh-gui-market-client'
    exports.inject = ['slots', 'locale']

    // ── styles (inline; follows the muted settings visual language) ────────
    var S = {
      section: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 0' },
      heading: { fontSize: 13, fontWeight: 600, margin: '0 0 8px' },
      card: {
        border: '1px solid rgba(128,138,160,0.22)', borderRadius: 8,
        padding: '8px 12px', marginBottom: 8,
      },
      cardHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      name: { fontWeight: 600, fontSize: 12.5, fontFamily: 'ui-monospace, monospace' },
      chip: {
        fontSize: 10, padding: '1px 7px', borderRadius: 999,
        background: 'rgba(128,138,160,0.14)', color: 'inherit', opacity: 0.85,
      },
      desc: { fontSize: 12, opacity: 0.72, margin: '4px 0 0', lineHeight: 1.5 },
      dim: { fontSize: 11, opacity: 0.55 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      input: {
        flex: '1 1 220px', fontSize: 12, padding: '5px 10px', borderRadius: 6,
        border: '1px solid rgba(128,138,160,0.3)', background: 'transparent', color: 'inherit',
      },
      btn: {
        fontSize: 12, padding: '4px 14px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid rgba(128,138,160,0.3)', background: 'transparent', color: 'inherit',
      },
      select: {
        fontSize: 12, padding: '4px 8px', borderRadius: 6,
        border: '1px solid rgba(128,138,160,0.3)', background: 'transparent', color: 'inherit',
      },
      notice: {
        fontSize: 12, padding: '8px 12px', borderRadius: 6,
        background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.35)',
      },
      error: {
        fontSize: 12, padding: '8px 12px', borderRadius: 6,
        background: 'rgba(248,81,73,0.10)', border: '1px solid rgba(248,81,73,0.35)',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      },
      output: {
        fontSize: 11, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap',
        wordBreak: 'break-all', maxHeight: 180, overflow: 'auto', opacity: 0.7,
        margin: '6px 0 0',
      },
      link: { color: 'inherit', opacity: 0.6, fontSize: 11, textDecoration: 'underline' },
      chipVerified: {
        fontSize: 10, padding: '1px 7px', borderRadius: 999,
        background: 'rgba(63,185,80,0.16)', color: 'inherit', opacity: 0.9,
      },
      chipTag: {
        fontSize: 10, padding: '1px 7px', borderRadius: 999,
        background: 'rgba(65,118,230,0.14)', color: 'inherit', opacity: 0.8,
      },
      note: { fontSize: 11, opacity: 0.5, marginLeft: 'auto' },
    }

    // Package/registry metadata is publisher-controlled; only render http(s)
    // URLs as clickable links (blocks javascript:/data: hrefs).
    function safeUrl(u) {
      return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null
    }

    function InstalledCard(props) {
      var p = props.plugin
      var t = props.t
      var multi = p.instances.length > 1
      var chips = []
      if (p.version) chips.push(h('span', { key: 'v', style: S.chip }, 'v' + p.version))
      if (p.builtin) chips.push(h('span', { key: 'b', style: S.chip }, t('builtin')))
      if (multi) chips.push(h('span', { key: 'm', style: S.chip }, p.instances.length + ' ' + t('instances')))
      var disabledCount = p.instances.filter(function (i) { return !i.enabled }).length
      if (disabledCount > 0) chips.push(h('span', { key: 'd', style: S.chip }, t('disabled') + ' ' + disabledCount))
      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('span', { style: S.name }, p.moduleName),
          chips,
          safeUrl(p.repository)
            ? h('a', { style: S.link, href: safeUrl(p.repository), target: '_blank', rel: 'noreferrer' }, 'repo')
            : null
        ),
        h('p', { style: S.desc }, p.description || t('noDescription')),
        // Same module mounted more than once (e.g. spawn + fork subagent
        // providers) is intentional — show each instance so rows stay
        // distinguishable instead of collapsing real entries.
        multi
          ? h('div', { style: Object.assign({ marginTop: 4 }, S.dim) },
              p.instances.map(function (i) { return i.entryId + (i.enabled ? '' : ' (' + t('disabled') + ')') }).join(' · '))
          : null
      )
    }

    function SearchRow(props) {
      var r = props.result
      var t = props.t
      var busy = props.busy
      var meta = []
      if (r.version) meta.push('v' + r.version)
      if (typeof r.stars === 'number') meta.push('★ ' + r.stars)
      var head = [h('span', { key: 'n', style: S.name }, r.name)]
      // Two-tier trust: a verified (registry-admitted) chip when present,
      // otherwise the community tier is implicit. Category/kind as a soft tag.
      if (r.tier === 'verified') head.push(h('span', { key: 'tv', style: S.chipVerified }, t('tierVerified')))
      if (r.category || r.kind) head.push(h('span', { key: 'cat', style: S.chipTag }, r.category || r.kind))
      if (meta.length) head.push(h('span', { key: 'm', style: S.dim }, meta.join(' · ')))
      if (safeUrl(r.url)) head.push(h('a', { key: 'u', style: S.link, href: safeUrl(r.url), target: '_blank', rel: 'noreferrer' }, r.source))
      // installable === undefined means a legacy npm/github row (always
      // installable); an explicit false (hub) means browse-only.
      var canInstall = r.installable !== false && !!r.spec
      head.push(
        canInstall
          ? h('button', {
              key: 'b', style: Object.assign({}, S.btn, { marginLeft: 'auto' }),
              disabled: busy,
              onClick: function () { props.onInstall(r) },
            }, busy ? t('installingBtn') : t('installBtn'))
          : h('span', { key: 'note', style: S.note }, r.note || t('viewSource'))
      )
      return h('div', { style: S.card },
        h('div', { style: S.cardHead }, head),
        h('p', { style: S.desc }, r.description || t('noDescription'))
      )
    }

    function MarketTab(props) {
      var t = props.t
      var installedPair = react.useState({ status: 'loading' })
      var installed = installedPair[0]
      var setInstalled = installedPair[1]
      var sourcePair = react.useState('hub')
      var strictPair = react.useState(true)
      var queryPair = react.useState('')
      var resultsPair = react.useState(null)
      var searchingPair = react.useState(false)
      var installingPair = react.useState('')
      var installDonePair = react.useState(null)

      function loadInstalled() {
        setInstalled({ status: 'loading' })
        fetch('/api/market/installed', { cache: 'no-store' })
          .then(function (res) { return res.json() })
          .then(function (data) { setInstalled({ status: 'ready', plugins: data.plugins || [] }) })
          .catch(function () { setInstalled({ status: 'error' }) })
      }
      react.useEffect(loadInstalled, [])

      function runSearch() {
        searchingPair[1](true)
        resultsPair[1](null)
        var url = '/api/market/search?source=' + sourcePair[0] +
          '&strict=' + (strictPair[0] ? '1' : '0') +
          '&q=' + encodeURIComponent(queryPair[0])
        fetch(url, { cache: 'no-store' })
          .then(function (res) { return res.json() })
          .then(function (data) {
            resultsPair[1](data.error ? { error: data.error } : { rows: data.results || [], total: data.total })
          })
          .catch(function (err) { resultsPair[1]({ error: String(err && err.message ? err.message : err) }) })
          .then(function () { searchingPair[1](false) })
      }

      function installSpec(r) {
        var spec = typeof r === 'string' ? r : r.spec
        // Community-tier (not registry-verified) installs run third-party code
        // from GitHub — get explicit consent before pulling it.
        if (r && typeof r === 'object' && r.source === 'hub' && r.tier !== 'verified') {
          if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('confirmInstall'))) return
        }
        installingPair[1](spec)
        installDonePair[1](null)
        fetch('/api/market/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spec: spec }),
        })
          .then(function (res) { return res.json() })
          .then(function (data) {
            installDonePair[1]({ ok: !!data.ok, spec: spec, output: data.output || data.error || '' })
            if (data.ok) loadInstalled()
          })
          .catch(function (err) {
            installDonePair[1]({ ok: false, spec: spec, output: String(err && err.message ? err.message : err) })
          })
          .then(function () { installingPair[1]('') })
      }

      var searchSection = h('div', null,
        h('h3', { style: S.heading }, t('searchTitle')),
        h('div', { style: S.row },
          h('select', {
            style: S.select, value: sourcePair[0],
            onChange: function (e) { sourcePair[1](e.currentTarget.value) },
          },
            h('option', { value: 'hub' }, 'Hub'),
            h('option', { value: 'npm' }, 'npm'),
            h('option', { value: 'github' }, 'GitHub')
          ),
          h('input', {
            style: S.input, type: 'search', value: queryPair[0],
            placeholder: t('searchPlaceholder'),
            onChange: function (e) { queryPair[1](e.currentTarget.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') runSearch() },
          }),
          h('button', { style: S.btn, disabled: searchingPair[0], onClick: runSearch },
            searchingPair[0] ? '…' : t('searchBtn')),
          h('label', { style: Object.assign({}, S.dim, { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }) },
            h('input', {
              type: 'checkbox', checked: strictPair[0],
              onChange: function (e) { strictPair[1](e.currentTarget.checked) },
            }),
            sourcePair[0] === 'hub' ? t('onlyCurated') : t('onlyDsh'))
        ),
        installDonePair[0]
          ? h('div', { style: { marginTop: 8 } },
              installDonePair[0].ok
                ? h('div', { style: S.notice }, t('restartNotice'))
                : h('div', { style: S.error }, installDonePair[0].spec + ' 安装失败'),
              installDonePair[0].output
                ? h('pre', { style: S.output }, installDonePair[0].output.slice(-2000))
                : null)
          : null,
        resultsPair[0] && resultsPair[0].error
          ? h('div', { style: Object.assign({ marginTop: 8 }, S.error) }, resultsPair[0].error)
          : null,
        resultsPair[0] && resultsPair[0].rows
          ? h('div', { style: { marginTop: 10 } },
              resultsPair[0].rows.length === 0
                ? h('p', { style: S.dim }, t('empty'))
                : [
                    typeof resultsPair[0].total === 'number' && resultsPair[0].total > resultsPair[0].rows.length
                      ? h('p', { key: 'count', style: Object.assign({ margin: '0 0 8px' }, S.dim) },
                          t('showing') + ' ' + resultsPair[0].rows.length + ' ' + t('of') + ' ' + resultsPair[0].total)
                      : null,
                    resultsPair[0].rows.map(function (r) {
                      var key = r.id || r.spec || r.name
                      return h(SearchRow, {
                        key: key, result: r, t: t,
                        busy: !!r.spec && installingPair[0] === r.spec,
                        onInstall: installSpec,
                      })
                    }),
                  ])
          : null
      )

      var installedSection = h('div', null,
        h('h3', { style: S.heading }, t('installedTitle') +
          (installed.status === 'ready' ? ' · ' + installed.plugins.length : '')),
        installed.status === 'loading' ? h('p', { style: S.dim }, '…') : null,
        installed.status === 'error'
          ? h('div', { style: S.row },
              h('span', { style: S.dim }, t('loadFailed')),
              h('button', { style: S.btn, onClick: loadInstalled }, t('retry')))
          : null,
        installed.status === 'ready'
          ? installed.plugins.map(function (p) {
              return h(InstalledCard, { key: p.moduleName, plugin: p, t: t })
            })
          : null
      )

      return h('div', { style: S.section }, searchSection, installedSection)
    }

    exports.apply = function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-gui-market: dictionaries')
      var t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.plugins.tab', function () {
        return ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'market',
          order: 20,
          label: function () { return t('tab') },
          locale: NS,
          inject: function () { return {} },
        }, MarketTab)
      })
    }

    return exports
  },
})
