/**
 * dsh-gui-market — Node half.
 *
 * The plugin market DSH never had. Serves three loopback routes the browser
 * half (Settings → 插件 → 市场 tab) consumes:
 *   GET  /api/market/installed  loader entries joined with each module's
 *                               package.json (description/version/repository)
 *   GET  /api/market/search     GitHub / npm registry search proxied through
 *                               Node (no browser CORS, proxy-aware)
 *   POST /api/market/install    forwards to the engine's own `dsh plugin add`
 *                               (pnpm underneath), so github:/npm specs both work
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-gui-market'
export const inject = ['webServer', 'loader']

const SEARCH_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 300_000
// Conservative allowlist for install specs: npm names, github:owner/repo(#ref),
// git+https urls. Anything else (flags, paths, shell metachars) is rejected.
const SPEC_RE = /^(@?[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)?(@[\w.^~<>=-]+)?|github:[\w.-]+\/[\w.-]+(#[\w./-]+)?|git\+https:\/\/[\w./@:-]+)$/i

const selfRequire = createRequire(import.meta.url)

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** Proxy-aware fetch: honors HTTPS_PROXY when undici is resolvable. */
function proxiedFetch(url, options = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxy) {
    try {
      const { ProxyAgent } = selfRequire('undici')
      return fetch(url, { ...options, dispatcher: new ProxyAgent(proxy) })
    } catch {
      /* undici not resolvable — plain fetch below */
    }
  }
  return fetch(url, options)
}

/** package.json lookup for an installed module, profile first then app. */
function makeMetadataResolver() {
  const anchors = []
  const dshHome = process.env.DSH_HOME
  if (dshHome) {
    try {
      anchors.push(createRequire(join(dshHome, 'profiles', 'web', 'noop.js')))
    } catch {
      /* profile dir missing — app anchor still applies */
    }
  }
  anchors.push(selfRequire)
  const cache = new Map()
  return (moduleName) => {
    if (cache.has(moduleName)) return cache.get(moduleName)
    let meta = null
    for (const anchor of anchors) {
      try {
        const pkg = anchor(`${moduleName}/package.json`)
        const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
        meta = {
          description: pkg.description ?? '',
          version: pkg.version ?? '',
          repository: (repo ?? '').replace(/^git\+/, '').replace(/\.git$/, ''),
          homepage: pkg.homepage ?? '',
        }
        break
      } catch {
        /* not resolvable from this anchor */
      }
    }
    cache.set(moduleName, meta)
    return meta
  }
}

async function searchNpm(query) {
  const q = encodeURIComponent(query)
  const endpoints = [
    `https://registry.npmmirror.com/-/v1/search?text=${q}&size=20`,
    `https://registry.npmjs.org/-/v1/search?text=${q}&size=20`,
  ]
  let lastError = 'npm search failed'
  for (const url of endpoints) {
    try {
      const res = await proxiedFetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) })
      if (!res.ok) {
        lastError = `npm search HTTP ${res.status}`
        continue
      }
      const data = await res.json()
      return (data.objects ?? []).map((o) => ({
        name: o.package?.name ?? '',
        description: o.package?.description ?? '',
        version: o.package?.version ?? '',
        url: o.package?.links?.repository || o.package?.links?.npm || '',
        spec: o.package?.name ?? '',
        source: 'npm',
      }))
    } catch (err) {
      lastError = err.message
    }
  }
  throw new Error(lastError)
}

