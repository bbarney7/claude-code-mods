import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, AgentState, External, Mode, RoomMessage, Run, Speaker } from '../types'

const PANE = 'second-opinion'
const ROOM_PANE = 'agent-room'
const MAX_DIFF = 150_000
const TAIL = 4_000
const HOP_BUDGET = 3
const HISTORY_ITEMS = 12
const HISTORY_CHARS = 8_000

const runs = atom({ plugin: 'second-opinion', key: 'runs' } as const, [])
const now = atom({ plugin: 'second-opinion', key: 'now' } as const, 0)
const room = atom({ plugin: 'second-opinion', key: 'room' } as const, {
  messages: [],
  status: { codex: 'idle', cursor: 'idle', claude: 'idle' },
  detail: '',
  permissions: [],
  defaultAgent: 'codex',
})

const EXTERNAL: External[] = ['codex', 'cursor']
const AGENTS: Agent[] = ['codex', 'cursor', 'claude']
const ALL_IDLE: Record<Agent, AgentState> = { codex: 'idle', cursor: 'idle', claude: 'idle' }
const LABEL: Record<Speaker, string> = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude', main: 'Main session', you: 'You', system: '·' }
const COLOR: Record<Speaker, string> = { codex: 'green', cursor: 'magenta', claude: 'yellow', main: 'blue', you: 'cyan', system: 'gray' }

// ---------- how much context crosses between Claude's session and the room (/config) ----------

export type SeedMode = 'none' | 'recent' | 'summary' | 'full'
export type ReturnMode = 'message' | 'recent' | 'summary' | 'full'
export type ContextConfig = { roomSeed: SeedMode; roomSeedTurns: number; claudeReturn: ReturnMode; claudeReturnMessages: number }
export const DEFAULT_CONFIG: ContextConfig = { roomSeed: 'recent', roomSeedTurns: 10, claudeReturn: 'message', claudeReturnMessages: 8 }

const SEED_MODES: readonly SeedMode[] = ['none', 'recent', 'summary', 'full']
const RETURN_MODES: readonly ReturnMode[] = ['message', 'recent', 'summary', 'full']

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(200, Math.max(1, Math.round(value))) : fallback
}

// The manifest's userConfig values, as register() receives them; anything off falls back to the default.
export function readConfig(options: Readonly<Record<string, unknown>>): ContextConfig {
  const seed = options.roomSeed as SeedMode
  const back = options.claudeReturn as ReturnMode
  return {
    roomSeed: SEED_MODES.includes(seed) ? seed : DEFAULT_CONFIG.roomSeed,
    roomSeedTurns: count(options.roomSeedTurns, DEFAULT_CONFIG.roomSeedTurns),
    claudeReturn: RETURN_MODES.includes(back) ? back : DEFAULT_CONFIG.claudeReturn,
    claudeReturnMessages: count(options.claudeReturnMessages, DEFAULT_CONFIG.claudeReturnMessages),
  }
}

const SEED_SUMMARY_PROMPT = [
  'Another coding agent (OpenAI Codex, Cursor, or a second Claude) is joining a side chat about this work and has not seen this conversation.',
  'Write it a briefing of at most 250 words: the goal, what has been decided or done, the current state, open questions, and the files that matter.',
  'Short prose and bullets. Reply with the briefing only.',
].join(' ')

const RETURN_SUMMARY_SYSTEM =
  'You summarize a group chat between a developer and coding agents (Codex, Cursor, a separate Claude) for the main Claude Code session, which was not in it. ' +
  'At most 200 words: what was asked, what each agent concluded, disagreements, and anything still open. Reply with the summary only.'

// ---------- one-shot runs: /second-opinion reviews and /delegate implementations ----------

export function argvFor(agent: External, mode: Mode, prompt: string): string[] {
  if (agent === 'codex') {
    const sandbox = mode === 'review' ? 'read-only' : 'workspace-write'
    return ['codex', 'exec', prompt, '-s', sandbox, '--skip-git-repo-check']
  }
  const access = mode === 'review' ? ['--mode', 'ask'] : ['--force']
  return ['cursor-agent', '-p', prompt, ...access, '--trust', '--output-format', 'text']
}

export function reviewPrompt(diff: string, focus: string): string {
  const cut = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff cut at ${MAX_DIFF} characters]` : diff
  return [
    'You are reviewing a code change another AI coding agent (Claude Code) just made.',
    'Read the surrounding files in this repository when you need context. Do not modify any files.',
    'Report only real problems: bugs, regressions, security issues, unhandled edge cases, missing tests for risky logic.',
    'For each one give file:line, what is wrong, and a concrete fix. Skip style nits. If the change is sound, say so in one line.',
    focus ? `\nExtra focus from the developer: ${focus}` : '',
    '\n```diff',
    cut,
    '```',
  ].join('\n')
}

export function implementPrompt(task: string): string {
  return [
    task,
    '',
    'Make the change directly in this repository. Keep it scoped to the task and match the surrounding code style.',
    'When you finish, reply with a short summary: the files you changed and anything you could not do.',
  ].join('\n')
}

