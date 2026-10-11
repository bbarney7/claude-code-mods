import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Access, Agent, AgentOption, AgentState, Choice, External, Mode, ModelPrefs, PermissionCard, PermissionOption, RoomMessage, Run, Speaker } from '../types'

const PANE = 'second-opinion'
const ROOM_PANE = 'agent-room'
const MAX_DIFF = 150_000
const TAIL = 4_000
const HOP_BUDGET = 3
const HISTORY_ITEMS = 12
const HISTORY_CHARS = 8_000

const runs = atom({ plugin: 'room', key: 'runs' } as const, [])
const now = atom({ plugin: 'room', key: 'now' } as const, 0)
const room = atom({ plugin: 'room', key: 'room' } as const, {
  messages: [],
  status: { codex: 'idle', cursor: 'idle', claude: 'idle' },
  detail: '',
  permissions: [],
  defaultAgent: 'codex',
  access: 'ask',
  models: {},
  prefs: {},
})

const EXTERNAL: External[] = ['codex', 'cursor']
const AGENTS: Agent[] = ['codex', 'cursor', 'claude']
const ALL_IDLE: Record<Agent, AgentState> = { codex: 'idle', cursor: 'idle', claude: 'idle' }
const LABEL: Record<Speaker, string> = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude', main: 'Main session', you: 'You', system: '·' }
const COLOR: Record<Speaker, string> = { codex: 'green', cursor: 'magenta', claude: 'yellow', main: 'blue', you: 'cyan', system: 'gray' }

// ---------- how much context crosses between Claude's session and the room (/config) ----------

export type SeedMode = 'none' | 'recent' | 'summary' | 'full'
export type ReturnMode = 'message' | 'recent' | 'summary' | 'full'
// inherit: room agents get the main session's permission mode (bypass included); allow: they edit
// the repository on their own; ask: each asks first (Cursor, which cannot ask, only reads).
export type RoomEdits = 'inherit' | 'allow' | 'ask'
export type ContextConfig = { roomSeed: SeedMode; roomSeedTurns: number; claudeReturn: ReturnMode; claudeReturnMessages: number; roomEdits: RoomEdits }
export const DEFAULT_CONFIG: ContextConfig = { roomSeed: 'recent', roomSeedTurns: 10, claudeReturn: 'message', claudeReturnMessages: 8, roomEdits: 'inherit' }

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
    roomEdits: options.roomEdits === 'ask' || options.roomEdits === 'allow' ? options.roomEdits : DEFAULT_CONFIG.roomEdits,
  }
}

// ---------- what the room's agents may do ----------

// The main session's permission mode, as Claude Code names it, to the room's access level.
const ACCESS_OF_MODE: Record<string, Access> = {
  plan: 'read',
  default: 'ask',
  dontAsk: 'ask',
  acceptEdits: 'edit',
  auto: 'auto',
  bypassPermissions: 'full',
}

export function accessFor(setting: RoomEdits, mainMode: string | undefined): Access {
  if (setting === 'allow') return 'edit'
  if (setting === 'ask') return 'ask'
  return ACCESS_OF_MODE[mainMode ?? ''] ?? 'ask'
}

// Each agent's own ACP mode for an access level. Cursor cannot ask, so below edit it only reads;
// at full access the bridge answers anything an agent still asks.
export const AGENT_MODE: Record<Access, Record<Agent, string>> = {
  read: { codex: 'read-only', cursor: 'ask', claude: 'plan' },
  ask: { codex: 'read-only', cursor: 'ask', claude: 'default' },
  edit: { codex: 'workspace-write', cursor: 'agent', claude: 'acceptEdits' },
  auto: { codex: 'agent', cursor: 'agent', claude: 'auto' },
  full: { codex: 'agent-full-access', cursor: 'agent', claude: 'bypassPermissions' },
}

export const ACCESS_LABEL: Record<Access, string> = {
  read: 'read-only',
  ask: 'asks first',
  edit: 'edits the repo',
  auto: 'auto',
  full: 'full access',
}

// What the agent is told it may do, in its first prompt and again when the level changes.
const ACCESS_RULE: Record<Access, (cwd: string) => string> = {
  read: cwd => `You can read the repository at ${cwd}. This is planning only: do not edit files or run commands that change anything; propose changes instead.`,
  ask: cwd => `You can read the repository at ${cwd}. Edits and commands need the human's approval, so propose a change before making it.`,
  edit: cwd =>
    `You work in the repository at ${cwd}: edit files and run commands there when that is what's asked, and say briefly what you changed. Anything outside it may need the human's approval.`,
  auto: cwd =>
    `You work in the repository at ${cwd}: edit files and run commands there when that is what's asked, and say briefly what you changed. Risky actions may need the human's approval.`,
  full: cwd => `You work in the repository at ${cwd} with full access: edit files and run commands when that is what's asked, and say briefly what you changed.`,
}

