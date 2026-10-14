import type { EngineInterface, ModelUsage, Register, RenderInput } from 'claude-code'

const TICK_MS = 60_000
const HOUR = 60 * 60_000
// After a cold write was paid, keep the cache warm at least this long, so it isn't paid twice.
const AFTER_COLD_WRITE_MS = 3 * HOUR
const KEEP_WARM_PROMPT = 'Automated cache keep-alive from the cache-keeper mod; nothing needs doing. Reply with the single word: ok'
const HANDOFF_PROMPT =
  'This conversation is about to be cleared to save re-caching it, and you will continue the work in a fresh one. Write a handoff to yourself: ' +
  'the goal, what is done, what is in progress, decisions made and why, open problems with exact errors and file paths, and the next step. ' +
  'At most 300 words. Reply with the handoff only.'

// ---------- settings ----------

export type AtExpiry = 'nothing' | 'compact' | 'handoff'
// refuse: drop a costly cold send once with its price, the resend goes through; warn: say the price and send.
export type Guard = 'refuse' | 'warn' | 'off'
export type Config = {
  keepWarm: boolean
  keepWarmHours: number
  atExpiry: AtExpiry
  cacheTtlMinutes: number
  leadMinutes: number
  coldGuard: Guard
  guardMinTokens: number
  showRow: boolean
}
export const DEFAULT_CONFIG: Config = {
  keepWarm: true,
  keepWarmHours: 2,
  atExpiry: 'nothing',
  cacheTtlMinutes: 60,
  leadMinutes: 5,
  coldGuard: 'refuse',
  guardMinTokens: 50_000,
  showRow: true,
}

export function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)
  const ttl = Math.min(24 * 60, Math.max(1, num(options.cacheTtlMinutes, DEFAULT_CONFIG.cacheTtlMinutes)))
  const atExpiry = options.atExpiry as AtExpiry
  const guard = options.coldGuard as Guard
  return {
    keepWarm: typeof options.keepWarm === 'boolean' ? options.keepWarm : DEFAULT_CONFIG.keepWarm,
    keepWarmHours: Math.min(24, num(options.keepWarmHours, DEFAULT_CONFIG.keepWarmHours)),
    atExpiry: ['nothing', 'compact', 'handoff'].includes(atExpiry) ? atExpiry : DEFAULT_CONFIG.atExpiry,
    cacheTtlMinutes: ttl,
    leadMinutes: Math.min(ttl / 2, Math.max(0.5, num(options.leadMinutes, DEFAULT_CONFIG.leadMinutes))),
    coldGuard: ['refuse', 'warn', 'off'].includes(guard) ? guard : DEFAULT_CONFIG.coldGuard,
    guardMinTokens: num(options.guardMinTokens, DEFAULT_CONFIG.guardMinTokens),
    showRow: typeof options.showRow === 'boolean' ? options.showRow : DEFAULT_CONFIG.showRow,
  }
}

// ---------- prices ----------

// $ per million tokens: input, cache read, output; Anthropic's list prices, October 2026. A cache
// write costs twice the input price on the 1-hour cache and 1.25 times on the 5-minute one.
// Longer family names first: a model id matches the first row it contains.
const PRICES: [family: string, input: number, read: number, output: number][] = [
  ['fable-5-1', 10, 0.25, 50],
  ['mythos-5-1', 10, 0.25, 50],
  ['fable-5', 10, 1, 50],
  ['mythos-5', 10, 1, 50],
  ['opus-5-5', 4, 0.2, 20],
  ['opus-5', 5, 0.5, 25],
  ['opus-4-1', 15, 1.5, 75],
  ['opus-4-2025', 15, 1.5, 75],
  ['opus-4', 5, 0.5, 25],
  ['sonnet-5', 2, 0.2, 10],
  ['sonnet-4', 3, 0.3, 15],
  ['haiku-4', 1, 0.1, 5],
]

export type Price = { input: number; read: number; write: number; output: number }

export function priceOf(model: string | undefined, ttlMinutes: number): Price | undefined {
  const id = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  const row = PRICES.find(([family]) => id.includes(family))
  if (!row) return undefined
  const [, input, read, output] = row
  return { input, read, write: input * (ttlMinutes > 5 ? 2 : 1.25), output }
}

// What one keep-warm cost: the cache read, any write, its own uncached tokens and its answer.
export function pingUsd(u: ModelUsage, price: Price): number {
  return (u.cache_read_input_tokens * price.read + u.cache_creation_input_tokens * price.write + u.input_tokens * price.input + u.output_tokens * price.output) / 1e6
}

// How many keep-warms, at the read price alone, cost as much as one cold write: an upper bound.
export function breakEven(price: Price): number {
  return Math.floor(price.write / price.read)
}