// "/second-opinion", "/second-opinion codex", "/second-opinion both focus on auth" -> agents + focus text
export function parseReview(args: string): { agents: External[]; focus: string } {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const word = first.toLowerCase()
  if (word === 'codex' || word === 'cursor') return { agents: [word], focus: rest.join(' ') }
  if (word === 'both') return { agents: EXTERNAL, focus: rest.join(' ') }
  return { agents: EXTERNAL, focus: args.trim() }
}

// "/delegate cursor add a --verbose flag" -> agent + task
export function parseDelegate(args: string): { agent: External; task: string } | { error: string } {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const word = first.toLowerCase()
  if (word !== 'codex' && word !== 'cursor') return { error: 'Usage: /delegate <codex|cursor> <task>' }
  const task = rest.join(' ').trim()
  if (!task) return { error: 'Usage: /delegate <codex|cursor> <task>' }
  return { agent: word, task }
}

// ---------- the room: who a message is for, and what each agent is told ----------

// @mentions of room members, in order, once each. Code spans and fences are quotes, not
// mentions: writing `@codex` talks about Codex rather than to it (Syntaur's rule).
export function parseMentions(text: string): Speaker[] {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const found: Speaker[] = []
  for (const match of prose.matchAll(/(^|\s)@(codex|cursor|claude|main)\b/gi)) {
    const who = (match[2] ?? '').toLowerCase() as Speaker
    if (!found.includes(who)) found.push(who)
  }
  return found
}

// "/ask codex hi" reads as "@codex hi"; anything else is the message as typed.
export function normalizeAsk(args: string): string {
  const trimmed = args.trim()
  const [first = '', ...rest] = trimmed.split(/\s+/)
  const word = first.toLowerCase()
  if (word === 'codex' || word === 'cursor' || word === 'claude') return `@${word} ${rest.join(' ')}`.trim()
  return trimmed
}

// A message's targets: the room agents it mentions (else the room's default agent), and
// whether it also @mentions the main session.
export function targetsOf(text: string, fallback: Agent): { agents: Agent[]; toMain: boolean } {
  const mentioned = parseMentions(text)
  const agents = mentioned.filter((who): who is Agent => who === 'codex' || who === 'cursor' || who === 'claude')
  const toMain = mentioned.includes('main')
  return { agents: agents.length || toMain ? agents : [fallback], toMain }
}

// What the others said since this agent last spoke, newest kept: 12 items, 8,000 characters.
// A fresh session (first turn, or after a reload restarted the adapters) remembers nothing,
// so it gets the whole room, its own earlier replies included.
export function historyFor(messages: RoomMessage[], agent: Agent, triggerId: string, isFresh = false): string {
  let lastOwn = -1
  messages.forEach((message, i) => {
    if (message.from === agent) lastOwn = i
  })
  const others = messages
    .slice(isFresh ? 0 : lastOwn + 1)
    .filter(m => m.id !== triggerId && (isFresh || m.from !== agent) && m.from !== 'system' && !m.isStreaming && m.text.trim())
  const kept: string[] = []
  let size = 0
  for (const message of [...others].reverse()) {
    const line = `<chat-event author="${authorTag(message.from)}">${message.text}</chat-event>`
    if (kept.length >= HISTORY_ITEMS || size + line.length > HISTORY_CHARS) break
    kept.unshift(line)
    size += line.length
  }
  const dropped = others.length - kept.length
  if (kept.length === 0) return ''
  return ['<chat-history>', dropped > 0 ? `(${dropped} earlier messages left out)` : '', ...kept, '</chat-history>']
    .filter(Boolean)
    .join('\n')
}

export type SessionTurn = { role: 'user' | 'assistant'; text: string; toolUses: readonly { tool: string }[] }

// The tail of the Claude Code conversation the room was opened from, for a fresh agent session:
// what you and Claude said and which tools Claude used, newest kept within maxTurns / maxChars.
// Tool output, system reminders and the room's own relays to Claude stay out.
export function sessionExcerpt(messages: readonly SessionTurn[], maxTurns = 10, maxChars = 6_000, clipEach = 1_500): string {
  const lines: string[] = []
  let size = 0
  for (const message of [...messages].reverse()) {
    const words = message.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    const tools = [...new Set(message.toolUses.map(use => use.tool))]
    if (!words && tools.length === 0) continue
    if (words.includes('said in the agent room')) continue
    const clipped = words.length > clipEach ? `${words.slice(0, clipEach)}…` : words
    const used = tools.length ? `${clipped ? '\n' : ''}[tools used: ${tools.join(', ')}]` : ''
    const line = `${message.role === 'user' ? 'Human' : 'Claude'}: ${clipped}${used}`
    if (lines.length >= maxTurns || size + line.length > maxChars) break
    lines.unshift(line)
    size += line.length
  }
  if (lines.length === 0) return ''
  return ['<claude-session>', '(the recent Claude Code conversation this room was opened from)', ...lines, '</claude-session>'].join('\n')
}

// The room as plain lines for Claude, newest kept within limit / maxChars; routing rows and
// replies still streaming stay out.
export function roomTranscript(messages: readonly RoomMessage[], limit: number, maxChars: number): string {
  const lines: string[] = []
  let size = 0
  for (const message of [...messages].reverse()) {
    if (message.from === 'system' || message.isStreaming || !message.text.trim()) continue
    const text = message.text.length > 3_000 ? `${message.text.slice(0, 3_000)}…` : message.text
    const line = `${LABEL[message.from]}: ${text}`
    if (lines.length >= limit || size + line.length > maxChars) break
    lines.unshift(line)
    size += line.length
  }
  return lines.join('\n\n')
}