async function searchGithub(query) {
  const q = encodeURIComponent(`${query} in:name,description,topics`)
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=20`
  const res = await proxiedFetch(url, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-gui-market' },
  })
  if (!res.ok) throw new Error(`GitHub search HTTP ${res.status}`)
  const data = await res.json()
  return (data.items ?? []).map((r) => ({
    name: r.full_name ?? '',
    description: r.description ?? '',
    stars: r.stargazers_count ?? 0,
    url: r.html_url ?? '',
    spec: `github:${r.full_name}`,
    source: 'github',
  }))
}

/** Dedup search rows by install spec, keeping first (highest-ranked) hit. */
function dedupe(rows) {
  const seen = new Set()
  return rows.filter((r) => {
    if (!r.spec || seen.has(r.spec)) return false
    seen.add(r.spec)
    return true
  })
}

/** dsh-ecosystem filter: keep rows that plausibly belong to the DSH world. */
function dshOnly(rows) {
  const re = /\bdsh\b|dsh-|deepseek/i
  return rows.filter((r) => re.test(`${r.name} ${r.description}`))
}

export function apply(ctx) {
  const resolveMetadata = makeMetadataResolver()
  let installing = false

  function listInstalled() {
    const groups = new Map()
    for (const entry of ctx.loader.entries()) {
      if (entry.options.group) continue
      const moduleName = entry.options.name
      let g = groups.get(moduleName)
      if (!g) {
        g = {
          moduleName,
          builtin: moduleName.startsWith('cordis:'),
          instances: [],
          ...(resolveMetadata(moduleName) ?? {}),
        }
        groups.set(moduleName, g)
      }
      g.instances.push({ entryId: entry.id, enabled: !entry.disabled })
    }
    return [...groups.values()]
  }

  /**
   * The engine's `dsh plugin add` shells out to `pnpm`. When pnpm isn't on
   * PATH but corepack is (default Node installs), synthesize a pnpm shim that
   * delegates to corepack so installs work out of the box.
   */
  function ensurePnpmEnv() {
    const env = { ...process.env, NO_COLOR: '1' }
    if (!spawnSync('pnpm', ['--version']).error) return env
    const corepack = spawnSync('corepack', ['--version'])
    if (corepack.error) return null
    const shimDir = join(tmpdir(), 'dsh-gui-market-pnpm-shim')
    const shim = join(shimDir, 'pnpm')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(shim, '#!/bin/sh\nexec corepack pnpm "$@"\n')
    chmodSync(shim, 0o755)
    env.PATH = `${shimDir}:${env.PATH ?? ''}`
    env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    if (!env.COREPACK_NPM_REGISTRY) env.COREPACK_NPM_REGISTRY = 'https://registry.npmmirror.com'
    return env
  }

  function runInstall(spec) {
    return new Promise((resolve) => {
      const env = ensurePnpmEnv()
      if (env === null) {
        resolve({ ok: false, output: '未找到 pnpm（也没有 corepack 可兜底）。请先安装：npm install -g pnpm' })
        return
      }
      const binJs = selfRequire.resolve('@deepseek-ai/dsh/lib/bin.js')
      const child = spawn(process.execPath, [binJs, 'plugin', '--profile', 'web', 'add', spec], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const collect = (chunk) => {
        output += chunk.toString()
        if (output.length > 20_000) output = output.slice(-20_000)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve({ ok: false, output: `${output}\n[安装超时（${INSTALL_TIMEOUT_MS / 1000}s），已中止]` })
      }, INSTALL_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, output: `${output}\n[启动安装进程失败: ${err.message}]` })
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ ok: code === 0, output })
      })
    })
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/market/installed',
    handler: (_req, res) => {
      try {
        sendJson(res, 200, { plugins: listInstalled() })
      } catch (err) {
        sendJson(res, 500, { error: err.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/market/search',
    handler: async (req, res) => {
      const params = new URL(req.url, 'http://x').searchParams
      const source = params.get('source') === 'github' ? 'github' : 'npm'
      const strict = params.get('strict') !== '0'
      const query = (params.get('q') ?? '').trim() || 'dsh-plugin'
      try {
        const rows = source === 'github' ? await searchGithub(query) : await searchNpm(query)
        const deduped = dedupe(rows)
        sendJson(res, 200, { results: strict ? dshOnly(deduped) : deduped })
      } catch (err) {
        sendJson(res, 502, { error: `搜索失败: ${err.message}` })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/market/install',
    handler: async (req, res) => {
      let body
      try {
        body = await readBody(req)
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const spec = String(body.spec ?? '').trim()
      if (!SPEC_RE.test(spec)) {
        sendJson(res, 400, { error: `不支持的安装源写法: ${spec}` })
        return
      }
      if (installing) {
        sendJson(res, 409, { error: '已有安装任务在进行中' })
        return
      }
      installing = true
      try {
        const result = await runInstall(spec)
        sendJson(res, result.ok ? 200 : 500, result)
      } finally {
        installing = false
      }
    },
  })
}