export function usd(n: number | undefined): string {
  if (n === undefined) return 'n/a'
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`
}

export function tokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// ---------- the decision ----------

// lastWarmAt: when the last main-thread request (a turn's step or a keep-warm) started; the cache's
// lifetime counts from there. lastActiveAt: when Claude last answered; the keep-warm window counts
// from it. holdUntil: keep warm at least until then (a cold write was just paid). stopped: why
// keep-warms stopped until the next turn (one found the cache already gone).
export type Clock = { lastWarmAt?: number; lastActiveAt?: number; busy: boolean; settled: boolean; holdUntil?: number; stopped?: string }
export type Action = 'wait' | 'keep-warm' | 'compact' | 'handoff' | 'let-expire' | 'expired'

export function decide(s: Clock, cfg: Config, now: number): Action {
  if (s.lastWarmAt === undefined || s.busy || s.settled) return 'wait'
  const expiresAt = s.lastWarmAt + cfg.cacheTtlMinutes * 60_000
  // Past expiry already (the machine slept, say): nothing is left to save.
  if (now >= expiresAt) return 'expired'
  if (now < expiresAt - cfg.leadMinutes * 60_000) return 'wait'
  // Keep warm while the window the person asked for reaches past this expiry.
  const windowEnd = Math.max((s.lastActiveAt ?? s.lastWarmAt) + cfg.keepWarmHours * HOUR, s.holdUntil ?? 0)
  if (cfg.keepWarm && !s.stopped && windowEnd > expiresAt) return 'keep-warm'
  return cfg.atExpiry === 'nothing' ? 'let-expire' : cfg.atExpiry
}

export function isCold(s: Clock, cfg: Config, now: number): boolean {
  return s.lastWarmAt !== undefined && now - s.lastWarmAt >= cfg.cacheTtlMinutes * 60_000
}

// ---------- the cold-send guard ----------

// pass: send it; warn: send it and say the price; refuse: drop it once with the price; resend: the
// person sent it again after a refusal, so it goes through.
export type Verdict = 'pass' | 'warn' | 'refuse' | 'resend'

export function judgeSend(s: Clock, cfg: Config, now: number, context: number, ackedAt: number | undefined): Verdict {
  if (cfg.coldGuard === 'off' || !isCold(s, cfg, now) || context < cfg.guardMinTokens) return 'pass'
  if (cfg.coldGuard === 'warn') return 'warn'
  return ackedAt === s.lastWarmAt ? 'resend' : 'refuse'
}

export function coldText(s: Clock, cfg: Config, now: number, context: number, price: Price | undefined): string {
  const ago = duration(now - (s.lastWarmAt ?? now) - cfg.cacheTtlMinutes * 60_000)
  const rate = price ? ` at $${price.write}/MTok ≈ ${usd((context * price.write) / 1e6)}` : ''
  const warm = price ? ` (a warm turn would have read it for ${usd((context * price.read) / 1e6)})` : ''
  return `the prompt cache went cold ${ago} ago. Sending this re-writes up to ${context.toLocaleString('en-US')} tokens${rate}${warm}.`
}

// ---------- /keepwarm arguments ----------

export type Patch = Partial<Pick<Config, 'keepWarm' | 'keepWarmHours' | 'atExpiry' | 'coldGuard'>>

const USAGE = '/keepwarm [on|off] [<hours>h|<minutes>m] [nothing|compact|handoff] [guard refuse|warn|off] [now]'

export function parseArgs(args: string): { patch: Patch; now: boolean } | { error: string } {
  const patch: Patch = {}
  let now = false
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? ''
    const hours = /^(\d+(?:\.\d+)?)h?$/.exec(word)
    const minutes = /^(\d+)m$/.exec(word)
    if (word === 'on' || word === 'off') patch.keepWarm = word === 'on'
    else if (hours) Object.assign(patch, { keepWarm: true, keepWarmHours: Math.min(24, Number(hours[1])) })
    else if (minutes) Object.assign(patch, { keepWarm: true, keepWarmHours: Number(minutes[1]) / 60 })
    else if (word === 'compact' || word === 'handoff' || word === 'nothing') patch.atExpiry = word
    else if (word === 'now') now = true
    else if (word === 'status') continue
    else if (word === 'guard') {
      const mode = words[i + 1]
      if (mode !== 'refuse' && mode !== 'warn' && mode !== 'off') return { error: `guard takes refuse, warn or off. Usage: ${USAGE}` }
      patch.coldGuard = mode
      i += 1
    } else return { error: `Unknown option "${word}". Usage: ${USAGE}` }
  }
  return { patch, now }
}

// ---------- drawing ----------

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${h}h`
}

export type Outcome = 'expired' | 'let-expire' | 'compacted' | 'handed-off'

export function statusText(s: Clock, cfg: Config, now: number, keeps: number, outcome?: Outcome): string | undefined {
  if (outcome === 'compacted') return 'cache: compacted'
  if (outcome === 'handed-off') return 'cache: cleared with a handoff'
  if (s.lastWarmAt === undefined) return undefined
  const left = s.lastWarmAt + cfg.cacheTtlMinutes * 60_000 - now
  if (outcome === 'expired' || left <= 0) return '❄ cache cold'
  const parts = [`🔥 cache ${duration(left)}`]
  if (keeps > 0) parts.push(`kept warm ${keeps}×`)
  if (s.stopped) parts.push('keep-warm stopped')
  else if (!cfg.keepWarm || cfg.keepWarmHours === 0) parts.push('keep-warm off')
  if (cfg.atExpiry !== 'nothing') parts.push(`then ${cfg.atExpiry}`)
  return parts.join(' · ')
}

