/**
 * dsh-gui-import — Node half.
 *
 * Cross-tool session import: scan the machine's Claude Code / Codex / pi agent
 * transcripts, and compress a chosen one (via the deployment default model)
 * into a continuation brief a fresh DSH session can pick up.
 *
 * Routes (loopback engine webserver):
 *   GET  /dsh-gui/import/sessions            recent sessions across all tools
 *   POST /dsh-gui/import/summarize {path,source}  → { summary }
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'

export const name = 'dsh-gui-import'
export const inject = ['llm']

const HOME = homedir()
const MAX_LIST = 200
const MAX_TRANSCRIPT_CHARS = 160_000
const SUMMARIZE_TIMEOUT_MS = 120_000
const SOURCE_ROOTS = {
  claude: join(HOME, '.claude', 'projects'),
  codex: join(HOME, '.codex', 'sessions'),
  pi: join(HOME, '.pi', 'agent', 'sessions'),
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function safeStat(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function listFilesRecursive(dir, depthLeft) {
  if (depthLeft < 0) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, depthLeft - 1))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/**
 * Deep-search one parsed JSONL line for chat messages. All three tools nest
 * `{role, content}` shapes somewhere in each record; this walks the structure
 * instead of special-casing per-tool schemas.
 */
function extractMessages(node, out, depthLeft = 6) {
  if (node === null || typeof node !== 'object' || depthLeft < 0) return
  const role = node.role
  if ((role === 'user' || role === 'assistant') && node.content !== undefined) {
    const text = textOfContent(node.content)
    if (text.trim() !== '') out.push({ role, text })
    return
  }
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    extractMessages(value, out, depthLeft - 1)
  }
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block.text === 'string') return block.text
      return ''
    })
    .join('\n')
}

/** First user message of a transcript, for list titles. */
function firstUserText(path, maxLines = 80) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  const lines = raw.split('\n', maxLines)
  for (const line of lines) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const found = []
    extractMessages(parsed, found)
    const user = found.find((m) => m.role === 'user')
    if (user) return user.text.slice(0, 160).replace(/\s+/g, ' ')
  }
  return ''
}

/** Header line metadata (cwd/timestamp) that codex/pi transcripts carry. */
function headerMeta(path) {
  try {
    const head = readFileSync(path, 'utf8').split('\n', 1)[0]
    const parsed = JSON.parse(head)
    return { cwd: parsed.cwd ?? parsed.payload?.cwd ?? '' }
  } catch {
    return { cwd: '' }
  }
}

/**
 * Detect the real working directory of a transcript: the first `cwd`-named
 * absolute path found in the early records that still exists on disk. Used to
 * anchor the continuation session in the same workspace.
 */
function detectCwd(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  const findCwd = (node, depthLeft = 4) => {
    if (node === null || typeof node !== 'object' || depthLeft < 0) return ''
    if (typeof node.cwd === 'string' && node.cwd.startsWith('/')) return node.cwd
    for (const value of Object.values(node)) {
      const found = findCwd(value, depthLeft - 1)
      if (found !== '') return found
    }
    return ''
  }
  for (const line of raw.split('\n', 40)) {
    if (line.trim() === '') continue
    try {
      const cwd = findCwd(JSON.parse(line))
      if (cwd !== '' && existsSync(cwd)) return cwd
    } catch {
      /* not JSON */
    }
  }
  return ''
}

function listClaudeSessions() {
  const root = SOURCE_ROOTS.claude
  if (!existsSync(root)) return []
  const out = []
  for (const project of readdirSync(root)) {
    const indexPath = join(root, project, 'sessions-index.json')
    // Project dir names are path slugs where '-' is ambiguous (both separator
    // and literal dash) — show the slug as-is rather than a wrong guess.
    const cwdGuess = project
    if (existsSync(indexPath)) {
      try {
        const index = JSON.parse(readFileSync(indexPath, 'utf8'))
        for (const entry of index.entries ?? []) {
          const stat = safeStat(entry.fullPath)
          if (!stat) continue
          out.push({
            source: 'claude',
            path: entry.fullPath,
            title: (entry.summary || entry.firstPrompt || '').slice(0, 160) || '(空会话)',
            cwd: cwdGuess,
            mtime: entry.fileMtime ?? stat.mtimeMs,
          })
        }
        continue
      } catch {
        /* fall through to directory scan */
      }
    }
    for (const file of listFilesRecursive(join(root, project), 0)) {
      const stat = safeStat(file)
      if (!stat) continue
      out.push({ source: 'claude', path: file, title: '', cwd: cwdGuess, mtime: stat.mtimeMs })
    }
  }
  return out
}

