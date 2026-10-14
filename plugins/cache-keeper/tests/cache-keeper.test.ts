import { expect, mock, test } from 'claude-code/testing'

import { breakEven, coldText, decide, DEFAULT_CONFIG, duration, judgeSend, parseArgs, pingUsd, priceOf, readConfig, rowParts, statusText } from '../hooks/register'
import type { Clock, Config } from '../hooks/register'
import type { TestBody } from 'claude-code/testing'

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

// ---------- 0.3: the held message and compaction ----------

const COLD_RESUME = { source: 'resume', model: 'claude-opus-5-5', context_tokens: 546_772, seconds_since_last_response: 97 * 60, prompt_cache_likely_expired: true } as const

// The prompt chain's bottom: what entered the session, and what a person typing in the composer sends.
function promptBottom(on: Parameters<TestBody>[1]) {
  const entered: { text: string; origin?: unknown }[] = []
  on('prompt.submit', async ($, e) => {
    entered.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  return entered
}
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

test('a compaction resets the guard: the next message caches the summary, even while the live usage still reads the old size', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  // The status line's figure lags until the next answer: it still reads the conversation before compaction.
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 546_772, window: 1_000_000 }, rateLimits: [] } }))
  const summary = [{ role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }]
  on('session.compact', async () => ({ messages: summary, tokensBefore: 547_270, tokensAfter: 31_000 }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('classic.SessionStart', async () => ({}))
  const entered = promptBottom(on)
  await $.classic.SessionStart(COLD_RESUME as never)
  expect('drop' in (await $.prompt.submit(typed('first')))).toBe(true)
  await $.session.compact({ trigger: 'manual', messages: summary } as never)
  const after = await $.prompt.submit(typed('this part of the script is kinda confusing'))
  expect(after).toMatchObject({ text: 'this part of the script is kinda confusing' })
  expect(entered.map(p => p.text)).toEqual(['this part of the script is kinda confusing'])
  const { text } = await $.command.run({ command: 'keepwarm', args: 'status' } as never)
  expect(text).toContain('Context 31,000 tokens')
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

// A cold resumed session whose next typed message the guard holds; the prompt box as a host keeps it.
async function holdOne($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], text: string) {
  mock.clock(on, { now: 10 * HOUR })
  on('classic.SessionStart', async () => ({}))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  // Beneath the plugin, the band holds nothing else.
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, {}) as never)
  const box = { text: '' }
  on('prompt.read', async () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', async ($, e) => {
    box.text = e.text
    return { isFilled: true, text: e.text }
  })
  const entered = promptBottom(on)
  await $.classic.SessionStart(COLD_RESUME as never)
  const refused = await $.prompt.submit(typed(text))
  return { refused, entered, box }
}

test('a held message on the desktop: its price, and Send anyway sends it as the person wrote it', async ($, on) => {
  const { refused, entered } = await holdOne($, on, 'this part of the script is kinda confusing')
  expect(refused).toMatchObject({ drop: expect.stringContaining('Your message is held above the prompt') })
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', component: 'AbovePrompt', requestId: 'band', props: BAND })
  expect(await ui.find({ type: 'Text', text: 'Message held: the cache went cold 37m ago. Sending it re-writes 547k tokens ≈ $4.37 (a warm cache would read it for $0.11).' })).toBeDefined()
  // The desktop's own buttons: a Button inside a Client module is drawn as bare text there.
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Send anyway · $4.37', 'Compact, then send', 'Clear, keep draft', 'Discard'])
  expect(await ui.find({ type: 'Text', text: /ctrl\+x tab/ })).toBeUndefined()
  await ui.press({ key: 'held-send' })
  expect(entered).toEqual([{ text: 'this part of the script is kinda confusing', origin: { kind: 'plugin', name: 'cache-keeper', asUser: true } }])
  expect(await ui.find({ key: 'held-send' })).toBeUndefined()
  await ui.unmount()
})

test('in the terminal, Compact, then send compacts and sends it without a second refusal', async ($, on) => {
  const summary = [{ role: 'user' as const, text: 'Summary.', toolUses: [] }]
  on('session.compact', async () => ({ messages: summary, tokensBefore: 547_270, tokensAfter: 31_000 }))
  const { entered } = await holdOne($, on, 'carry on')
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: BAND })
  expect((await ui.find({ key: 'held-compact' }))?.props).toMatchObject({ label: 'Compact, then send', hotkey: '2' })
  await ui.press({ key: 'held-compact' })
  expect(entered.map(p => p.text)).toEqual(['carry on'])
  expect(await ui.find({ key: 'held-compact' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /compacted · the next message caches the summary \(31k\)/ })).toBeDefined()
  await ui.unmount()
})

