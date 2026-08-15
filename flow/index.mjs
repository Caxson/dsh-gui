/**
 * dsh-gui-flow — 心流模式 (Flow Mode).
 *
 * DSH already queues messages the user sends while the agent runs (persistent
 * inbox, next-turn list). This plugin adds the missing half: at every step
 * boundary (`agent/pre-step`, right before the next model call) a lightweight
 * judge model triages the backlog —
 *   inject: guidance/corrections relevant to the work in flight are folded
 *           into THIS step's messages, seamlessly steering the agent;
 *   defer:  standalone new requests stay queued and run as their own turn.
 *
 * Fail-open by design: judge timeout, parse failure, or any error leaves the
 * engine's default behavior untouched. The agent is never blocked on the judge.
 *
 * Mounted from the 心流模式 agent preset (standard assembly + this row); the
 * judge route is configurable (judgeProvider/judgeModel) and falls back to the
 * agent's own model route.
 */

import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'

export const name = 'dsh-gui-flow'
export const inject = ['llm']

const DEFAULTS = {
  judgeProvider: undefined,
  judgeModel: undefined,
  timeoutMs: 4000,
  maxMessages: 10,
  maxCharsPerMessage: 1200,
  maxJudgeTokens: 300,
}

/** Plain text of one user message, truncated for the judge. */
function messageText(message, maxChars) {
  const content = message?.content
  const text = Array.isArray(content)
    ? content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n')
    : String(content ?? '')
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function judgeSystemPrompt() {
  return [
    'You are a triage judge inside a running coding agent.',
    'The agent is mid-task. While it works, the user typed additional messages, now queued.',
    'For EACH queued message decide:',
    '- "inject": the message steers, corrects, answers, or adds constraints/information relevant to the work currently in flight. It should enter the model context NOW.',
    '- "defer": the message is an independent new request or topic, better handled as its own turn after the current work finishes.',
    'When in doubt, prefer "inject" — users usually type because they want the agent to know now.',
    'Return ONLY a JSON array, one object per queued message, no prose:',
    '[{"i": <index>, "action": "inject" | "defer"}]',
  ].join('\n')
}

function frameJudgeInput(backlogTexts) {
  return JSON.stringify({ queued: backlogTexts.map((text, i) => ({ i, text })) })
}

/** Strict-ish parse of the judge verdict; null on anything unexpected. */
function parseVerdict(raw, count) {
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) return null
  let parsed
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const actions = new Map()
  for (const row of parsed) {
    const i = Number(row?.i)
    if (!Number.isInteger(i) || i < 0 || i >= count) continue
    actions.set(i, row.action === 'inject' ? 'inject' : 'defer')
  }
  return actions
}

async function callJudge(ctx, agent, config, backlogTexts, stepSignal) {
  const provider = config.judgeProvider ?? agent.options.provider
  const model = config.judgeModel ?? agent.options.model
  if (provider === undefined || model === undefined) return null
  const dl = deadline(stepSignal, config.timeoutMs, 'DSH_GUI_FLOW_JUDGE_TIMEOUT')
  try {
    // NOTE: no sessionId on purpose — the judge is an auxiliary call, and
    // stamping the active session's id routes it into the session's replay
    // cursor machinery while that session's own request is mid-flight.
    const options = deepFreeze({
      provider,
      model,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: frameJudgeInput(backlogTexts) }],
          source: { kind: 'plugin', plugin: 'dsh-gui-flow' },
        }),
      ],
      system: judgeSystemPrompt(),
      maxTokens: config.maxJudgeTokens,
      signal: dl.signal,
    })
    const collect = async () => {
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream(options)) {
        dl.signal.throwIfAborted()
        assembler.push(chunk)
      }
      return assembler
        .blocks()
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
    }
    // Hard stop: even if the underlying stream ignores the abort signal, the
    // agent loop must proceed. Losing one judge call is fine; hanging is not.
    let timer
    const hardStop = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('dsh-gui-flow: judge hard timeout')),
        config.timeoutMs + 1000,
      )
    })
    const pending = collect()
    pending.catch(() => {}) // the leaked loser must not surface as unhandled
    try {
      const text = await Promise.race([pending, hardStop])
      return parseVerdict(text, backlogTexts.length)
    } finally {
      clearTimeout(timer)
    }
  } finally {
    dl[Symbol.dispose]?.()
  }
}

export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...config }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision

    const { agent } = payload
    const backlog = agent.inbox.nextTurn.slice(0, resolved.maxMessages)
    if (backlog.length === 0) return decision

    let verdict
    try {
      verdict = await callJudge(
        ctx,
        agent,
        resolved,
        backlog.map((m) => messageText(m, resolved.maxCharsPerMessage)),
        payload.signal,
      )
    } catch (error) {
      ctx.logger?.warn?.('dsh-gui-flow: judge failed, passing through: %o', error)
      return decision
    }
    if (verdict === null || payload.signal.aborted) return decision

    const injected = []
    backlog.forEach((message, i) => {
      if (verdict.get(i) !== 'inject') return
      // Pull the message out of the queue and fold it into this step. remove()
      // returning false means something else (user edit/remove) already took
      // it — respect that and skip.
      if (agent.inbox.remove(message.id)) injected.push(message)
    })
    if (injected.length === 0) return decision

    ctx.logger?.info?.('dsh-gui-flow: injected %d queued message(s) into turn %d step %d', injected.length, payload.turn, payload.step)
    return { ...decision, messages: [...decision.messages, ...injected] }
  })
}