// Codex's approval options are long sentences; the room shows them as short buttons.
const CHOICE_LABEL: Record<string, string> = {
  'Yes, proceed': 'Allow',
  'Yes, just this once': 'Allow once',
  "Yes, and don't ask again for this command in this session": 'Allow for session',
  'Yes, and allow this host for this conversation': 'Allow host for session',
  'Yes, and allow these permissions for this session': 'Allow for session',
  "Yes, and don't ask again for these files": 'Allow these files',
  'Yes, grant these permissions for this turn': 'Allow this turn',
  'Yes, grant for this turn with strict auto review': 'Allow, auto-review',
  'Yes, grant these permissions for this session': 'Allow for session',
  'Yes, and allow this host in the future': 'Always allow host',
  'No, and block this host in the future': 'Always block host',
  'No, continue without running it': 'Skip',
  'No, continue without permissions': 'Skip',
  'No, and tell Codex what to do differently': 'Deny',
  'Allow for this session': 'Allow for session',
  Cancel: 'Deny',
}
const KIND_LABEL: Record<string, string> = { allow_once: 'Allow', allow_always: 'Always allow', reject_once: 'Deny', reject_always: 'Never' }

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// The buttons a question shows: short labels, each once, and a Deny where the agent offered none.
// An optionId of '' answers "cancelled".
export function permissionChoices(options: readonly PermissionOption[]): { id: string; label: string; kind: string }[] {
  const used = new Set<string>()
  const choices = options.map(option => {
    const name = option.name.trim()
    const prefix = /^Yes, and don't ask again for commands that start with `(.+)`$/.exec(name)
    let label = prefix ? `Always allow ${clip(prefix[1] ?? '', 24)}` : (CHOICE_LABEL[name] ?? (name.length <= 24 ? name : (KIND_LABEL[option.kind] ?? clip(name, 24))))
    if (used.has(label)) label = clip(name, 32)
    used.add(label)
    return { id: option.optionId, label, kind: option.kind }
  })
  if (!options.some(o => o.kind.startsWith('reject'))) choices.push({ id: '', label: 'Deny', kind: 'reject_once' })
  return choices
}

// "Codex wants to run `npm test`": what the question is about, in a line.
export function questionText(card: Pick<PermissionCard, 'title' | 'detail'>): string {
  if (card.detail && /^run command$/i.test(card.title)) return `run \`${clip(card.detail, 200)}\``
  return card.detail ? `${card.title}: ${clip(card.detail, 200)}` : card.title
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

const BREVITY =
  'Keep replies short: lead with the answer in a few sentences (under about 120 words), no preamble and no step-by-step account of what you did. ' +
  'Use a short list only for several findings. Go longer only when asked.'

export function framePrompt(
  agent: Agent,
  isFirst: boolean,
  history: string,
  trigger: RoomMessage,
  hop: number,
  cwd: string,
  sessionContext = '',
  access: Access = 'edit',
  accessChanged = false,
): string {
  const system = isFirst
    ? [
        '<system>',
        `You are @${agent} (${LABEL[agent]}) in a group chat that lives inside Claude Code.`,
        'Participants: @you is the human developer; @main is the main Claude Code session that opened this room;',
        '@claude is a separate Claude agent in the room; @codex is OpenAI Codex; @cursor is the Cursor agent. You are one of them.',
        ACCESS_RULE[access](cwd),
        'Your reply goes back to whoever addressed you on its own; do not @mention them to answer.',
        'To bring in a different participant, @mention them in your reply and they get a turn.',
        'Only @mention someone when you want them to act.',
        BREVITY,
        '</system>',
        '',
      ].join('\n')
    : ''
  const rule = !isFirst && accessChanged ? `<system>Your permissions changed. ${ACCESS_RULE[access](cwd)}</system>\n` : ''
  const handoff = hop > 0 ? `(@${trigger.from} handed this to you: hop ${hop} of ${HOP_BUDGET})\n` : ''
  const session = isFirst && sessionContext ? `${sessionContext}\n` : ''
  const reminder = isFirst ? '' : '\n(Room reply: answer first, briefly.)'
  return `${system}${rule}${session}${history ? `${history}\n` : ''}${handoff}<chat-event author="${authorTag(trigger.from)}">${trigger.text}</chat-event>${reminder}`
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
let bridgeError = ''
const primed = new Set<Agent>()
const hops = new Map<string, number>()
const askedBy = new Map<string, Speaker>()
const buffered = new Map<string, { segment: number; text: string }[]>()
let flushTimer: { cancel: () => void } | undefined
let config: ContextConfig = DEFAULT_CONFIG
let seedSummary: { turns: number; text: string } | undefined
// The main session's permission mode: its settings' default until a prompt, a tool call or a turn's
// end says what it is now (Claude Code reports it there, not on a slash command).
let mainMode: string | undefined
const lastAccess = new Map<Agent, Access>()
let lastConfigError = ''

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
    const socket = `/tmp/room-${crypto.randomUUID().slice(0, 8)}.sock`
    bridge = { socket, ready, markReady }
    cwd = await $.session.root()
    bridgeError = ''
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
          $.ui.log(`room: bad bridge line: ${String(error)}`, { to: 'debug' })
        }
      }
    }
  } catch (error) {
    // A refusal from another mod (a firewall) or a missing node lands here: keep it for the message.
    bridgeError = String(error).replace(/^HooksError:\s*/, '')
    stderr += bridgeError
  }
  bridge?.markReady(false)
  bridge = undefined
  await update($, room, r => ({
    ...r,
    status: ALL_IDLE,
    permissions: [],
    models: {},
    detail: stderr.trim() ? `bridge stopped: ${stderr.trim().split('\n').pop()}` : r.detail,
    messages: r.messages.map(m => (m.isStreaming ? { ...m, isStreaming: false, isError: true, text: m.text || '(the bridge stopped)' } : m)),
  }))
}

