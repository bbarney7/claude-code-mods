import type { EngineInterface, ModelUsage, Register } from 'claude-code'

const TICK_MS = 60_000
const HOUR = 60 * 60_000
const KEEP_WARM_PROMPT = 'Automated cache keep-alive from the cache-keeper mod; nothing needs doing. Reply with the single word: ok'
const HANDOFF_PROMPT =
  'This conversation is about to be cleared to save re-caching it, and you will continue the work in a fresh one. Write a handoff to yourself: ' +
  'the goal, what is done, what is in progress, decisions made and why, open problems with exact errors and file paths, and the next step. ' +
  'At most 300 words. Reply with the handoff only.'

// ---------- settings ----------

export type AtExpiry = 'nothing' | 'compact' | 'handoff'
export type Config = { keepWarm: boolean; keepWarmHours: number; atExpiry: AtExpiry; cacheTtlMinutes: number; leadMinutes: number }
export const DEFAULT_CONFIG: Config = { keepWarm: true, keepWarmHours: 2, atExpiry: 'nothing', cacheTtlMinutes: 60, leadMinutes: 5 }

export function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)
  const ttl = Math.min(24 * 60, Math.max(1, num(options.cacheTtlMinutes, DEFAULT_CONFIG.cacheTtlMinutes)))
  const atExpiry = options.atExpiry as AtExpiry
  return {
    keepWarm: typeof options.keepWarm === 'boolean' ? options.keepWarm : DEFAULT_CONFIG.keepWarm,
    keepWarmHours: Math.min(24, num(options.keepWarmHours, DEFAULT_CONFIG.keepWarmHours)),
    atExpiry: ['nothing', 'compact', 'handoff'].includes(atExpiry) ? atExpiry : DEFAULT_CONFIG.atExpiry,
    cacheTtlMinutes: ttl,
    leadMinutes: Math.min(ttl / 2, Math.max(0.5, num(options.leadMinutes, DEFAULT_CONFIG.leadMinutes))),
  }
}

// ---------- the decision ----------

// lastWarmAt: the last main-thread request (a turn's or a keep-warm's), which restarts the cache's timer.
// lastActiveAt: when Claude last answered the person; the keep-warm window counts from it.
export type Clock = { lastWarmAt?: number; lastActiveAt?: number; busy: boolean; settled: boolean }
export type Action = 'wait' | 'keep-warm' | 'compact' | 'handoff' | 'let-expire' | 'expired'

export function decide(s: Clock, cfg: Config, now: number): Action {
  if (s.lastWarmAt === undefined || s.busy || s.settled) return 'wait'
  const expiresAt = s.lastWarmAt + cfg.cacheTtlMinutes * 60_000
  // Past expiry already (the machine slept, say): nothing is left to save.
  if (now >= expiresAt) return 'expired'
  if (now < expiresAt - cfg.leadMinutes * 60_000) return 'wait'
  // Keep warm while the window the person asked for reaches past this expiry.
  const windowEnd = (s.lastActiveAt ?? s.lastWarmAt) + cfg.keepWarmHours * HOUR
  if (cfg.keepWarm && windowEnd > expiresAt) return 'keep-warm'
  return cfg.atExpiry === 'nothing' ? 'let-expire' : cfg.atExpiry
}

// ---------- /keepwarm arguments ----------

export type Patch = Partial<Pick<Config, 'keepWarm' | 'keepWarmHours' | 'atExpiry'>>