function authorTag(from: Speaker): string {
  if (from === 'you') return 'human'
  return `agent:${from}`
}

export function framePrompt(
  agent: Agent,
  isFirst: boolean,
  history: string,
  trigger: RoomMessage,
  hop: number,
  cwd: string,
  sessionContext = '',
): string {
  const system = isFirst
    ? [
        '<system>',
        `You are @${agent} (${LABEL[agent]}) in a group chat that lives inside Claude Code.`,
        'Participants: @you is the human developer; @main is the main Claude Code session that opened this room;',
        '@claude is a separate Claude agent in the room; @codex is OpenAI Codex; @cursor is the Cursor agent. You are one of them.',
        `You can read the repository at ${cwd}. Edits and commands may need the human's approval.`,
        'Your reply goes back to whoever addressed you on its own; do not @mention them to answer.',
        'To bring in a different participant, @mention them in your reply and they get a turn.',
        'Only @mention someone when you want them to act. Keep replies short and concrete.',
        '</system>',
        '',
      ].join('\n')
    : ''
  const handoff = hop > 0 ? `(@${trigger.from} handed this to you: hop ${hop} of ${HOP_BUDGET})\n` : ''
  const session = isFirst && sessionContext ? `${sessionContext}\n` : ''
  return `${system}${session}${history ? `${history}\n` : ''}${handoff}<chat-event author="${authorTag(trigger.from)}">${trigger.text}</chat-event>`
}

// Who a finished reply wakes: the participants it @mentions, never its own author, the human
// (who reads the room anyway) or whoever asked (the reply is already their answer).
export function handoffTargets(reply: RoomMessage, askedBy: Speaker | undefined): Speaker[] {
  return parseMentions(reply.text).filter(who => who !== reply.from && who !== 'you' && who !== 'system' && who !== askedBy)
}

// A handed-off reply that only thanks or acknowledges ends the chain instead of looping.
export function isBareAck(text: string): boolean {
  const words = text.replace(/@\w+/g, '').trim()
  return words.length < 40 && /^(thanks|thank you|ok|okay|got it|sounds good|agreed|will do|👍)/i.test(words)
}

// ---------- module state (starts over on a reload; the room's messages are the host's) ----------

let seq = 0
let ticker: { cancel: () => void } | undefined
let bridge: { socket: string; ready: Promise<boolean>; markReady: (ok: boolean) => void } | undefined
let cwd = ''
const primed = new Set<Agent>()
const hops = new Map<string, number>()
const askedBy = new Map<string, Speaker>()
const buffered = new Map<string, string>()
let flushTimer: { cancel: () => void } | undefined
let config: ContextConfig = DEFAULT_CONFIG
let seedSummary: { turns: number; text: string } | undefined

// ---------- one-shot runs (unchanged from 0.1) ----------