async function bridgePost($: EngineInterface, path: string, body: Record<string, unknown>) {
  const socket = await ensureBridge($)
  if (!socket) throw new Error(`the agent bridge did not start: ${bridgeError || 'is node on PATH?'}`)
  const response = await $.http.fetch(`http://bridge${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: socket,
  })
  if (!response.ok) throw new Error(`bridge ${path}: ${response.status} ${response.text}`)
  return JSON.parse(response.text || '{}') as Record<string, unknown>
}

type BridgeOption = { id: string; category: string; current: string; values: Choice[] }
type BridgeEvent =
  | { type: 'listening' }
  | { type: 'status'; agent: Agent; state: AgentState; detail?: string }
  | { type: 'chunk'; agent: Agent; turn: string; segment?: number; text: string }
  | { type: 'tool'; agent: Agent; turn: string; id: string; title?: string; status?: string }
  | { type: 'turn_end'; agent: Agent; turn: string; stopReason: string }
  | { type: 'turn_error'; agent: Agent; turn: string; message: string }
  | { type: 'permission'; agent: Agent; id: string; title: string; detail?: string; options: PermissionOption[] }
  | { type: 'permission_closed'; id: string }
  | { type: 'permission_auto'; agent: Agent; turn?: string; id?: string; title: string; option: string }
  | { type: 'options'; agent: Agent; mode?: string; options: BridgeOption[] }
  | { type: 'config_error'; agent: Agent; message: string }
  | { type: 'log'; message: string }

const OPTION_KEY: Record<string, 'model' | 'effort'> = { model: 'model', thought_level: 'effort' }

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
        // An agent that failed to start lists no models: the picker stops waiting for them.
        models: event.state === 'error' ? { ...(r.models ?? {}), [event.agent]: {} } : r.models,
      }))
      return
    case 'chunk':
      buffered.set(event.turn, [...(buffered.get(event.turn) ?? []), { segment: event.segment ?? 0, text: event.text }])
      // Codex streams token-sized pieces: draw them in batches, not one redraw per token.
      flushTimer ??= $.clock.after(250, () => {
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
      const isStopped = event.type === 'turn_end' && event.stopReason === 'cancelled'
      const at = await $.clock.now()
      await patchMessage($, event.turn, m => finishMessage(m, { isError, isStopped, error: isError ? event.message : undefined, at }))
      const done = (await read($, room)).messages.find(m => m.id === event.turn)
      if (done && !isError && !isStopped) await routeReply($, done)
      return
    }
    case 'permission':
      await update($, room, r => ({ ...r, permissions: [...r.permissions.filter(p => p.id !== event.id), { id: event.id, agent: event.agent, title: event.title, detail: event.detail, options: event.options }] }))
      $.ui.toast(`${LABEL[event.agent]} wants to ${questionText(event)}`)
      return
    case 'permission_closed':
      await update($, room, r => ({ ...r, permissions: r.permissions.filter(p => p.id !== event.id) }))
      return
    case 'permission_auto':
      // Full access: the bridge said yes on the person's behalf; the reply's tool lines show it.
      if (event.turn) {
        await patchMessage($, event.turn, m => ({
          ...m,
          tools: [...(m.tools ?? []), { id: `auto-${event.id ?? (m.tools?.length ?? 0)}`, title: clip(event.title, 80), status: 'allowed (full access)' }],
        }))
      }
      return
    case 'options': {
      const got: { model?: AgentOption; effort?: AgentOption } = {}
      for (const option of event.options) {
        const key = OPTION_KEY[option.category]
        if (key) got[key] = { current: option.current, values: option.values }
      }
      await update($, room, r => ({ ...r, models: { ...(r.models ?? {}), [event.agent]: got } }))
      return
    }
    case 'config_error': {
      const text = `${LABEL[event.agent]} refused ${event.message}`
      if (text === lastConfigError) return
      lastConfigError = text
      await addMessage($, { from: 'system', text })
      return
    }
    case 'log':
      $.ui.log(`room bridge: ${event.message}`, { to: 'debug' })
  }
}

// A turn's end: the answer is the last segment with text; what came before stays as narration.
export function finishMessage(
  m: RoomMessage,
  end: { isError: boolean; isStopped: boolean; error?: string; at: number },
): RoomMessage {
  const notes = [...(m.notes ?? [])]
  let text = m.text.trim()
  if (!text && notes.length > 0) text = notes.pop() ?? ''
  if (end.isError) text = `${text}${text ? '\n\n' : ''}⚠ ${end.error ?? 'failed'}`
  else if (!text) text = end.isStopped ? '(stopped)' : '(no reply)'
  return { ...m, text, notes, isStreaming: false, isError: end.isError, isStopped: end.isStopped, endedAt: end.at }
}

// Streamed text by segment: a new segment moves what was written into the narration.
export function applyChunks(m: RoomMessage, pieces: readonly { segment: number; text: string }[]): RoomMessage {
  let { text } = m
  let segment = m.segment ?? 0
  const notes = [...(m.notes ?? [])]
  for (const piece of pieces) {
    if (piece.segment > segment) {
      if (text.trim()) notes.push(text.trim())
      text = ''
      segment = piece.segment
    }
    text += piece.text
  }
  return { ...m, text, notes, segment }
}

async function flushChunks($: EngineInterface) {
  if (buffered.size === 0) return
  const batch = new Map(buffered)
  buffered.clear()
  await update($, room, r => ({
    ...r,
    messages: r.messages.map(m => (batch.has(m.id) ? applyChunks(m, batch.get(m.id) ?? []) : m)),
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
  await addMessage($, { id: turn, from: agent, text: '', hop, isStreaming: true, startedAt: await $.clock.now() })
  hops.set(turn, hop)
  askedBy.set(turn, trigger.from)
  try {
    await ensureBridge($)
    const isFresh = !primed.has(agent)
    const sessionContext = isFresh ? await seedFor($) : ''
    // The main session's permission mode decides this turn's, so a switch to bypass reaches the room.
    const access = accessFor(config.roomEdits, mainMode)
    const accessChanged = lastAccess.has(agent) && lastAccess.get(agent) !== access
    lastAccess.set(agent, access)
    if (state.access !== access) await update($, room, r => ({ ...r, access }))
    const text = framePrompt(agent, isFresh, history, trigger, hop, cwd, sessionContext, access, accessChanged)
    primed.add(agent)
    await bridgePost($, '/prompt', { agent, turn, text, settings: settingsFor(agent, access, state.prefs ?? {}) })
  } catch (error) {
    await patchMessage($, turn, m => ({ ...m, isStreaming: false, isError: true, text: `⚠ ${String(error)}` }))
  }
  return turn
}

// What the bridge sets on an agent before a turn: its mode for the access level, the person's picks.
export function settingsFor(agent: Agent, access: Access, prefs: ModelPrefs) {
  const picked = prefs[agent] ?? {}
  return {
    mode: AGENT_MODE[access][agent],
    autoApprove: access === 'full',
    ...(picked.model ? { model: picked.model } : {}),
    ...(picked.effort ? { effort: picked.effort } : {}),
  }
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
  await addMessage($, { from: 'system', text: 'Sent the room to the main session.' })
  void $.prompt.submit({
    text: `Here is the agent room conversation (Codex, Cursor and the room's Claude, in the Agent room pane). Take it into account and tell me where you agree or disagree.\n\n${context}`,
  })
}