function listJsonlSessions(source) {
  const root = SOURCE_ROOTS[source]
  if (!existsSync(root)) return []
  return listFilesRecursive(root, 4).map((file) => {
    const stat = safeStat(file)
    return { source, path: file, title: '', cwd: '', mtime: stat?.mtimeMs ?? 0 }
  })
}

function listAllSessions() {
  const all = [...listClaudeSessions(), ...listJsonlSessions('codex'), ...listJsonlSessions('pi')]
  all.sort((a, b) => b.mtime - a.mtime)
  const top = all.slice(0, MAX_LIST)
  // Titles/cwd for non-claude rows need a file peek — only for the shown page.
  for (const row of top) {
    if (row.title === '') row.title = firstUserText(row.path) || '(无用户消息)'
    if (row.cwd === '' && row.source !== 'claude') row.cwd = headerMeta(row.path).cwd
  }
  return top
}

/** A transcript rendered as plain dialog, newest-biased to fit the budget. */
function renderTranscript(path) {
  const raw = readFileSync(path, 'utf8')
  const messages = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    extractMessages(parsed, messages)
  }
  const parts = messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.text}`)
  let text = parts.join('\n\n')
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the head (task framing) and the tail (latest state); drop the middle.
    const head = text.slice(0, MAX_TRANSCRIPT_CHARS * 0.3)
    const tail = text.slice(-MAX_TRANSCRIPT_CHARS * 0.7)
    text = `${head}\n\n[……中间 ${text.length - head.length - tail.length} 字符已省略……]\n\n${tail}`
  }
  return { text, messageCount: messages.length }
}

const SUMMARIZE_SYSTEM = [
  '你是会话迁移助手。下面是用户与另一个 AI 编码助手的历史对话记录。',
  '请把它压缩成一份「接续简报」，让一个全新的 AI 助手读完后能无缝接着干活。必须包含：',
  '1. 任务背景与目标（用户在做什么、为什么）',
  '2. 已完成的工作与关键产出（文件、决策、命令，具体到路径/名称）',
  '3. 重要的约定与偏好（用户明确要求过的做法、禁忌）',
  '4. 未完成事项与下一步（按优先级）',
  '5. 需要注意的坑或上下文（报错、环境细节）',
  '用中文，条目化，克制篇幅但不丢关键事实。不要编造记录里没有的内容。',
].join('\n')

/** Guard: only files inside the three known transcript roots are readable. */
function isAllowedPath(path) {
  const full = resolve(path)
  return Object.values(SOURCE_ROOTS).some((root) => full.startsWith(root + sep))
}

export function apply(ctx) {
  async function summarize(path, signal) {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) {
      throw new Error('尚未配置默认模型（设置 → 模型）')
    }
    const { text, messageCount } = renderTranscript(path)
    if (messageCount === 0) throw new Error('这份记录里没有可提取的对话消息')
    const dl = deadline(signal, SUMMARIZE_TIMEOUT_MS, 'DSH_GUI_IMPORT_TIMEOUT')
    try {
      // NOTE: no sessionId — see dsh-gui-flow: stamping a live session's id
      // routes auxiliary calls into its replay cursor and deadlocks.
      const options = deepFreeze({
        provider: selection.provider,
        model: selection.model,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'dsh-gui-import' },
          }),
        ],
        system: SUMMARIZE_SYSTEM,
        maxTokens: 4096,
        signal: dl.signal,
      })
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream(options)) {
        dl.signal.throwIfAborted()
        assembler.push(chunk)
      }
      const summary = assembler
        .blocks()
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim()
      if (summary === '') throw new Error('压缩模型返回了空内容')
      return summary
    } finally {
      dl[Symbol.dispose]?.()
    }
  }

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const disposers = [
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/dsh-gui/import/sessions',
          handler: async (_req, res) => {
            try {
              sendJson(res, 200, { sessions: listAllSessions() })
            } catch (err) {
              sendJson(res, 500, { error: err.message })
            }
          },
        }),
        httpCtx.webServer.register({
          kind: 'exact',
          path: '/dsh-gui/import/summarize',
          handler: async (req, res) => {
            let body
            try {
              body = await readBody(req)
            } catch {
              sendJson(res, 400, { error: 'invalid JSON body' })
              return
            }
            const path = String(body.path ?? '')
            if (!isAllowedPath(path)) {
              sendJson(res, 400, { error: '路径不在允许的会话目录内' })
              return
            }
            const abort = new AbortController()
            req.on('close', () => abort.abort())
            try {
              const summary = await summarize(path, abort.signal)
              sendJson(res, 200, { summary, cwd: detectCwd(path) })
            } catch (err) {
              sendJson(res, 500, { error: err.message })
            }
          },
        }),
      ]
      return () => disposers.forEach((d) => d())
    }, 'dsh-gui-import: routes')
  })
}
