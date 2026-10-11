import { expect, mock, test } from 'claude-code/testing'

import { breakEven, coldText, decide, DEFAULT_CONFIG, duration, judgeSend, parseArgs, pingUsd, priceOf, readConfig, rowParts, statusText } from '../hooks/register'
import type { Clock, Config } from '../hooks/register'

const MIN = 60_000
const HOUR = 60 * MIN
const idleAt = (t: number): Clock => ({ lastWarmAt: t, lastActiveAt: t, busy: false, settled: false })

test('settings: defaults, and values out of range are held in range', async () => {
  expect(readConfig({})).toEqual(DEFAULT_CONFIG)
  const odd = readConfig({ keepWarm: false, keepWarmHours: 99, atExpiry: 'explode', cacheTtlMinutes: 5, leadMinutes: 10 })
  expect(odd).toEqual({ ...DEFAULT_CONFIG, keepWarm: false, keepWarmHours: 24, atExpiry: 'nothing', cacheTtlMinutes: 5, leadMinutes: 2.5 })
  expect(readConfig({ coldGuard: 'warn', guardMinTokens: 10_000, showRow: false })).toMatchObject({ coldGuard: 'warn', guardMinTokens: 10_000, showRow: false })
  expect(readConfig({ coldGuard: 'scream' }).coldGuard).toBe('refuse')
})

test('nothing happens until the lead window before expiry, nor while a turn runs', async () => {
  const cfg = DEFAULT_CONFIG
  expect(decide({ busy: false, settled: false }, cfg, 0)).toBe('wait')
  expect(decide(idleAt(0), cfg, 54 * MIN)).toBe('wait')
  expect(decide(idleAt(0), cfg, 55 * MIN)).toBe('keep-warm')
  expect(decide({ ...idleAt(0), busy: true }, cfg, 55 * MIN)).toBe('wait')
  expect(decide({ ...idleAt(0), settled: true }, cfg, 55 * MIN)).toBe('wait')
  expect(decide(idleAt(0), cfg, 61 * MIN)).toBe('expired')
})

test('keep-warms continue for the hours chosen, then the expiry action runs', async () => {
  const cfg: Config = { ...DEFAULT_CONFIG, keepWarmHours: 2, atExpiry: 'compact' }
  // Claude last answered at 0; keep-warms at 55m and 110m carry the cache to 170m, past the 2h window.
  expect(decide({ ...idleAt(55 * MIN), lastActiveAt: 0 }, cfg, 110 * MIN)).toBe('keep-warm')
  expect(decide({ ...idleAt(110 * MIN), lastActiveAt: 0 }, cfg, 165 * MIN)).toBe('compact')
  expect(decide({ ...idleAt(110 * MIN), lastActiveAt: 0 }, { ...cfg, atExpiry: 'handoff' }, 165 * MIN)).toBe('handoff')
  expect(decide({ ...idleAt(110 * MIN), lastActiveAt: 0 }, { ...cfg, atExpiry: 'nothing' }, 165 * MIN)).toBe('let-expire')
})

test('with keep-warm off, the expiry action runs before the first expiry', async () => {
  expect(decide(idleAt(0), { ...DEFAULT_CONFIG, keepWarm: false, atExpiry: 'handoff' }, 56 * MIN)).toBe('handoff')
  expect(decide(idleAt(0), { ...DEFAULT_CONFIG, keepWarmHours: 0, atExpiry: 'compact' }, 56 * MIN)).toBe('compact')
  // A 5-minute cache acts 2.5 minutes before it lapses.
  const short = readConfig({ cacheTtlMinutes: 5 })
  expect(decide(idleAt(0), short, 2 * MIN)).toBe('wait')
  expect(decide(idleAt(0), short, 3 * MIN)).toBe('keep-warm')
})

test('/keepwarm arguments', async () => {
  expect(parseArgs('')).toEqual({ patch: {}, now: false })
  expect(parseArgs('off')).toEqual({ patch: { keepWarm: false }, now: false })
  expect(parseArgs('3h handoff')).toEqual({ patch: { keepWarm: true, keepWarmHours: 3, atExpiry: 'handoff' }, now: false })
  expect(parseArgs('90m now')).toEqual({ patch: { keepWarm: true, keepWarmHours: 1.5 }, now: true })
  expect(parseArgs('guard warn status')).toEqual({ patch: { coldGuard: 'warn' }, now: false })
  expect('error' in parseArgs('guard loudly')).toBe(true)
  expect('error' in parseArgs('forever')).toBe(true)
})

test('the status line', async () => {
  expect(statusText({ busy: false, settled: false }, DEFAULT_CONFIG, 0, 0)).toBeUndefined()
  expect(statusText(idleAt(0), DEFAULT_CONFIG, 18 * MIN, 0)).toBe('🔥 cache 42m')
  expect(statusText(idleAt(0), { ...DEFAULT_CONFIG, atExpiry: 'compact' }, 0, 2)).toBe('🔥 cache 1h · kept warm 2× · then compact')
  expect(statusText(idleAt(0), { ...DEFAULT_CONFIG, keepWarm: false }, 0, 0)).toBe('🔥 cache 1h · keep-warm off')
  expect(statusText(idleAt(0), DEFAULT_CONFIG, 2 * HOUR, 0)).toBe('❄ cache cold')
  expect(statusText(idleAt(0), DEFAULT_CONFIG, 0, 0, 'handed-off')).toBe('cache: cleared with a handoff')
  expect(duration(95 * MIN)).toBe('1h35m')
})