function seconds(run: Run, at: number): string {
  const s = Math.max(0, Math.round(((run.endedAt ?? at) - run.startedAt) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

function patch($: EngineInterface, id: string, fn: (run: Run) => Run) {
  return update($, runs, list => list.map(run => (run.id === id ? fn(run) : run)))
}

// Redraw the elapsed timers once a second while a run is going.
async function tick($: EngineInterface) {
  await update($, now, () => 0)
  if (ticker) return
  ticker = $.clock.every(1000, async () => {
    const list = await read($, runs)
    const at = await $.clock.now()
    await update($, now, () => at)
    if (!list.some(run => run.status === 'running')) {
      ticker?.cancel()
      ticker = undefined
    }
  })
}

async function runAgent($: EngineInterface, agent: External, mode: Mode, task: string, prompt: string): Promise<Run> {
  seq += 1
  const id = `${agent}-run-${seq}`
  const run: Run = { id, agent, mode, task, status: 'running', startedAt: await $.clock.now(), tail: '' }
  await update($, runs, list => [run, ...list].slice(0, 8))
  await tick($)

  let stdout = ''
  let ended: { code: number | null } = { code: null }
  try {
    const child = $.process.spawn({ argv: argvFor(agent, mode, prompt) })
    while (true) {
      const step = await child.next()
      if (step.done) {
        ended = step.value
        break
      }
      const { stream, text } = step.value
      if (stream === 'stdout') stdout += text
      await patch($, id, one => ({ ...one, tail: (one.tail + text).slice(-TAIL) }))
    }
  } catch (error) {
    stdout = `Could not start ${argvFor(agent, mode, '…')[0]}: ${String(error)}`
  }

  const ok = ended.code === 0 && stdout.trim() !== ''
  const result = stdout.trim() || lastLines(await read($, runs), id) || '(no output)'
  const endedAt = await $.clock.now()
  await patch($, id, one => ({ ...one, status: ok ? 'done' : 'failed', endedAt, result }))
  $.ui.toast(`${LABEL[agent]} ${mode === 'review' ? 'review' : 'implementation'} ${ok ? 'finished' : 'failed'}`)
  return { ...run, status: ok ? 'done' : 'failed', endedAt, result }
}

async function changesToReview($: EngineInterface): Promise<{ diff: string; what: string }> {
  const uncommitted = await $.process.run(['git', 'diff', 'HEAD'])
  if (uncommitted.exitCode === 0 && uncommitted.stdout.trim()) {
    return { diff: uncommitted.stdout, what: 'uncommitted changes' }
  }
  const last = await $.process.run(['git', 'show', 'HEAD', '--format=commit %H%n%s%n'])
  if (last.exitCode === 0 && last.stdout.trim()) return { diff: last.stdout, what: 'the last commit' }
  return { diff: '', what: '' }
}

function lastLines(list: Run[], id: string): string {
  return list.find(run => run.id === id)?.tail.trim().split('\n').slice(-15).join('\n') ?? ''
}

// ---------- the bridge: one node process holding the ACP adapters for this session ----------

async function ensureBridge($: EngineInterface): Promise<string | undefined> {
  if (!bridge) {
    let markReady: (ok: boolean) => void = () => {}
    const ready = new Promise<boolean>(resolve => (markReady = resolve))
    const socket = `/tmp/second-opinion-${crypto.randomUUID().slice(0, 8)}.sock`
    bridge = { socket, ready, markReady }
    cwd = await $.session.root()
    primed.clear()
    void readBridge($, socket)
    $.clock.after(15_000, () => bridge?.markReady(false))
  }
  return (await bridge.ready) ? bridge.socket : undefined
}

// The bridge's stdout is its event stream; this loop lives as long as the bridge does.
async function readBridge($: EngineInterface, socket: string) {
  const argv = ['node', `${$.plugin.root}/bridge/acp-bridge.mjs`, '--socket', socket, '--cwd', cwd]
  let pending = ''
  let stderr = ''
  try {
    for await (const piece of $.process.spawn({ argv })) {
      if (piece.stream === 'stderr') {
        stderr = (stderr + piece.text).slice(-2000)
        continue
      }
      pending += piece.text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          await onBridgeEvent($, JSON.parse(line))
        } catch (error) {
          $.ui.log(`second-opinion: bad bridge line: ${String(error)}`, { to: 'debug' })
        }
      }
    }
  } catch (error) {
    stderr += String(error)
  }
  bridge?.markReady(false)
  bridge = undefined
  await update($, room, r => ({
    ...r,
    status: ALL_IDLE,
    permissions: [],
    detail: stderr.trim() ? `bridge stopped: ${stderr.trim().split('\n').pop()}` : r.detail,
    messages: r.messages.map(m => (m.isStreaming ? { ...m, isStreaming: false, isError: true, text: m.text || '(the bridge stopped)' } : m)),
  }))
}

async function bridgePost($: EngineInterface, path: string, body: Record<string, unknown>) {
  const socket = await ensureBridge($)
  if (!socket) throw new Error('the agent bridge did not start (is node on PATH?)')
  const response = await $.http.fetch(`http://bridge${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: socket,
  })
  if (!response.ok) throw new Error(`bridge ${path}: ${response.status} ${response.text}`)
  return JSON.parse(response.text || '{}') as Record<string, unknown>
}

type BridgeEvent =
  | { type: 'listening' }
  | { type: 'status'; agent: Agent; state: AgentState; detail?: string }
  | { type: 'chunk'; agent: Agent; turn: string; text: string }
  | { type: 'tool'; agent: Agent; turn: string; id: string; title?: string; status?: string }
  | { type: 'turn_end'; agent: Agent; turn: string; stopReason: string }
  | { type: 'turn_error'; agent: Agent; turn: string; message: string }
  | { type: 'permission'; agent: Agent; id: string; title: string; options: { optionId: string; name: string; kind: string }[] }
  | { type: 'log'; message: string }

async function onBridgeEvent($: EngineInterface, event: BridgeEvent) {
  switch (event.type) {
    case 'listening':
      bridge?.markReady(true)
      return
    case 'status':
      await update($, room, r => ({
        ...r,
        status: { ...r.status, [event.agent]: event.state },
        detail: event.state === 'error' ? `${LABEL[event.agent]}: ${event.detail ?? 'failed'}` : r.detail,
      }))
      return
    case 'chunk':
      buffered.set(event.turn, (buffered.get(event.turn) ?? '') + event.text)
      // Codex streams token-sized pieces: draw them in batches, not one redraw per token.
      flushTimer ??= $.clock.after(120, () => {
        flushTimer = undefined
        void flushChunks($)
      })
      return
    case 'tool':
      await patchMessage($, event.turn, m => {
        const tools = [...(m.tools ?? [])]
        const at = tools.findIndex(t => t.id === event.id)
        const title = event.title ?? tools[at]?.title ?? 'tool'
        const status = event.status ?? tools[at]?.status ?? ''
        if (at >= 0) tools[at] = { id: event.id, title, status }
        else tools.push({ id: event.id, title, status })
        return { ...m, tools }
      })
      return
    case 'turn_end':
    case 'turn_error': {
      await flushChunks($)
      const isError = event.type === 'turn_error'
      await patchMessage($, event.turn, m => ({
        ...m,
        isStreaming: false,
        isError,
        text: isError ? `${m.text}${m.text ? '\n\n' : ''}⚠ ${event.message}` : m.text || '(no reply)',
      }))
      const done = (await read($, room)).messages.find(m => m.id === event.turn)
      if (done && !isError) await routeReply($, done)
      return
    }
    case 'permission':
      await update($, room, r => ({ ...r, permissions: [...r.permissions, event] }))
      $.ui.toast(`${LABEL[event.agent]} asks: ${event.title}`)
      return
    case 'log':
      $.ui.log(`second-opinion bridge: ${event.message}`, { to: 'debug' })
  }
}

async function flushChunks($: EngineInterface) {
  if (buffered.size === 0) return
  const batch = new Map(buffered)
  buffered.clear()
  await update($, room, r => ({
    ...r,
    messages: r.messages.map(m => (batch.has(m.id) ? { ...m, text: m.text + batch.get(m.id) } : m)),
  }))
}

function patchMessage($: EngineInterface, id: string, fn: (message: RoomMessage) => RoomMessage) {
  return update($, room, r => ({ ...r, messages: r.messages.map(m => (m.id === id ? fn(m) : m)) }))
}

async function addMessage($: EngineInterface, message: Omit<RoomMessage, 'id'> & { id?: string }): Promise<RoomMessage> {
  seq += 1
  const full: RoomMessage = { ...message, id: message.id ?? `m${seq}` }
  await update($, room, r => ({ ...r, messages: [...r.messages, full].slice(-200) }))
  return full
}

// A message from you or from Claude: say it in the room, then give each target a turn.
async function post($: EngineInterface, from: 'you' | 'main', text: string): Promise<string[]> {
  const state = await read($, room)
  const { agents, toMain } = targetsOf(text, state.defaultAgent)
  const first = agents[0]
  if (from === 'you' && first && parseMentions(text).includes(first)) {
    await update($, room, r => ({ ...r, defaultAgent: first }))
  }
  const message = await addMessage($, { from, text, to: [...agents, ...(toMain && from !== 'main' ? (['main'] as const) : [])] })
  if (toMain && from === 'you') await tellMain($, message)
  const turns: string[] = []
  for (const agent of agents) turns.push(await startTurn($, agent, message, 0))
  return turns
}

async function startTurn($: EngineInterface, agent: Agent, trigger: RoomMessage, hop: number): Promise<string> {
  seq += 1
  const turn = `${agent}-turn-${seq}`
  const state = await read($, room)
  const history = historyFor(state.messages, agent, trigger.id, !primed.has(agent))
  await addMessage($, { id: turn, from: agent, text: '', hop, isStreaming: true })
  hops.set(turn, hop)
  askedBy.set(turn, trigger.from)
  try {
    await ensureBridge($)
    const isFresh = !primed.has(agent)
    const sessionContext = isFresh ? await seedFor($) : ''
    const text = framePrompt(agent, isFresh, history, trigger, hop, cwd, sessionContext)
    primed.add(agent)
    await bridgePost($, '/prompt', { agent, turn, text })
  } catch (error) {
    await patchMessage($, turn, m => ({ ...m, isStreaming: false, isError: true, text: `⚠ ${String(error)}` }))
  }
  return turn
}

// A finished reply that @mentions someone hands the conversation to them, within the budget.
async function routeReply($: EngineInterface, reply: RoomMessage) {
  const hop = hops.get(reply.id) ?? 0
  const targets = handoffTargets(reply, askedBy.get(reply.id))
  if (targets.length === 0) return
  if (hop > 0 && isBareAck(reply.text)) return
  if (hop + 1 > HOP_BUDGET) {
    await addMessage($, { from: 'system', text: `Hop budget (${HOP_BUDGET}) reached; nobody else was woken. Reply to keep going.` })
    return
  }
  for (const target of targets) {
    await addMessage($, { from: 'system', text: `@${reply.from} → @${target} · hop ${hop + 1} of ${HOP_BUDGET}` })
    if (target === 'main') await tellMain($, reply)
    else await startTurn($, target as Agent, reply, hop + 1)
  }
}

// What a fresh room agent learns about the Claude session, per the roomSeed setting.
async function seedFor($: EngineInterface): Promise<string> {
  if (config.roomSeed === 'none') return ''
  const rows = await $.session.messages()
  if (!Array.isArray(rows)) return ''
  if (config.roomSeed === 'full') return sessionExcerpt(rows, Number.POSITIVE_INFINITY, 60_000, 6_000)
  const recent = sessionExcerpt(rows, config.roomSeedTurns, Math.min(60_000, config.roomSeedTurns * 1_500))
  if (config.roomSeed === 'recent') return recent

  // summary: Claude writes it from its own cached transcript; one per session state, shared by both agents.
  const turns = await $.session.turns()
  if (seedSummary?.turns === turns) return seedSummary.text
  const reply = await $.model.fork({ prompt: SEED_SUMMARY_PROMPT })
  if (!reply.isAnswered) return recent
  const text = ['<claude-session>', '(a briefing Claude wrote about the conversation this room was opened from)', reply.text.trim(), '</claude-session>'].join('\n')
  seedSummary = { turns, text }
  return text
}

// What goes with a room message to Claude, per the claudeReturn setting. `atLeast` lets the
// Send room to Claude button treat 'message' as 'recent'.
async function returnContext($: EngineInterface, except: string | undefined, atLeast?: ReturnMode): Promise<string> {
  const mode = config.claudeReturn === 'message' && atLeast ? atLeast : config.claudeReturn
  if (mode === 'message') return ''
  const messages = (await read($, room)).messages.filter(m => m.id !== except)
  if (mode === 'recent') return roomTranscript(messages, config.claudeReturnMessages, 12_000)
  const whole = roomTranscript(messages, Number.POSITIVE_INFINITY, 30_000)
  if (mode === 'full' || !whole) return whole
  const reply = await $.model.complete({ model: 'haiku', system: RETURN_SUMMARY_SYSTEM, prompt: whole, maxTokens: 600 })
  return reply.isAnswered ? `(summary) ${reply.text.trim()}` : roomTranscript(messages, config.claudeReturnMessages, 12_000)
}

// The main session is reachable from the room: an @main mention arrives there as a prompt.
async function tellMain($: EngineInterface, message: RoomMessage) {
  const who = message.from === 'you' ? 'I' : `@${message.from}`
  const answerHint =
    message.from === 'you'
      ? 'Answer me here in the main chat.'
      : `To answer in the room, call the ask_agent tool with agent "${message.from}".`
  const context = await returnContext($, message.id)
  const before = context ? `Earlier in the room:\n\n${context}\n\n---\n\n` : ''
  void $.prompt.submit({ text: `${before}${who} said in the agent room (the Agent room pane):\n\n${message.text}\n\n${answerHint}` })
}

async function sendRoomToMain($: EngineInterface) {
  const context = await returnContext($, undefined, 'recent')
  if (!context) return
  void $.prompt.submit({
    text: `Here is the agent room conversation (Codex, Cursor and the room's Claude, in the Agent room pane). Take it into account and tell me where you agree or disagree.\n\n${context}`,
  })
}

async function waitForTurn($: EngineInterface, turn: string): Promise<{ text: string; error?: string }> {
  for (let i = 0; i < 40; i += 1) {
    const result = await bridgePost($, '/wait', { turn, timeoutMs: 45_000 })
    if (result.done) return { text: String(result.text ?? ''), error: result.error ? String(result.error) : undefined }
  }
  return { text: '', error: 'still running after 30 minutes' }
}

async function resetRoom($: EngineInterface) {
  if (bridge) {
    for (const agent of AGENTS) await bridgePost($, '/reset', { agent }).catch(() => undefined)
  }
  primed.clear()
  hops.clear()
  askedBy.clear()
  seedSummary = undefined
  await update($, room, r => ({ ...r, messages: [], permissions: [], detail: '', status: ALL_IDLE }))
}

async function answerPermission($: EngineInterface, id: string, optionId: string | null) {
  await update($, room, r => ({ ...r, permissions: r.permissions.filter(p => p.id !== id) }))
  await bridgePost($, '/permission', { id, optionId })
}

async function interrupt($: EngineInterface) {
  const state = await read($, room)
  for (const agent of AGENTS) {
    if (state.status[agent] === 'busy') await bridgePost($, '/cancel', { agent }).catch(() => undefined)
  }
}

// ---------- drawing ----------

const DOT: Record<AgentState, string> = { idle: '○', starting: '◌', ready: '●', busy: '◉', error: '✕' }

async function renderRoom($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Markdown, Button } = elements
  // The mobile surface has no text field; there a message goes through /ask.
  const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
  const state = await read($, room)
  const isBusy = AGENTS.some(agent => state.status[agent] === 'busy')

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {AGENTS.map(agent => `${DOT[state.status[agent]]} ${LABEL[agent]} ${state.status[agent]}`).join('   ')}
        {`   · default @${state.defaultAgent}`}
      </Text>
      <Text dimColor>
        {`context in: ${config.roomSeed}${config.roomSeed === 'recent' ? ` ${config.roomSeedTurns} turns` : ''} · back to main: ${config.claudeReturn}${config.claudeReturn === 'recent' ? ` ${config.claudeReturnMessages} msgs` : ''} · /config to change`}
      </Text>
      {state.detail ? <Text color="red">{state.detail}</Text> : null}
      {state.messages.length === 0 && (
        <Text dimColor>
          {'One chat with Codex, Cursor and a separate Claude. @codex, @cursor or @claude picks who answers, @main reaches your main session, and agents can @mention each other to hand off.'}
        </Text>
      )}
      {state.messages.slice(-30).map(m =>
        m.from === 'system' ? (
          <Text key={m.id} dimColor>
            {m.text}
          </Text>
        ) : (
          <Box key={m.id} flexDirection="column" marginTop={1}>
            <Text bold color={m.isError ? 'red' : COLOR[m.from]}>
              {`${LABEL[m.from]}${m.to?.length ? ` → ${m.to.map(t => `@${t}`).join(' ')}` : ''}${m.isStreaming ? ' …' : ''}`}
            </Text>
            {(m.tools ?? []).slice(-3).map(tool => (
              <Text key={`${m.id}-${tool.id}`} dimColor>
                {`↳ ${tool.title}${tool.status ? ` · ${tool.status}` : ''}`}
              </Text>
            ))}
            {m.from === 'you' || m.from === 'main' ? (
              <Text>{m.text}</Text>
            ) : m.text ? (
              <Markdown text={m.text} />
            ) : (
              <Text dimColor>thinking…</Text>
            )}
          </Box>
        ),
      )}
      {state.permissions.map(card => (
        <Box key={card.id} flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold>{`${LABEL[card.agent]} wants to: ${card.title}`}</Text>
          <Box>
            {card.options.map(option => (
              <Button
                key={`${card.id}-${option.optionId}`}
                label={option.name}
                onPress={() => answerPermission($, card.id, option.optionId)}
              />
            ))}
            <Button key={`${card.id}-cancel`} label="Cancel" onPress={() => answerPermission($, card.id, null)} />
          </Box>
        </Box>
      ))}
      <Box marginTop={1}>
        {Input ? (
          <Input
            key={`room-${state.messages.length}`}
            placeholder="Message the room… (@codex @cursor @claude @main)"
            submitLabel="send"
            autoFocus
            onSubmit={(value: string) => {
              if (value.trim()) void post($, 'you', value.trim())
            }}
          />
        ) : (
          <Text dimColor>{'Send with /ask @codex <message>'}</Text>
        )}
      </Box>
      <Box>
        {isBusy && <Button key="interrupt" label="Interrupt" onPress={() => interrupt($)} />}
        {state.messages.length > 0 && <Button key="share" label="Send room to main" onPress={() => sendRoomToMain($)} />}
        {state.messages.length > 0 && <Button key="new" label="New chat" onPress={() => resetRoom($)} />}
      </Box>
    </Box>
  )
}

