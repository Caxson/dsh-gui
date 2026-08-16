/**
 * dsh-gui-market — hub catalog source.
 *
 * A community-maintained, versioned index of dsh-ecosystem plugins. It carries
 * human-written descriptions, categories, pinned commit refs and per-entry
 * installability evidence — richer and less lossy than a raw GitHub topic
 * scrape. The domestic mirror is tried first so users behind the GFW get a
 * fast, proxy-free hit; the overseas primary is a fallback.
 *
 * Exposes one function, searchHub(query, strict), returning { rows, total }.
 */

import { createRequire } from 'node:module'

const selfRequire = createRequire(import.meta.url)

const HUB_ORIGINS = ['https://hub.0.org.cn', 'https://hub.omdsh.dev']
const CATALOG_PATH = '/catalog.json'
const CATALOG_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000
const HUB_MAX_ROWS = 80
// Kinds our `dsh plugin add` path can actually mount (profile-bundle plugins).
// mcp/skill install through their own protocol managers, not us.
const HUB_PLUGIN_KINDS = new Set(['extension', 'ui', 'toolkit', 'adapter', 'channel'])

let catalogCache = { at: 0, data: null }

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

/** CN mirror → plain fetch (no proxy); overseas primary → proxy-aware. */
function fetchOrigin(origin, signal) {
  const url = origin + CATALOG_PATH
  let host = ''
  try {
    host = new URL(origin).hostname
  } catch {
    /* malformed origin — treat as overseas */
  }
  return host.endsWith('.cn') ? fetch(url, { signal }) : proxiedFetch(url, { signal })
}

async function fetchCatalog(now) {
  if (catalogCache.data && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data
  let lastError = 'hub unreachable'
  for (const origin of HUB_ORIGINS) {
    try {
      const res = await fetchOrigin(origin, AbortSignal.timeout(FETCH_TIMEOUT_MS))
      if (!res.ok) {
        lastError = `hub ${origin} HTTP ${res.status}`
        continue
      }
      const data = await res.json()
      const packages = Array.isArray(data?.packages) ? data.packages : []
      if (packages.length === 0) {
        lastError = `hub ${origin} returned no packages`
        continue
      }
      catalogCache = { at: now, data: packages }
      return packages
    } catch (err) {
      lastError = `hub ${origin}: ${err.message}`
    }
  }
  if (catalogCache.data) return catalogCache.data // stale-but-serviceable beats nothing
  throw new Error(lastError)
}

/** "https://github.com/owner/repo(.git)" → "owner/repo". */
function ownerRepo(repository) {
  const m = /github\.com[/:]([^/]+\/[^/#?]+)/i.exec(repository || '')
  return m ? m[1].replace(/\.git$/i, '') : null
}

/** Map a catalog entry to a search row, deciding installability honestly. */
export function mapHubEntry(e) {
  const repo = ownerRepo(e.repository)
  // Installable via us only when it is a profile-bundle plugin living at the
  // repo root (a repositoryPath means a monorepo subdir our github spec can't
  // target) with a pinned ref to reproduce.
  const installable = Boolean(repo) && !e.repositoryPath && HUB_PLUGIN_KINDS.has(e.kind) && Boolean(e.ref)
  const verified = e.workshop?.manifest?.status === 'valid'
  return {
    id: e.id || e.repository || e.name,
    name: e.name || repo || '(unnamed)',
    description: e.description || '',
    version: e.version || '',
    url: e.repository || '',
    source: 'hub',
    spec: installable ? `github:${repo}#${e.ref}` : '',
    installable,
    // Registry (the signed, one-click tier) currently admits nobody, so the
    // installable set is community self-install: pinned ref + explicit consent.
    tier: verified ? 'verified' : 'community',
    kind: e.kind || '',
    category: e.category || '',
    tags: Array.isArray(e.tags) ? e.tags.slice(0, 4) : [],
    featured: Boolean(e.featured),
    note: installable
      ? ''
      : e.repositoryPath
        ? 'monorepo 子目录，需手动安装'
        : e.kind === 'mcp'
          ? 'MCP，按其说明接入'
          : e.kind === 'skill'
            ? 'Skill，按其说明接入'
            : '仅查看源码',
  }
}

/**
 * @param {string} query   free-text filter over name/description/category/tags
 * @param {boolean} strict  curated only (featured / registry-verified)
 * @param {number} [now]    injectable clock for tests (defaults to Date.now())
 */
export async function searchHub(query, strict, now = Date.now()) {
  const packages = await fetchCatalog(now)
  const q = (query || '').trim().toLowerCase()
  const listAll = q === '' || q === 'dsh-plugin'
  let rows = packages.map(mapHubEntry)
  if (strict) rows = rows.filter((r) => r.featured || r.tier === 'verified')
  if (!listAll) {
    rows = rows.filter((r) => {
      const hay = `${r.name} ${r.description} ${r.category} ${r.tags.join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }
  const total = rows.length
  rows.sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name))
  return { rows: rows.slice(0, HUB_MAX_ROWS), total }
}