// The row above the prompt: the cache's state word and what is known about it.
export type RowState = 'warm' | 'cold' | 'unknown'
export function rowParts(
  s: Clock,
  cfg: Config,
  now: number,
  info: { keeps: number; lastPing?: { read: number; usd?: number }; context: number; price?: Price; outcome?: Outcome },
): { state: RowState; text: string } | undefined {
  if (info.outcome === 'compacted') return { state: 'unknown', text: `compacted · the next message caches the summary${info.context ? ` (${tokens(info.context)})` : ''}` }
  if (info.outcome === 'handed-off') return { state: 'unknown', text: 'cleared with a handoff' }
  if (s.lastWarmAt === undefined) return undefined
  if (isCold(s, cfg, now) || info.outcome === 'expired') {
    const cost = info.price && info.context ? ` · the next send re-writes ${tokens(info.context)} (${usd((info.context * info.price.write) / 1e6)})` : ''
    return { state: 'cold', text: `for ${duration(now - s.lastWarmAt - cfg.cacheTtlMinutes * 60_000)}${cost}` }
  }
  const parts = [`${duration(s.lastWarmAt + cfg.cacheTtlMinutes * 60_000 - now)} left`]
  if (info.keeps > 0) parts.push(`kept warm ${info.keeps}×`)
  if (info.lastPing) parts.push(`last ping read ${tokens(info.lastPing.read)}${info.lastPing.usd !== undefined ? ` ${usd(info.lastPing.usd)}` : ''}`)
  if (s.stopped) parts.push(`keep-warm stopped: ${s.stopped}`)
  else if (!cfg.keepWarm || cfg.keepWarmHours === 0) parts.push('keep-warm off')
  if (cfg.atExpiry !== 'nothing') parts.push(`then ${cfg.atExpiry}`)
  return { state: 'warm', text: parts.join(' · ') }
}

// ---------- state ----------

type Keep = { at: number; usage: ModelUsage; usd?: number; read: number }
type ColdWrite = { at: number; tokens: number; usd?: number }

let config: Config = DEFAULT_CONFIG
let overrides: Patch = {}
const clock: Clock = { busy: false, settled: false }
let acting = false
let outcome: Outcome | undefined
let keeps: Keep[] = []
let ticker: { cancel: () => void } | undefined
// The main conversation: its model, the live context size, and the session's paid cold writes.
let model: string | undefined
let context = 0
let coldWrites: ColdWrite[] = []
// The lastWarmAt the guard already refused a send for; a send under the same clock goes through.
let ackedAt: number | undefined
let coldWritePending = false
// The message the guard refused, held above the prompt with its choices until one is picked or
// another message goes through. doing: the choice running (a compaction takes a minute or two);
// note: why the last choice failed.
type Held = { text: string; canResend: boolean; doing?: string; note?: string }
let held: Held | undefined
let compactions = 0
// The settings pane: a keep-warm it started is running; what the last one said.
let pinging = false
let paneNote: string | undefined

function effective(): Config {
  return { ...config, ...overrides }
}

function price(): Price | undefined {
  return priceOf(model, effective().cacheTtlMinutes)
}

// Redraw the row (or the status line where the row is off) and the settings pane.
async function refresh($: EngineInterface) {
  const cfg = effective()
  $.ui.status(cfg.showRow ? undefined : statusText(clock, cfg, await $.clock.now(), keeps.length, outcome))
  $.ui.invalidate('ui.render')
}

// ---------- actions ----------

async function keepWarm($: EngineInterface): Promise<string> {
  const reply = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
  const now = await $.clock.now()
  // A resumed session has no request of this process to fork until its first turn; its clock (from
  // the resume) still tells the guard when the cache goes cold.
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    if (clock.lastWarmAt === undefined) return 'Nothing to keep warm yet.'
    clock.stopped = 'nothing to fork before the first message of this session'
    return `Keep-warm waits for your next message: ${clock.stopped}.`
  }
  if (!('usage' in reply)) return 'Keep-warm failed: no usage came back.'
  const { cache_read_input_tokens: read, cache_creation_input_tokens: written } = reply.usage
  const p = price()
  const cost = p ? pingUsd(reply.usage, p) : undefined
  // Any request that went out restarted the timer, even one whose reply came back empty.
  clock.lastWarmAt = now
  clock.settled = false
  outcome = undefined
  keeps.push({ at: now, usage: reply.usage, usd: cost, read })
  const paid = cost !== undefined ? ` (${usd(cost)})` : ''
  // A warm keep-warm reads the conversation and writes only its own few tokens. Writing a tenth of
  // what it read or more means the cache was already gone; stop until the next turn rather than
  // pay that write again on every keep-warm.
  if (read === 0 || written >= 0.1 * read) {
    clock.stopped = `it read ${tokens(read)} and wrote ${tokens(written)}${paid}: the cache was already gone`
    return `Keep-warm stopped until your next message: ${clock.stopped}.`
  }
  return `Kept warm: read ${tokens(read)} cached tokens, wrote ${tokens(written)}${paid}.${reply.isAnswered ? '' : ` (${reply.reason})`}`
}