// The answer only: the narration before it stays in the room.
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
  lastAccess.clear()
  seedSummary = undefined
  await update($, room, r => ({ ...r, messages: [], permissions: [], detail: '', status: ALL_IDLE, models: {} }))
}

// The person answered a question: it leaves the room's cards and the transcript says what was chosen.
async function answerPermission($: EngineInterface, id: string, optionId: string | null) {
  const card = (await read($, room)).permissions.find(p => p.id === id)
  await update($, room, r => ({ ...r, permissions: r.permissions.filter(p => p.id !== id) }))
  if (!card) return
  const choice = permissionChoices(card.options).find(c => c.id === (optionId ?? ''))
  const verb = choice?.kind.startsWith('allow') ? 'allowed' : 'declined'
  await addMessage($, { from: 'system', text: `You ${verb} ${LABEL[card.agent]}: ${questionText(card)}${choice ? ` (${choice.label})` : ''}` })
  try {
    const answer = await bridgePost($, '/permission', { id, optionId })
    if (answer.found === false) await addMessage($, { from: 'system', text: `${LABEL[card.agent]} had already stopped waiting for that answer.` })
  } catch (error) {
    await addMessage($, { from: 'system', text: `Could not answer ${LABEL[card.agent]}: ${String(error)}` })
  }
}

async function setDefaultAgent($: EngineInterface, agent: Agent) {
  await update($, room, r => ({ ...r, defaultAgent: agent }))
}

async function interrupt($: EngineInterface) {
  const state = await read($, room)
  const busy = AGENTS.filter(agent => state.status[agent] === 'busy' || state.status[agent] === 'starting')
  if (busy.length === 0) return
  await addMessage($, { from: 'system', text: `Stopping ${busy.map(a => LABEL[a]).join(' and ')}…` })
  for (const agent of busy) await bridgePost($, '/cancel', { agent }).catch(() => undefined)
}