// ---------- registration ----------

export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    // Inside the room's own Claude (a Claude Code session the bridge started), stay out of the way:
    // no commands, no tools, so it cannot open a room inside the room.
    if (await $.env.get('SECOND_OPINION_IN_ROOM')) return next(e)
    // Each registration stands alone: one the engine refuses (a built-in's name) must not take the rest down.
    const registered = await Promise.allSettled([
      $.command.register({
        name: 'second-opinion',
        description: 'Have Codex and/or Cursor review the current changes',
        argumentHint: '[codex|cursor|both] [focus]',
      }),
      $.command.register({
        name: 'delegate',
        description: 'Have Codex or Cursor implement a task in this repo',
        argumentHint: '<codex|cursor> <task>',
      }),
      $.command.register({ name: 'opinions', description: 'Open the Codex/Cursor review runs pane' }),
      $.command.register({
        name: 'ask',
        description: 'Say something in the agent room (Codex, Cursor and a separate Claude in one chat)',
        argumentHint: '[@codex|@cursor|@claude|@main] <message>',
      }),
      $.command.register({ name: 'room', description: 'Open the agent room: one chat with Codex, Cursor and a separate Claude' }),
      $.tool.register({
        name: 'ask_agent',
        description:
          'Say something in the shared agent room to OpenAI Codex, the Cursor agent, or the room\'s own Claude (a separate Claude Code session), and get its reply. ' +
          'The agent keeps its session between calls, sees the rest of the room conversation, can read this repository, ' +
          'and may @mention other participants to hand off. Replies take 5 seconds to a few minutes. Treat them as a peer\'s opinion.',
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: AGENTS },
            message: { type: 'string', description: 'What to say. The agent sees recent room history but not your main conversation.' },
          },
          required: ['agent', 'message'],
        },
      }),
      $.tool.register({
        name: 'delegate_task',
        description:
          'Have OpenAI Codex or the Cursor agent implement a task in this repository: it edits files and returns a summary. ' +
          'One-shot, no shared session. Review its changes with git diff afterwards.',
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: EXTERNAL },
            task: { type: 'string', description: 'Self-contained instructions; the agent cannot see this conversation.' },
          },
          required: ['agent', 'task'],
        },
      }),
    ])
    for (const one of registered) {
      if (one.status === 'rejected') $.ui.toast(`second-opinion: ${String(one.reason)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'second-opinion' }, async ($, e) => {
    const { agents, focus } = parseReview(e.args)
    const { diff, what } = await changesToReview($)
    if (!diff) return { text: 'Nothing to review: no uncommitted changes and no commits. To just talk to them, try /room.' }

    await $.ui.open({ id: PANE, title: 'Second opinion' })
    for (const agent of agents) void runAgent($, agent, 'review', `review ${what}${focus ? `: ${focus}` : ''}`, reviewPrompt(diff, focus))
    return { text: `${agents.map(a => LABEL[a]).join(' and ')} reviewing ${what}. Results land in the Second opinion pane.` }
  })

  on('command.run', { command: 'delegate' }, async ($, e) => {
    const parsed = parseDelegate(e.args)
    if ('error' in parsed) return { text: parsed.error }

    await $.ui.open({ id: PANE, title: 'Second opinion' })
    void runAgent($, parsed.agent, 'implement', parsed.task, implementPrompt(parsed.task))
    return { text: `${LABEL[parsed.agent]} is implementing: ${parsed.task}` }
  })

  on('command.run', { command: 'opinions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Second opinion' })
    return { text: 'Second opinion pane opened.' }
  })

  on('command.run', { command: 'room' }, async $ => {
    await $.ui.open({ id: ROOM_PANE, title: 'Agent room', focus: true })
    return { text: 'Agent room opened.' }
  })

  on('command.run', { command: 'ask' }, async ($, e) => {
    await $.ui.open({ id: ROOM_PANE, title: 'Agent room', focus: true })
    const text = normalizeAsk(e.args)
    if (!text) return { text: 'Agent room opened.' }
    const turns = await post($, 'you', text)
    return { text: turns.length ? 'Sent to the agent room.' : 'Sent to the main session.' }
  })

  on('tool.call', { tool: 'mcp__second-opinion__ask_agent' }, async ($, e) => {
    const input = e as unknown as { agent: Agent; message: string }
    if (!AGENTS.includes(input.agent)) return { deny: `agent must be one of ${AGENTS.join(', ')}` }
    if (!input.message?.trim()) return { deny: 'message is required' }
    void $.ui.open({ id: ROOM_PANE, title: 'Agent room' })
    const text = parseMentions(input.message).includes(input.agent) ? input.message : `@${input.agent} ${input.message}`
    const [turn] = await post($, 'main', text)
    if (!turn) return { deny: 'nothing was sent' }
    const reply = await waitForTurn($, turn)
    if (reply.error) return { result: `${LABEL[input.agent]} failed: ${reply.error}${reply.text ? `\n\nPartial reply:\n${reply.text}` : ''}` }
    return { result: `${LABEL[input.agent]} replied:\n\n${reply.text}` }
  }).catch(($, e, next) => ({ deny: `ask_agent failed (${next.error.kind}): ${next.error.message ?? 'no message'}` }))

  on('tool.call', { tool: 'mcp__second-opinion__delegate_task' }, async ($, e) => {
    const input = e as unknown as { agent: External; task: string }
    if (!EXTERNAL.includes(input.agent)) return { deny: `agent must be one of ${EXTERNAL.join(', ')}` }
    if (!input.task?.trim()) return { deny: 'task is required' }
    void $.ui.open({ id: PANE, title: 'Second opinion' })
    const run = await runAgent($, input.agent, 'implement', input.task.slice(0, 120), implementPrompt(input.task))
    return { result: `${LABEL[run.agent]} (implement, ${run.status}, ${seconds(run, run.endedAt ?? 0)}):\n\n${run.result}` }
  }).catch(($, e, next) => ({ deny: `delegate_task failed (${next.error.kind}): ${next.error.message ?? 'no message'}` }))

  on('ui.render', { component: 'Pane', requestId: 'agent-room' }, ($, e) => renderRoom($, e))

  on('ui.render', { component: 'Pane', requestId: 'second-opinion' }, async ($, e) => {
    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const list = await read($, runs)
    const isRunning = list.some(run => run.status === 'running')
    const at = isRunning ? (await read($, now)) || (await $.clock.now()) : 0
    const unsent = list.filter(run => run.mode === 'review' && run.status === 'done' && !run.isSent)
    const implemented = list.filter(run => run.mode === 'implement' && run.status === 'done' && !run.isSent)

    const send = async (picked: Run[], ask: string) => {
      const body = picked.map(run => `## ${LABEL[run.agent]} (${run.task})\n\n${run.result}`).join('\n\n')
      await update($, runs, all => all.map(run => (picked.some(p => p.id === run.id) ? { ...run, isSent: true } : run)))
      void $.prompt.submit({ text: `${ask}\n\n${body}` })
    }

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No runs yet. Try /second-opinion or /delegate codex &lt;task&gt;.</Text>}
        {list.map(run => (
          <Box key={run.id} flexDirection="column" marginBottom={1}>
            <Text bold color={run.status === 'failed' ? 'red' : run.status === 'done' ? 'green' : 'yellow'}>
              {LABEL[run.agent]} · {run.mode} · {run.status} · {seconds(run, at)}
            </Text>
            <Text dimColor>{run.task.slice(0, 100)}</Text>
            {run.status === 'running' ? (
              <Text dimColor>{run.tail.split('\n').filter(Boolean).slice(-6).join('\n') || 'starting…'}</Text>
            ) : (
              <Markdown text={run.result ?? ''} />
            )}
          </Box>
        ))}
        <Box>
          {unsent.length > 0 && (
            <Button
              key="send-reviews"
              label={`Send ${unsent.length} review${unsent.length > 1 ? 's' : ''} to Claude`}
              onPress={() =>
                send(
                  unsent,
                  'Outside reviewers looked at the current changes. Weigh each finding against the code: fix the ones that are real, and say briefly why you are skipping any that are wrong.',
                )
              }
            />
          )}
          {implemented.length > 0 && (
            <Button
              key="check-impl"
              label="Have Claude check the implementation"
              onPress={() =>
                send(
                  implemented,
                  'An outside agent just implemented a task in this repo. Read its summary, inspect the actual changes with git diff, and tell me whether it did the task correctly. Fix anything broken.',
                )
              }
            />
          )}
          {list.some(run => run.status !== 'running') && (
            <Button
              key="clear"
              label="Clear finished"
              onPress={() => update($, runs, all => all.filter(run => run.status === 'running'))}
            />
          )}
        </Box>
      </Box>
    )
  })
}