export function parseArgs(args: string): { patch: Patch; now: boolean } | { error: string } {
  const patch: Patch = {}
  let now = false
  for (const word of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const hours = /^(\d+(?:\.\d+)?)h?$/.exec(word)
    const minutes = /^(\d+)m$/.exec(word)
    if (word === 'on' || word === 'off') patch.keepWarm = word === 'on'
    else if (hours) Object.assign(patch, { keepWarm: true, keepWarmHours: Math.min(24, Number(hours[1])) })
    else if (minutes) Object.assign(patch, { keepWarm: true, keepWarmHours: Number(minutes[1]) / 60 })
    else if (word === 'compact' || word === 'handoff' || word === 'nothing') patch.atExpiry = word
    else if (word === 'now') now = true
    else return { error: `Unknown option "${word}". Usage: /keepwarm [on|off] [<hours>h|<minutes>m] [nothing|compact|handoff] [now]` }
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
  if (outcome === 'compacted') return 'cache: compacted before expiry'
  if (outcome === 'handed-off') return 'cache: cleared with a handoff'
  if (s.lastWarmAt === undefined) return undefined
  const left = s.lastWarmAt + cfg.cacheTtlMinutes * 60_000 - now
  if (outcome === 'expired' || left <= 0) return '❄ cache cold'
  const parts = [`🔥 cache ${duration(left)}`]
  if (keeps > 0) parts.push(`kept warm ${keeps}×`)
  if (!cfg.keepWarm || cfg.keepWarmHours === 0) parts.push('keep-warm off')
  if (cfg.atExpiry !== 'nothing') parts.push(`then ${cfg.atExpiry}`)
  return parts.join(' · ')
}

// ---------- state ----------

let config: Config = DEFAULT_CONFIG
let overrides: Patch = {}
const clock: Clock = { busy: false, settled: false }
let acting = false
let outcome: Outcome | undefined
let keeps: { at: number; usage: ModelUsage }[] = []
let ticker: { cancel: () => void } | undefined

function effective(): Config {
  return { ...config, ...overrides }
}

// ---------- actions ----------

async function keepWarm($: EngineInterface): Promise<string> {
  const reply = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
  const now = await $.clock.now()
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    clock.lastWarmAt = undefined
    return 'Nothing to keep warm yet.'
  }
  if (!('usage' in reply)) return 'Keep-warm failed: no usage came back.'
  const { cache_read_input_tokens: read, cache_creation_input_tokens: written } = reply.usage
  // Any request that went out restarted the timer, even one whose reply came back empty.
  clock.lastWarmAt = now
  clock.settled = false
  outcome = undefined
  keeps.push({ at: now, usage: reply.usage })
  const k = (n: number) => `${Math.round(n / 1000)}k`
  if (written > read) return `Keep-warm re-wrote the cache (${k(written)} tokens): it had already expired.`
  return `Kept warm: read ${k(read)} cached tokens, wrote ${k(written)}.${reply.isAnswered ? '' : ` (${reply.reason})`}`
}

async function compact($: EngineInterface): Promise<string> {
  // Headless sessions (-p, the SDK) compact only through the /compact command for now.
  const result = await $.session.compact().catch(async () => {
    await $.command.run({ command: 'compact' })
    return { skip: undefined }
  })
  if (result.skip) return `Compaction skipped: ${result.skip}`
  outcome = 'compacted'
  return 'Compacted the conversation before its cache expired.'
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
  $.ui.status(statusText(clock, cfg, await $.clock.now(), keeps.length, outcome))
}

function report(now: number): string {
  const cfg = effective()
  const lines = [
    statusText(clock, cfg, now, keeps.length, outcome) ?? 'No conversation cached yet.',
    `Keep warm: ${cfg.keepWarm && cfg.keepWarmHours > 0 ? `on, for ${duration(cfg.keepWarmHours * HOUR)} after Claude's last answer` : 'off'}. Before the cache finally expires: ${cfg.atExpiry}.`,
    `Cache lifetime ${cfg.cacheTtlMinutes}m; acting ${cfg.leadMinutes}m before expiry.`,
  ]
  const read = keeps.reduce((sum, k) => sum + k.usage.cache_read_input_tokens, 0)
  if (keeps.length) lines.push(`Keep-warms this session: ${keeps.length}, reading ${Math.round(read / 1000)}k cached tokens in all.`)
  return lines.join('\n')
}

function startTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => void tick($))
}

// ---------- registration ----------

// Each command is also declared in commands/, so a host lists it as `/cache-keeper:<name>` before
// any session exists (the desktop app's empty chat); the hooks answer both spellings.
export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command
      .register({ name: 'keepwarm', description: 'Cache keeper: show the cache, or change keep-warm for this session', argumentHint: '[on|off] [2h|90m] [nothing|compact|handoff] [now]' })
      .catch(() => undefined)
    startTicker($)
    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') ticker?.cancel()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    clock.busy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      Object.assign(clock, { busy: false, settled: false, lastWarmAt: now, lastActiveAt: now })
      outcome = undefined
      $.ui.status(statusText(clock, effective(), now, keeps.length))
    }
    return done
  })

  on('command.run', { command: ['keepwarm', 'cache-keeper:keepwarm'] }, async ($, e) => {
    const parsed = parseArgs(e.args)
    if ('error' in parsed) return { text: parsed.error }
    overrides = { ...overrides, ...parsed.patch }
    let said = ''
    if (parsed.now) said = `${await keepWarm($)}\n`
    const now = await $.clock.now()
    $.ui.status(statusText(clock, effective(), now, keeps.length, outcome))
    return { text: `${said}${report(now)}` }
  })
}