// The person's model and effort picks: kept across sessions, applied to the agent's session now
// when it is up (else before its next turn).
async function pickModel($: EngineInterface, agent: Agent, pick: { model?: string; effort?: string }) {
  const prefs: ModelPrefs = { ...((await $.store.get('models')) as ModelPrefs | undefined) }
  const mine = { ...prefs[agent], ...pick }
  // A new model starts from its own default effort, unless one was picked with it.
  if (pick.model && !pick.effort) delete mine.effort
  prefs[agent] = mine
  await $.store.set('models', prefs)
  await update($, room, r => ({ ...r, prefs }))
  if (bridge) await bridgePost($, '/configure', { agent, settings: pick }).catch(() => undefined)
  const what = [pick.model && `model ${pick.model}`, pick.effort && `effort ${pick.effort}`].filter(Boolean).join(', ')
  await addMessage($, { from: 'system', text: `${LABEL[agent]} now uses ${what}.` })
}

// The model picker needs the agent's own list: start its session (no model call) to learn it.
async function loadModels($: EngineInterface, agent: Agent) {
  const known = (await read($, room)).models?.[agent]
  if (known?.model || known?.isLoading) return
  await update($, room, r => ({ ...r, models: { ...(r.models ?? {}), [agent]: { ...known, isLoading: true } } }))
  const prefs = ((await $.store.get('models')) as ModelPrefs | undefined) ?? {}
  await bridgePost($, '/configure', { agent, settings: prefs[agent] ?? {}, start: true }).catch(async error => {
    await update($, room, r => ({ ...r, models: { ...(r.models ?? {}), [agent]: {} } }))
    await addMessage($, { from: 'system', text: `Could not load ${LABEL[agent]}'s models: ${String(error)}` })
  })
}

// Every hook event that carries the main session's permission mode keeps it current.
async function trackMode($: EngineInterface, mode: string | undefined) {
  if (!mode || mode === mainMode) return
  mainMode = mode
  const access = accessFor(config.roomEdits, mainMode)
  if ((await read($, room)).access !== access) await update($, room, r => ({ ...r, access }))
}

// ---------- drawing ----------

// Green while an agent is up (connected or working), grey while it has not started, red when it failed.
const STATUS_COLOR: Record<AgentState, string> = { idle: 'gray', starting: 'yellow', ready: 'green', busy: 'green', error: 'red' }
const STATUS_WORD: Record<AgentState, string> = { idle: 'idle', starting: 'starting…', ready: 'ready', busy: 'working…', error: 'error' }