test('Discard drops it and guards the next message again; Clear puts it back in the box', async ($, on) => {
  on('command.run', { command: 'clear' }, async () => ({ text: '' }))
  const { entered, box } = await holdOne($, on, 'first try')
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: BAND })
  box.text = 'first try'
  await ui.press({ key: 'held-discard' })
  expect(box.text).toBe('')
  expect(await ui.find({ key: 'held-discard' })).toBeUndefined()
  expect('drop' in (await $.prompt.submit(typed('second try')))).toBe(true)
  await ui.press({ key: 'held-clear' })
  expect(box.text).toBe('second try')
  expect(entered).toEqual([])
  await ui.unmount()
})

// ---------- 0.4: the settings pane ----------

const PANE_PROPS = { title: 'Cache keeper', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const status = async ($: Parameters<TestBody>[0]) => (await $.command.run({ command: 'keepwarm', args: 'status' } as never)).text as string

test('/keepwarm opens a pane whose buttons set this session: keep-warm hours, the expiry action, the guard, and a reset', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  const opened: unknown[] = []
  on('ui.open', async ($, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  const { text } = await $.command.run({ command: 'keepwarm', args: '' } as never)
  expect(text).toBe('Cache keeper settings are open in the pane.')
  expect(opened).toEqual([expect.objectContaining({ id: 'cache-keeper', title: 'Cache keeper' })])

  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', component: 'Pane', requestId: 'cache-keeper', props: PANE_PROPS })
  const variant = async (key: string) => (await ui.find({ key }))?.props.variant
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Off', '1h', '2h', '4h', '8h', 'Let it expire', 'Compact', 'Hand off', 'Hold it', 'Warn', 'Off'])
  expect(await variant('keep-2')).toBe('primary')
  expect(await variant('keep-4')).toBe('secondary')

  await ui.press({ key: 'keep-4' })
  await ui.press({ key: 'expiry-compact' })
  await ui.press({ key: 'guard-warn' })
  expect(await variant('keep-4')).toBe('primary')
  expect(await variant('keep-2')).toBe('secondary')
  expect(await ui.find({ type: 'Text', text: 'compacts while warm; the next message caches only the summary' })).toBeDefined()
  const set = await status($)
  expect(set).toContain('Keep warm: on, for 4h after')
  expect(set).toContain('Before the cache finally expires: compact.')
  expect(set).toContain('show the price and send')

  await ui.press({ key: 'keep-0' })
  expect(await status($)).toContain('Keep warm: off.')
  await ui.press({ key: 'reset' })
  expect(await status($)).toContain('Keep warm: on, for 2h after')
  expect(await ui.find({ key: 'reset' })).toBeUndefined()
  await ui.unmount()
})

test("the pane offers this session's own keep-warm window, and Keep warm now while the cache is warm", async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('classic.SessionStart', async () => ({}))
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'ok', usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 62_931, cache_creation_input_tokens: 177 } },
  }))
  await $.classic.SessionStart({ ...COLD_RESUME, seconds_since_last_response: 10 * 60, prompt_cache_likely_expired: false } as never)
  await $.command.run({ command: 'keepwarm', args: '90m' } as never)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'terminal', component: 'Pane', requestId: 'cache-keeper', props: PANE_PROPS })
  expect((await ui.findAll({ type: 'Button' })).slice(0, 6).map(b => [b.props.label, b.props.variant])).toEqual([
    ['Off', 'secondary'],
    ['1h', 'secondary'],
    ['1h30m', 'primary'],
    ['2h', 'secondary'],
    ['4h', 'secondary'],
    ['8h', 'secondary'],
  ])
  expect(await ui.find({ type: 'Text', text: /547k tokens on claude-opus-5-5 · a cold send \$4\.37, a warm one \$0\.11/ })).toBeDefined()
  await ui.press({ key: 'keep-now' })
  expect(await ui.find({ type: 'Text', text: 'Kept warm: read 63k cached tokens, wrote 177 ($0.01).' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 keep-warm · read 63k/ })).toBeDefined()
  await ui.unmount()
})