async function compact($: EngineInterface): Promise<string> {
  const before = compactions
  // Headless sessions (-p, the SDK) compact only through the /compact command for now.
  const result: { skip?: string; tokensAfter?: number } = await $.session.compact().catch(async () => {
    await $.command.run({ command: 'compact' })
    return {}
  })
  if (result.skip) return `Compaction skipped: ${result.skip}`
  // This plugin's session.compact hook may not see its own compaction: settle it here then.
  if (compactions === before) afterCompaction(result.tokensAfter)
  return 'Compacted the conversation before its cache expired.'
}

// A compaction replaces the conversation with its summary: the old cache has nothing left to save,
// and the next message writes the summary whatever the clock says. The live usage still reads the
// size before compaction until the next answer, so the size is the compaction's own count.
function afterCompaction(tokensAfter: number | undefined) {
  compactions += 1
  context = tokensAfter ?? 0
  ackedAt = undefined
  held = undefined
  outcome = 'compacted'
  Object.assign(clock, { lastWarmAt: undefined, stopped: undefined, settled: false })
}

async function handoff($: EngineInterface): Promise<string> {
  const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
  if (!reply.isAnswered) return `Could not write a handoff (${reply.reason}); the conversation was left as it is.`
  const text = reply.text.trim()
  await $.command.run({ command: 'clear' })
  outcome = 'handed-off'
  clock.lastWarmAt = undefined
  await $.session.append({
    message: {
      type: 'user',
      content: [{ type: 'text', text: `The cache-keeper mod cleared the previous conversation while the user was away, before its prompt cache expired. This is the handoff you wrote before it was cleared:\n\n<handoff>\n${text}\n</handoff>` }],
    },
  })
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `Cache keeper cleared the conversation before its cache expired. Claude has this handoff:\n\n${text}` }] } })
  return 'Cleared the conversation with a handoff.'
}

// ---------- the held message ----------

export type HeldChoice = 'send' | 'compact' | 'clear' | 'discard'

// What the card above the prompt says of a held message: why it was held, what sending it costs.
export function heldCard(
  h: Pick<Held, 'text' | 'canResend' | 'doing' | 'note'>,
  s: Clock,
  cfg: Config,
  now: number,
  context: number,
  price: Price | undefined,
): { reason: string; preview: string; sendLabel: string; doing?: string; note?: string } {
  const ago = s.lastWarmAt !== undefined ? ` ${duration(now - s.lastWarmAt - cfg.cacheTtlMinutes * 60_000)} ago` : ''
  const cost = price ? usd((context * price.write) / 1e6) : undefined
  const warm = price ? ` (a warm cache would read it for ${usd((context * price.read) / 1e6)})` : ''
  const line = h.text.trim().split('\n')[0] ?? ''
  return {
    reason: `Message held: the cache went cold${ago}. Sending it re-writes ${tokens(context)} tokens${cost ? ` ≈ ${cost}` : ''}${warm}.`,
    preview: line.length > 120 ? `${line.slice(0, 119)}…` : line,
    sendLabel: h.canResend ? `Send anyway${cost ? ` · ${cost}` : ''}` : 'Put it back to send',
    ...(h.doing ? { doing: h.doing } : {}),
    ...(h.note ? { note: h.note } : {}),
  }
}

// Takes the held text out of the prompt box, where a host that keeps a refused draft left it.
async function takeDraft($: EngineInterface, text: string) {
  const box = await $.prompt.read()
  if (box.text.trim() === text.trim()) await $.prompt.fill({ text: '' })
}