export function isLive(status: AgentState): boolean {
  return status === 'ready' || status === 'busy'
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// An agent's model in a few characters: the picked or reported model, and its effort.
export function modelLabel(options: { model?: AgentOption; effort?: AgentOption } | undefined, picked: { model?: string; effort?: string } | undefined): string {
  const model = picked?.model ?? options?.model?.current
  const effort = picked?.effort ?? options?.effort?.current
  const name = options?.model?.values.find(v => v.value === model)?.name ?? model
  return [name, effort].filter(Boolean).join(' · ')
}

// What an agent is doing now, for the working line: its latest unfinished tool, else its narration.
function doingOf(m: RoomMessage): string {
  const tool = [...(m.tools ?? [])].reverse().find(t => t.status !== 'completed' && t.status !== 'failed')
  if (tool) return clip(tool.title, 60)
  const said = m.text.trim() || m.notes?.at(-1) || ''
  return said ? clip(said.split('\n')[0] ?? '', 60) : 'thinking'
}

async function renderRoom($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], bodyRows: number) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Markdown, Button } = elements
  // The desktop draws the room's controls in its own surface modules (controls.tsx, composer.tsx):
  // a Button drawn here keeps its handle only until the next redraw, and the room redraws as
  // agents stream, so a click there can land on a stale handle and do nothing.
  const Client = e.surface === 'desktop' && 'Client' in elements ? elements.Client : undefined
  const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
  const state = await read($, room)
  const models = state.models ?? {}
  const prefs = state.prefs ?? {}
  const access = state.access ?? 'ask'
  const at = await $.clock.now()
  const to = state.defaultAgent
  const working = state.messages.filter(m => m.isStreaming && m.from !== 'you' && m.from !== 'main' && m.from !== 'system')
  const isBusy = working.length > 0 || AGENTS.some(agent => state.status[agent] === 'busy')
  const questions = state.permissions.map(card => ({
    id: card.id,
    who: LABEL[card.agent],
    color: COLOR[card.agent],
    question: questionText(card),
    choices: permissionChoices(card.options),
  }))

  // A chat transcript: the person's messages as bubbles on the right, the agents' replies on
  // the left under their name, newest at the foot, and the message box beneath.
  return (
    <Box flexDirection="column" width="100%" minHeight={bodyRows > 0 ? bodyRows : undefined}>
      <Box width="100%" justifyContent="space-between" flexWrap="wrap" paddingBottom={1}>
        <Box gap={2} flexWrap="wrap">
          {AGENTS.map(agent => (
            <Box key={`status-${agent}`} gap={1}>
              <Text color={STATUS_COLOR[state.status[agent]]}>●</Text>
              <Text dimColor={!isLive(state.status[agent])}>{LABEL[agent]}</Text>
              {modelLabel(models[agent], prefs[agent]) ? <Text dimColor>{modelLabel(models[agent], prefs[agent])}</Text> : null}
              {state.status[agent] === 'starting' || state.status[agent] === 'error' ? <Text dimColor>{STATUS_WORD[state.status[agent]]}</Text> : null}
            </Box>
          ))}
        </Box>
        <Text dimColor>{`${ACCESS_LABEL[access]}${config.roomEdits === 'inherit' ? ' · like main' : ''}`}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        {state.messages.length === 0 && (
          <Box flexDirection="column" alignItems="center" paddingX={2} marginBottom={1}>
            <Text bold>Agent room</Text>
            <Text dimColor>Type @ to pick who answers</Text>
          </Box>
        )}
        {state.messages.slice(-30).map(m =>
          m.from === 'system' ? (
            <Box key={m.id} justifyContent="center" marginTop={1}>
              <Text dimColor>{m.text}</Text>
            </Box>
          ) : m.from === 'you' ? (
            <Box key={m.id} flexDirection="column" alignItems="flex-end" marginTop={1}>
              <Box borderStyle="round" borderColor="gray" paddingX={1}>
                <Text>{m.text}</Text>
              </Box>
            </Box>
          ) : (
            <Box key={m.id} flexDirection="column" marginTop={1}>
              <Box gap={1}>
                <Text bold color={m.isError ? 'red' : COLOR[m.from]}>{`● ${LABEL[m.from]}`}</Text>
                <Text dimColor>{m.to?.length ? `→ ${m.to.map(t => `@${t}`).join(' ')}` : ''}</Text>
              </Box>
              <Box flexDirection="column" paddingLeft={2}>
                {m.isStreaming ? (
                  <Box flexDirection="column">
                    {(m.notes ?? []).length > 0 ? <Text dimColor>{`… ${clip(m.notes?.at(-1) ?? '', 100)}`}</Text> : null}
                    {(m.tools ?? []).slice(-2).map(tool => (
                      <Text key={`${m.id}-${tool.id}`} dimColor>
                        {`↳ ${clip(tool.title, 80)}${tool.status ? ` · ${tool.status}` : ''}`}
                      </Text>
                    ))}
                    {m.text ? <Markdown text={m.text} /> : <Text dimColor>thinking…</Text>}
                  </Box>
                ) : (
                  <Box flexDirection="column">
                    {m.from === 'main' ? <Text>{m.text}</Text> : <Markdown text={m.text} />}
                    {m.from !== 'main' && (m.tools?.length || m.notes?.length || m.endedAt) ? (
                      <Text dimColor>
                        {[
                          m.isStopped ? 'stopped' : '',
                          m.tools?.length ? `${m.tools.length} tool${m.tools.length > 1 ? 's' : ''}` : '',
                          m.notes?.length ? `${m.notes.length} progress note${m.notes.length > 1 ? 's' : ''} hidden` : '',
                          m.startedAt && m.endedAt ? duration(m.endedAt - m.startedAt) : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    ) : null}
                  </Box>
                )}
              </Box>
            </Box>
          ),
        )}
        {state.detail ? <Text color="red">{state.detail}</Text> : null}
        {!Client &&
          questions.map(q => (
            <Box key={q.id} flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text>
                <Text bold color={q.color}>{q.who}</Text>
                {` wants to ${q.question}`}
              </Text>
              <Box gap={1} flexWrap="wrap">
                {q.choices.map(choice => (
                  <Button
                    key={`${q.id}-${choice.id || 'deny'}`}
                    label={choice.label}
                    variant={choice.kind === 'allow_once' ? 'primary' : 'secondary'}
                    onPress={() => answerPermission($, q.id, choice.id || null)}
                  />
                ))}
              </Box>
            </Box>
          ))}
        {!Client &&
          working.map(m => (
            <Text key={`working-${m.id}`} dimColor>
              {`${LABEL[m.from]} working · ${duration(at - (m.startedAt ?? at))} · ${doingOf(m)}`}
            </Text>
          ))}
      </Box>

      <Box flexDirection="column" width="100%" marginTop={1}>
        {Client ? (
          <>
            <Client
              key="room-controls"
              module="./controls.tsx"
              width="100%"
              props={{
                questions,
                working: working.map(m => ({
                  id: m.id,
                  who: LABEL[m.from],
                  color: COLOR[m.from],
                  elapsedMs: at - (m.startedAt ?? at),
                  doing: doingOf(m),
                })),
                canInterrupt: isBusy,
                canShare: state.messages.length > 0,
                canReset: state.messages.length > 0,
              }}
            />
            <Client
              key="room-composer"
              module="./composer.tsx"
              width="100%"
              props={{
                placeholder: `Message ${LABEL[to]}…`,
                color: COLOR[to],
                chips: AGENTS.map(agent => ({ id: agent, label: LABEL[agent], selected: agent === to })),
                mentions: [
                  ...AGENTS.map(agent => ({ id: agent, label: LABEL[agent], hint: `${LABEL[agent]} · ${state.status[agent]}`, color: COLOR[agent] })),
                  { id: 'main', label: 'Main session', hint: 'your main Claude Code session', color: COLOR.main },
                ],
                model: {
                  agent: to,
                  label: modelLabel(models[to], prefs[to]) || 'default model',
                  isLoading: Boolean(models[to]?.isLoading),
                  hasFailed: state.status[to] === 'error',
                  models: (models[to]?.model?.values ?? []).map(v => ({ value: v.value, name: v.name })),
                  efforts: (models[to]?.effort?.values ?? []).map(v => ({ value: v.value, name: v.name })),
                  model: prefs[to]?.model ?? models[to]?.model?.current ?? '',
                  effort: prefs[to]?.effort ?? models[to]?.effort?.current ?? '',
                },
              }}
            />
          </>
        ) : Input ? (
          <Box flexDirection="column" width="100%" borderStyle="round" borderColor={COLOR[to]} paddingX={1}>
            <Input
              key={`room-${state.messages.length}`}
              placeholder={`Message ${LABEL[to]}…`}
              submitLabel="send"
              autoFocus
              onSubmit={(value: string) => {
                if (value.trim()) void post($, 'you', value.trim())
              }}
            />
            <Box gap={1}>
              {AGENTS.map(agent => (
                <Button
                  key={`to-${agent}`}
                  label={LABEL[agent]}
                  variant={agent === to ? 'primary' : 'secondary'}
                  dimColor={agent !== to}
                  onPress={() => setDefaultAgent($, agent)}
                />
              ))}
            </Box>
          </Box>
        ) : (
          <Text dimColor>{`Send with /ask @${to} <message>`}</Text>
        )}
      </Box>
      {!Client && (isBusy || state.messages.length > 0) && (
        <Box width="100%" justifyContent="flex-end" gap={1}>
          {isBusy && <Button key="interrupt" label="Interrupt" variant="secondary" onPress={() => interrupt($)} />}
          {state.messages.length > 0 && <Button key="share" label="Send to main" variant="secondary" dimColor onPress={() => sendRoomToMain($)} />}
          {state.messages.length > 0 && <Button key="new" label="New chat" variant="secondary" dimColor onPress={() => resetRoom($)} />}
        </Box>
      )}
    </Box>
  )
}

// `/room model`: every agent's model; `/room model codex gpt-6-luna low` picks one (the terminal's
// and the phone's picker; the desktop has one in the message box).
export function parseModelArgs(words: readonly string[]): { agent?: Agent; model?: string; effort?: string } | { error: string } {
  if (words.length === 0) return {}
  const agent = words[0]?.replace(/^@/, '').toLowerCase() as Agent
  if (!AGENTS.includes(agent)) return { error: `Unknown agent "${words[0]}". Usage: /room model [codex|cursor|claude] [model] [effort]` }
  return { agent, ...(words[1] ? { model: words[1] } : {}), ...(words[2] ? { effort: words[2] } : {}) }
}

async function modelCommand($: EngineInterface, words: readonly string[]): Promise<string> {
  const parsed = parseModelArgs(words)
  if ('error' in parsed) return parsed.error
  if (parsed.agent && parsed.model === 'reset') {
    const prefs: ModelPrefs = { ...((await $.store.get('models')) as ModelPrefs | undefined) }
    delete prefs[parsed.agent]
    await $.store.set('models', prefs)
    await update($, room, r => ({ ...r, prefs }))
    return `${LABEL[parsed.agent]} is back on its own default model from its next session.`
  }
  if (parsed.agent && (parsed.model || parsed.effort)) {
    await pickModel($, parsed.agent, { ...(parsed.model ? { model: parsed.model } : {}), ...(parsed.effort ? { effort: parsed.effort } : {}) })
    return `${LABEL[parsed.agent]} will use ${[parsed.model, parsed.effort].filter(Boolean).join(' at ')} from its next message.`
  }
  const state = await read($, room)
  const lines = AGENTS.filter(agent => !parsed.agent || agent === parsed.agent).map(agent => {
    const known = state.models?.[agent]
    const label = modelLabel(known, state.prefs?.[agent]) || 'its default model'
    const choices = known?.model ? `\n  models: ${known.model.values.map(v => v.value).join(', ')}${known.effort ? `\n  effort: ${known.effort.values.map(v => v.value).join(', ')}` : ''}` : ''
    return `${LABEL[agent]}: ${label}${choices}`
  })
  const hint = AGENTS.some(agent => !state.models?.[agent]?.model) ? '\n\nAn agent lists its models once it has started in the room.' : ''
  return `${lines.join('\n')}${hint}\n\nPick with /room model <agent> <model> [effort]; /room model <agent> reset forgets the pick.`
}

// ---------- registration ----------

export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    // Inside the room's own Claude (a Claude Code session the bridge started), stay out of the way:
    // no commands, no tools, so it cannot open a room inside the room.
    if (await $.env.get('ROOM_MOD_IN_ROOM')) return next(e)
    // The room starts from the settings' default mode until the session says which it is in.
    const settings = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
    const defaultMode = (settings.permissions as { defaultMode?: unknown } | undefined)?.defaultMode
    if (!mainMode && typeof defaultMode === 'string') mainMode = defaultMode
    const prefs = ((await $.store.get('models').catch(() => undefined)) as ModelPrefs | undefined) ?? {}
    await update($, room, r => ({ ...r, prefs, access: accessFor(config.roomEdits, mainMode) }))
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
      $.command.register({
        name: 'room',
        description: 'Open the agent room: one chat with Codex, Cursor and a separate Claude',
        argumentHint: '[model [agent] [model] [effort]]',
      }),
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
      if (one.status === 'rejected') $.ui.toast(`room: ${String(one.reason)}`)
    }
    return next(e)
  })

  on('command.run', { command: ['second-opinion', 'room:second-opinion'] }, async ($, e) => {
    const { agents, focus } = parseReview(e.args)
    const { diff, what } = await changesToReview($)
    if (!diff) return { text: 'Nothing to review: no uncommitted changes and no commits. To just talk to them, try /room.' }

    await $.ui.open({ id: PANE, title: 'Second opinion' })
    for (const agent of agents) void runAgent($, agent, 'review', `review ${what}${focus ? `: ${focus}` : ''}`, reviewPrompt(diff, focus))
    return { text: `${agents.map(a => LABEL[a]).join(' and ')} reviewing ${what}. Results land in the Second opinion pane.` }
  })

  on('command.run', { command: ['delegate', 'room:delegate'] }, async ($, e) => {
    const parsed = parseDelegate(e.args)
    if ('error' in parsed) return { text: parsed.error }

    await $.ui.open({ id: PANE, title: 'Second opinion' })
    void runAgent($, parsed.agent, 'implement', parsed.task, implementPrompt(parsed.task))
    return { text: `${LABEL[parsed.agent]} is implementing: ${parsed.task}` }
  })

  on('command.run', { command: ['opinions', 'room:opinions'] }, async $ => {
    await $.ui.open({ id: PANE, title: 'Second opinion' })
    return { text: 'Second opinion pane opened.' }
  })

  // `/room:room` is the same command, declared in commands/ so a host lists it from the start.
  on('command.run', { command: ['room', 'room:room'] }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words[0]?.toLowerCase() === 'model') return { text: await modelCommand($, words.slice(1)) }
    await $.ui.open({ id: ROOM_PANE, title: 'Agent room', focus: true })
    return { text: 'Agent room opened.' }
  })

  // The main session's permission mode rides on these events; the room follows it.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await trackMode($, e.permission_mode)
    return next(e)
  })
  on('classic.PostToolUse', async ($, e, next) => {
    await trackMode($, e.permission_mode)
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    await trackMode($, e.permission_mode)
    return next(e)
  })

  // The desktop's surface modules post what the person did: composer.tsx what was sent, which
  // agent was picked and its model; controls.tsx answers to questions and the room's actions.
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'room-composer' && e.element !== 'room-controls') return next(e)
    const data = (e.data ?? {}) as { type?: string; text?: string; agent?: string; id?: string; optionId?: string; value?: string }
    const agent = AGENTS.includes(data.agent as Agent) ? (data.agent as Agent) : undefined
    switch (data.type) {
      case 'send':
        if (data.text?.trim()) void post($, 'you', data.text.trim())
        break
      case 'to':
        if (agent) await setDefaultAgent($, agent)
        if (agent && (data as { models?: boolean }).models) void loadModels($, agent)
        break
      case 'models':
        if (agent) void loadModels($, agent)
        break
      case 'model':
      case 'effort':
        if (agent && data.value) void pickModel($, agent, { [data.type]: data.value })
        break
      case 'answer':
        if (data.id) void answerPermission($, data.id, data.optionId || null)
        break
      case 'interrupt':
        void interrupt($)
        break
      case 'share':
        void sendRoomToMain($)
        break
      case 'reset':
        void resetRoom($)
        break
    }
    return {}
  })

  on('command.run', { command: ['ask', 'room:ask'] }, async ($, e) => {
    await $.ui.open({ id: ROOM_PANE, title: 'Agent room', focus: true })
    const text = normalizeAsk(e.args)
    if (!text) return { text: 'Agent room opened.' }
    const turns = await post($, 'you', text)
    return { text: turns.length ? 'Sent to the agent room.' : 'Sent to the main session.' }
  })

  on('tool.call', { tool: 'mcp__room__ask_agent' }, async ($, e) => {
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

  on('tool.call', { tool: 'mcp__room__delegate_task' }, async ($, e) => {
    const input = e as unknown as { agent: External; task: string }
    if (!EXTERNAL.includes(input.agent)) return { deny: `agent must be one of ${EXTERNAL.join(', ')}` }
    if (!input.task?.trim()) return { deny: 'task is required' }
    void $.ui.open({ id: PANE, title: 'Second opinion' })
    const run = await runAgent($, input.agent, 'implement', input.task.slice(0, 120), implementPrompt(input.task))
    return { result: `${LABEL[run.agent]} (implement, ${run.status}, ${seconds(run, run.endedAt ?? 0)}):\n\n${run.result}` }
  }).catch(($, e, next) => ({ deny: `delegate_task failed (${next.error.kind}): ${next.error.message ?? 'no message'}` }))

  on('ui.render', { component: 'Pane', requestId: 'agent-room' }, ($, e) => renderRoom($, e, e.props.scroll?.bodyRows ?? 0))

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