test('/keepwarm now forks over the conversation and reports the cache read', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: 'ok',
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 62_931, cache_creation_input_tokens: 177 },
    },
  }))
  const { text } = await $.command.run({ command: 'keepwarm', args: '3h now' } as never)
  expect(text).toContain('Kept warm: read 63k cached tokens, wrote 177.')
  expect(text).toContain('Keep warm: on, for 3h after')
  expect(text).toContain('Keep-warms this session: 1')
})


// ---------- 0.2: what cache-tax does, folded in ----------

test('prices: the right row for each model, and the write price follows the cache lifetime', async () => {
  // Opus 5.5 is not Opus 5: $4 input, $0.20 reads, a 1-hour write at twice the input.
  expect(priceOf('claude-opus-5-5', 60)).toEqual({ input: 4, read: 0.2, write: 8, output: 20 })
  expect(priceOf('claude-opus-5-5[1m]', 60)?.write).toBe(8)
  expect(priceOf('claude-opus-5', 60)).toEqual({ input: 5, read: 0.5, write: 10, output: 25 })
  expect(priceOf('claude-fable-5-1', 60)).toMatchObject({ read: 0.25, write: 20 })
  expect(priceOf('claude-sonnet-5-5', 5)?.write).toBe(2.5)
  expect(priceOf('claude-haiku-4-5-20251001', 60)).toMatchObject({ read: 0.1, write: 2 })
  expect(priceOf('some-other-model', 60)).toBeUndefined()
  expect(breakEven(priceOf('claude-opus-5-5', 60)!)).toBe(40)
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }
  expect(Math.round(pingUsd(usage, priceOf('claude-opus-5-5', 60)!) * 1e5)).toBe(2014)
})

test('the guard: a big cold conversation is refused once, the resend goes through; warm or small ones pass', async () => {
  const cold = idleAt(0)
  expect(judgeSend(cold, DEFAULT_CONFIG, 30 * MIN, 300_000, undefined)).toBe('pass')
  expect(judgeSend(cold, DEFAULT_CONFIG, 2 * HOUR, 30_000, undefined)).toBe('pass')
  expect(judgeSend(cold, DEFAULT_CONFIG, 2 * HOUR, 300_000, undefined)).toBe('refuse')
  expect(judgeSend(cold, DEFAULT_CONFIG, 2 * HOUR, 300_000, 0)).toBe('resend')
  expect(judgeSend(cold, { ...DEFAULT_CONFIG, coldGuard: 'warn' }, 2 * HOUR, 300_000, undefined)).toBe('warn')
  expect(judgeSend(cold, { ...DEFAULT_CONFIG, coldGuard: 'off' }, 2 * HOUR, 300_000, undefined)).toBe('pass')
  expect(coldText(cold, DEFAULT_CONFIG, 2 * HOUR, 200_502, priceOf('claude-opus-5-5', 60))).toBe(
    'the prompt cache went cold 1h ago. Sending this re-writes up to 200,502 tokens at $8/MTok ≈ $1.60 (a warm turn would have read it for $0.04).',
  )
})

test('after a cold write the cache is held warm for at least 3 hours; a stopped keep-warm waits for the next turn', async () => {
  const cfg: Config = { ...DEFAULT_CONFIG, keepWarmHours: 0, atExpiry: 'compact' }
  expect(decide(idleAt(0), cfg, 55 * MIN)).toBe('compact')
  expect(decide({ ...idleAt(0), holdUntil: 3 * HOUR }, cfg, 55 * MIN)).toBe('keep-warm')
  expect(decide({ ...idleAt(0), holdUntil: 3 * HOUR }, { ...cfg, keepWarm: false }, 55 * MIN)).toBe('compact')
  expect(decide({ ...idleAt(0), stopped: 'the cache was already gone' }, DEFAULT_CONFIG, 55 * MIN)).toBe('let-expire')
})

test('the row above the prompt: warm with its receipts, cold with the price of the next send', async () => {
  const price = priceOf('claude-opus-5-5', 60)
  expect(rowParts({ busy: false, settled: false }, DEFAULT_CONFIG, 0, { keeps: 0, context: 0 })).toBeUndefined()
  expect(rowParts(idleAt(0), { ...DEFAULT_CONFIG, atExpiry: 'compact' }, 18 * MIN, { keeps: 2, lastPing: { read: 75_000, usd: 0.02 }, context: 75_000, price })).toEqual({
    state: 'warm',
    text: '42m left · kept warm 2× · last ping read 75k $0.02 · then compact',
  })
  expect(rowParts(idleAt(0), DEFAULT_CONFIG, 3 * HOUR, { keeps: 0, context: 330_000, price })).toEqual({
    state: 'cold',
    text: 'for 2h · the next send re-writes 330k ($2.64)',
  })
})

test('a keep-warm that finds the cache gone stops instead of paying the write again', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: 'ok',
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000 },
    },
  }))
  const { text } = await $.command.run({ command: 'keepwarm', args: 'now' } as never)
  expect(text).toContain('Keep-warm stopped until your next message: it read 0 and wrote 80k: the cache was already gone.')
})

test('/keepwarm guard warn changes the guard for this session and the card says so', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const { text } = await $.command.run({ command: 'keepwarm', args: 'guard warn' } as never)
  expect(text).toContain('Cold-send guard (contexts over 50k): show the price and send.')
  expect(text).toContain('Cold writes paid this session: 0.')
})