async function chooseHeld($: EngineInterface, choice: HeldChoice) {
  const h = held
  if (!h || h.doing) return
  try {
    if (choice === 'discard') {
      held = undefined
      // The next message is guarded again.
      ackedAt = undefined
      await takeDraft($, h.text)
    } else if (choice === 'send' && h.canResend) {
      held = undefined
      ackedAt = undefined
      coldWritePending = true
      await takeDraft($, h.text)
      // This plugin's own guard never sees its own submission.
      void $.prompt.submit({ text: h.text, asUser: true })
    } else if (choice === 'send') {
      // Images can't be submitted again from here: the text goes back in the box, and the guard
      // lets the next Enter through.
      held = undefined
      const box = await $.prompt.read()
      if (box.text.trim() !== h.text.trim()) await $.prompt.fill({ text: h.text })
      $.ui.log('cache-keeper: your message is back in the prompt box; press Enter to send it (attach its images again if they are gone).')
    } else if (choice === 'compact') {
      held = { ...h, doing: 'Compacting… a minute or two for a long conversation.', note: undefined }
      await refresh($)
      const before = compactions
      const said = await compact($)
      if (compactions === before) {
        held = { ...h, doing: undefined, note: said }
      } else {
        await takeDraft($, h.text)
        void $.prompt.submit({ text: h.text, asUser: true })
      }
    } else {
      held = { ...h, doing: 'Clearing…' }
      await refresh($)
      await $.command.run({ command: 'clear' })
      held = undefined
      await $.prompt.fill({ text: h.text })
    }
  } catch (error) {
    held = { ...h, doing: undefined, note: `That failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  await refresh($)
}

async function tick($: EngineInterface) {
  const cfg = effective()
  const now = await $.clock.now()
  const action = acting ? 'wait' : decide(clock, cfg, now)
  if (action !== 'wait') {
    acting = true
    try {
      if (action === 'expired' || action === 'let-expire') {
        clock.settled = true
        outcome = action
      } else {
        const said = action === 'keep-warm' ? await keepWarm($) : action === 'compact' ? await compact($) : await handoff($)
        if (action !== 'keep-warm') clock.settled = true
        $.ui.log(`cache-keeper: ${said}`)
      }
    } catch (error) {
      $.ui.log(`cache-keeper: ${action} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      acting = false
    }
  }
  await refresh($)
}

function report(now: number): string {
  const cfg = effective()
  const p = price()
  const lines = [statusText(clock, cfg, now, keeps.length, outcome) ?? 'No conversation cached yet.']
  if (context > 0) {
    const costs = p ? `: a cold send re-writes it for about ${usd((context * p.write) / 1e6)}, a warm one reads it for ${usd((context * p.read) / 1e6)}` : ''
    lines.push(`Context ${context.toLocaleString('en-US')} tokens on ${model ?? 'a model not seen yet'}${costs}.`)
  }
  lines.push(
    `Keep warm: ${cfg.keepWarm && cfg.keepWarmHours > 0 ? `on, for ${duration(cfg.keepWarmHours * HOUR)} after Claude's last answer` : 'off'}${clock.holdUntil && clock.holdUntil > now && cfg.keepWarm ? ` (at least ${duration(clock.holdUntil - now)} more after a cold write)` : ''}. Before the cache finally expires: ${cfg.atExpiry}.`,
  )
  if (clock.stopped) lines.push(`Keep-warm stopped until your next message: ${clock.stopped}.`)
  const guard = cfg.coldGuard === 'refuse' ? 'refuse once with the price; the resend goes through' : cfg.coldGuard === 'warn' ? 'show the price and send' : 'off'
  lines.push(`Cold-send guard (contexts over ${tokens(cfg.guardMinTokens)}): ${guard}.`)
  lines.push(`Cache lifetime ${cfg.cacheTtlMinutes}m; acting ${cfg.leadMinutes}m before expiry.`)
  if (keeps.length) {
    const read = keeps.reduce((sum, k) => sum + k.read, 0)
    const spent = keeps.every(k => k.usd !== undefined) ? `, ${usd(keeps.reduce((sum, k) => sum + (k.usd ?? 0), 0))}` : ''
    const last = keeps.at(-1)
    lines.push(`Keep-warms this session: ${keeps.length}, reading ${tokens(read)} cached tokens in all${spent}; the last read ${tokens(last?.read ?? 0)}${last?.usd !== undefined ? ` for ${usd(last.usd)}` : ''}.`)
  }
  if (p) {
    const pings = breakEven(p)
    lines.push(`Break-even: up to ${pings} keep-warms cost one cold write, about ${duration(pings * (cfg.cacheTtlMinutes - cfg.leadMinutes) * 60_000)} of being away.`)
  }
  const paid = coldWrites.reduce((sum, w) => sum + (w.usd ?? 0), 0)
  lines.push(`Cold writes paid this session: ${coldWrites.length}${coldWrites.length ? ` (${tokens(coldWrites.reduce((sum, w) => sum + w.tokens, 0))} tokens, ${usd(paid)})` : ''}.`)
  return lines.join('\n')
}

// ---------- the settings pane ----------

const PANE = 'cache-keeper'
const KEEP_HOURS = [0, 1, 2, 4, 8]
const EXPIRY_LABELS: Record<AtExpiry, [label: string, hint: string]> = {
  nothing: ['Let it expire', 'the next message re-writes the whole conversation'],
  compact: ['Compact', 'compacts while warm; the next message caches only the summary'],
  handoff: ['Hand off', 'Claude writes a handoff, then the conversation is cleared'],
}
const GUARD_LABELS: Record<Guard, [label: string, hint: string]> = {
  refuse: ['Hold it', 'held above the prompt with its price and your choices'],
  warn: ['Warn', 'shows the price and sends'],
  off: ['Off', 'sends without a word'],
}

// The keep-warm windows offered, with this session's own (from /keepwarm 90m, say) among them.
export function keepChoices(cfg: Config): number[] {
  const hours = cfg.keepWarm ? cfg.keepWarmHours : 0
  return KEEP_HOURS.includes(hours) ? KEEP_HOURS : [...KEEP_HOURS, hours].sort((a, b) => a - b)
}

async function setFromPane($: EngineInterface, patch: Patch) {
  overrides = { ...overrides, ...patch }
  paneNote = undefined
  await refresh($)
}

async function keepWarmFromPane($: EngineInterface) {
  if (pinging || acting) return
  pinging = acting = true
  paneNote = undefined
  await refresh($)
  try {
    paneNote = await keepWarm($)
  } catch (error) {
    paneNote = `Keep-warm failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    pinging = acting = false
  }
  await refresh($)
}

// The pane /keepwarm opens: the cache now, this session's settings as buttons, and the receipts.
// Its Buttons are the surface's own (a desktop's native ones); a press that crosses a redraw can be
// lost, and this pane redraws about once a minute while idle.
async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const cfg = effective()
  const now = await $.clock.now()
  const p = price()
  const last = keeps.at(-1)
  const row = rowParts(clock, cfg, now, { keeps: keeps.length, lastPing: last ? { read: last.read, usd: last.usd } : undefined, context, price: p, outcome })
  const color = row?.state === 'warm' ? 'success' : row?.state === 'cold' ? 'warning' : 'subtle'
  const hours = cfg.keepWarm ? cfg.keepWarmHours : 0
  const changed = (Object.keys(overrides) as (keyof Patch)[]).some(k => overrides[k] !== config[k])
  const chip = (key: string, label: string, on: boolean, patch: Patch) => (
    <Button key={key} label={label} variant={on ? 'primary' : 'secondary'} onPress={() => void setFromPane($, patch)} />
  )
  const keepHint = [
    hours > 0 ? "after Claude's last answer" : `the cache lapses ${duration(cfg.cacheTtlMinutes * 60_000)} after its last use`,
    clock.holdUntil && clock.holdUntil > now && cfg.keepWarm ? `at least ${duration(clock.holdUntil - now)} more after a cold write` : undefined,
  ].filter(Boolean)
  const read = keeps.reduce((sum, k) => sum + k.read, 0)
  const spent = keeps.length && keeps.every(k => k.usd !== undefined) ? ` · ${usd(keeps.reduce((sum, k) => sum + (k.usd ?? 0), 0))}` : ''
  const paid = coldWrites.reduce((sum, w) => sum + (w.usd ?? 0), 0)
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>●</Text>
        <Text dimColor> cache </Text>
        <Text color={color} bold>
          {row?.state ?? 'idle'}
        </Text>
        <Text dimColor>{` · ${row?.text ?? "nothing cached yet; the clock starts at Claude's first answer"}`}</Text>
      </Box>
      {context > 0 ? (
        <Text dimColor>
          {`${tokens(context)} tokens${model ? ` on ${model}` : ''}${p ? ` · a cold send ${usd((context * p.write) / 1e6)}, a warm one ${usd((context * p.read) / 1e6)}` : ''}`}
        </Text>
      ) : null}

      <Text bold>{'\nKeep warm for'}</Text>
      <Box gap={1} flexWrap="wrap">
        {keepChoices(cfg).map(h => chip(`keep-${h}`, h === 0 ? 'Off' : duration(h * HOUR), h === hours, h === 0 ? { keepWarm: false } : { keepWarm: true, keepWarmHours: h }))}
      </Box>
      <Text dimColor>{keepHint.join(' · ')}</Text>
      {clock.stopped ? <Text color="warning">{`Stopped until your next message: ${clock.stopped}.`}</Text> : null}

      <Text bold>{'\nBefore it expires'}</Text>
      <Box gap={1} flexWrap="wrap">
        {(['nothing', 'compact', 'handoff'] as const).map(a => chip(`expiry-${a}`, EXPIRY_LABELS[a][0], cfg.atExpiry === a, { atExpiry: a }))}
      </Box>
      <Text dimColor>{EXPIRY_LABELS[cfg.atExpiry][1]}</Text>

      <Text bold>{`\nA cold send over ${tokens(cfg.guardMinTokens)} tokens`}</Text>
      <Box gap={1} flexWrap="wrap">
        {(['refuse', 'warn', 'off'] as const).map(g => chip(`guard-${g}`, GUARD_LABELS[g][0], cfg.coldGuard === g, { coldGuard: g }))}
      </Box>
      <Text dimColor>{GUARD_LABELS[cfg.coldGuard][1]}</Text>

      {row?.state === 'warm' || pinging ? (
        <Box marginTop={1}>
          {pinging ? <Text color="warning">Keeping warm…</Text> : <Button key="keep-now" label="Keep warm now" onPress={() => void keepWarmFromPane($)} />}
        </Box>
      ) : null}
      {paneNote ? <Text dimColor>{paneNote}</Text> : null}

      <Text bold>{'\nThis session'}</Text>
      <Text dimColor>{keeps.length ? `${keeps.length} keep-warm${keeps.length === 1 ? '' : 's'} · read ${tokens(read)}${spent}` : 'No keep-warms yet'}</Text>
      <Text dimColor>
        {coldWrites.length
          ? `${coldWrites.length} cold write${coldWrites.length === 1 ? '' : 's'} paid · ${tokens(coldWrites.reduce((sum, w) => sum + w.tokens, 0))} · ${usd(paid)}`
          : 'No cold writes paid'}
      </Text>
      {p ? <Text dimColor>{`${breakEven(p)} keep-warms cost one cold write`}</Text> : null}

      <Box marginTop={1} gap={1} alignItems="center">
        <Text dimColor>This session only · defaults in /config</Text>
        {changed ? (
          <Button
            key="reset"
            label="Reset"
            variant="secondary"
            onPress={() => {
              overrides = {}
              void setFromPane($, {})
            }}
          />
        ) : null}
      </Box>
    </Box>
  )
}

function startTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => void tick($))
}

// /clear starts a new conversation in the same process: nothing priced before it exists any more.
function resetForClear() {
  context = 0
  coldWrites = []
  ackedAt = undefined
  coldWritePending = false
  held = undefined
  Object.assign(clock, { lastWarmAt: undefined, lastActiveAt: undefined, holdUntil: undefined, stopped: undefined, settled: false })
}

// Who is at this prompt: a person typing (in the terminal, the desktop app, on a phone), not a task,
// a schedule, another session or a plugin. An SDK prompt counts only where a surface is attached
// (the desktop app); a plain -p run has none, and nobody there could send it again.
async function isPersonSending($: EngineInterface, kind: string | undefined): Promise<boolean> {
  if (kind === undefined || kind === 'composer' || kind === 'bridge') return true
  if (kind === 'sdk') return (await $.session.surfaces()).length > 0
  return false
}

// ---------- registration ----------

// Each command is also declared in commands/, so a host lists it as `/cache-keeper:<name>` before
// any session exists (the desktop app's empty chat); the hooks answer both spellings.
export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command
      .register({
        name: 'keepwarm',
        description: "Cache keeper: open this session's cache settings, or change them with arguments",
        argumentHint: '[on|off] [2h|90m] [nothing|compact|handoff] [guard refuse|warn|off] [now]',
        immediate: true,
      })
      .catch(() => undefined)
    const live = (await $.session.usage().catch(() => undefined))?.context.tokens
    if (live) context = live
    startTicker($)
    await refresh($)
    return started
  })

  // A resumed session says how long ago it last answered and how big it is, so the guard knows
  // before the first message whether that message would re-write it.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') {
      resetForClear()
      await refresh($)
      return result
    }
    if (e.source !== 'resume' && e.source !== 'fork') return result
    const now = await $.clock.now()
    if (typeof e.context_tokens === 'number' && e.context_tokens > 0) context = e.context_tokens
    if (typeof e.seconds_since_last_response === 'number') {
      clock.lastWarmAt = now - e.seconds_since_last_response * 1000
      clock.lastActiveAt = clock.lastWarmAt
      clock.settled = isCold(clock, effective(), now)
    }
    model = typeof e.model === 'string' ? e.model : (model ?? (await $.session.model()))
    if (e.prompt_cache_likely_expired === true && context >= effective().guardMinTokens) {
      const cost = typeof e.estimated_cache_write_usd === 'number' ? e.estimated_cache_write_usd : price() ? (context * (price()?.write ?? 0)) / 1e6 : undefined
      $.ui.log(`cache-keeper: resuming cold. The first message re-writes ${context.toLocaleString('en-US')} tokens, about ${usd(cost)}. /compact or /clear first if you only need the conclusions.`)
    }
    await refresh($)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') ticker?.cancel()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    clock.busy = true
    return next(e)
  })

  // The cache's lifetime counts from the start of each request: stamp every main-thread step.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) clock.lastWarmAt = await $.clock.now()
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const now = await $.clock.now()
    // A turn none of whose steps was stamped started its last request no earlier than its end.
    if (clock.lastWarmAt === undefined || now - clock.lastWarmAt > e.durationMs) clock.lastWarmAt = now
    Object.assign(clock, { busy: false, settled: false, lastActiveAt: now, stopped: undefined })
    // The first turn after a compaction writes the summary: no cold write, whatever it wrote.
    const afterCompact = outcome === 'compacted'
    outcome = undefined
    ackedAt = undefined
    held = undefined
    const u = e.usage
    if (u) {
      if (u.model) model = u.model
      const before = context
      const live = (await $.session.usage().catch(() => undefined))?.context.tokens
      context = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const written = u.cache_creation_input_tokens
      // A cold write: the guard let one through, or this turn wrote half of a big context again.
      if (coldWritePending || (!afterCompact && before > 20_000 && written >= 0.5 * before)) {
        const p = price()
        const cost = p ? (written * p.write) / 1e6 : undefined
        coldWrites.push({ at: now, tokens: written, usd: cost })
        if (effective().keepWarm) {
          clock.holdUntil = now + AFTER_COLD_WRITE_MS
          $.ui.log(`cache-keeper: a cold write of ${tokens(written)} tokens was paid${cost !== undefined ? ` (${usd(cost)})` : ''}. Keeping the cache warm for at least ${duration(AFTER_COLD_WRITE_MS)} so it isn't paid again; /keepwarm off to stop.`)
        }
      }
    }
    coldWritePending = false
    await refresh($)
    return done
  })

  // A precompute installs nothing, and a skip leaves the conversation as it was.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
      afterCompaction(done.tokensAfter)
      await refresh($)
    }
    return done
  })

  // The message that pays for a cold cache. Only whether it is a slash command is read of its text.
  on('prompt.submit', async ($, e, next) => {
    if (!(await isPersonSending($, e.origin?.kind)) || e.text.trimStart().startsWith('/')) return next(e)
    const cfg = effective()
    const now = await $.clock.now()
    const verdict = judgeSend(clock, cfg, now, context, ackedAt)
    if (verdict === 'pass') return next(e)
    const said = coldText(clock, cfg, now, context, price())
    const hold = cfg.keepWarm ? ` Keep-warm then holds the cache for ${duration(AFTER_COLD_WRITE_MS)}.` : ''
    if (verdict === 'warn') {
      $.ui.log(`cache-keeper: ${said} Sending it.${hold}`)
      coldWritePending = true
      return next(e)
    }
    if (verdict === 'resend') {
      ackedAt = undefined
      coldWritePending = true
      held = undefined
      await refresh($)
      return next(e)
    }
    ackedAt = clock.lastWarmAt
    held = { text: e.text, canResend: !e.attachments?.length }
    await refresh($)
    return { drop: `cache-keeper: ${said} Your message is held above the prompt: send it anyway, compact or clear first, or discard it. Sending it again also pays it.${hold}` }
  })

  // Bare, it opens the settings pane; with arguments (or `status`), it answers in text, which is
  // also what a surface that places no pane (a phone, a -p run) gets.
  on('command.run', { command: ['keepwarm', 'cache-keeper:keepwarm'] }, async ($, e) => {
    if (!e.args.trim()) {
      const opened = await $.ui.open({ id: PANE, title: 'Cache keeper' }).catch((error: unknown) => ({ isPlaced: false as const, reason: String(error) }))
      if (opened.isPlaced) return { text: 'Cache keeper settings are open in the pane.' }
      return { text: report(await $.clock.now()) }
    }
    const parsed = parseArgs(e.args)
    if ('error' in parsed) return { text: parsed.error }
    overrides = { ...overrides, ...parsed.patch }
    let said = ''
    if (parsed.now) said = `${await keepWarm($)}\n`
    const now = await $.clock.now()
    await refresh($)
    return { text: `${said}${report(now)}` }
  })

  // Above the prompt: one row with the cache's state, its time left, the keep-warms and their cost;
  // and while the guard holds a message, a card with its choices.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const cfg = effective()
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return rest
    const now = await $.clock.now()
    const last = keeps.at(-1)
    const row = cfg.showRow
      ? rowParts(clock, cfg, now, { keeps: keeps.length, lastPing: last ? { read: last.read, usd: last.usd } : undefined, context, price: price(), outcome })
      : undefined
    const card = held ? heldCard(held, clock, cfg, now, context, price()) : undefined
    if (!row && !card) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const color = row?.state === 'warm' ? 'success' : row?.state === 'cold' ? 'warning' : 'subtle'
    return (
      <Box flexDirection="column">
        {rest}
        {row ? (
          <Box>
            <Text color={color}>●</Text>
            <Text dimColor> cache </Text>
            <Text color={color} bold>
              {row.state}
            </Text>
            <Text dimColor>{` · ${row.text}`}</Text>
          </Box>
        ) : null}
        {card ? (
          <Box flexDirection="column" width="100%" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text>{card.reason}</Text>
            <Text dimColor wrap="truncate-end">{`“${card.preview}”`}</Text>
            {card.note ? <Text color="error">{card.note}</Text> : null}
            {card.doing ? (
              <Text color="warning">{card.doing}</Text>
            ) : (
              <Box flexDirection="column">
                <Box gap={1} flexWrap="wrap">
                  <Button key="held-send" hotkey="1" label={card.sendLabel} variant="primary" onPress={() => chooseHeld($, 'send')} />
                  <Button key="held-compact" hotkey="2" label="Compact, then send" onPress={() => chooseHeld($, 'compact')} />
                  <Button key="held-clear" hotkey="3" label="Clear, keep draft" onPress={() => chooseHeld($, 'clear')} />
                  <Button key="held-discard" hotkey="4" label="Discard" dimColor onPress={() => chooseHeld($, 'discard')} />
                </Box>
                {e.surface === 'terminal' ? <Text dimColor>click one, or ctrl+x tab then 1–4</Text> : null}
              </Box>
            )}
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => renderPane($, e))
}
