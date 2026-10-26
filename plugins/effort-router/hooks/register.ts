import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'
import {
  asEffort,
  asNumber,
  choices,
  describe,
  EFFORTS,
  fromProbs,
  haikuPrompt,
  HAIKU_SYSTEM,
  jevBody,
  KEEP,
  parseJev,
  parseLabel,
  report,
  type DecisionRow,
  type Effort,
  type Level,
  type Probs,
  type Source,
  type StepRow,
} from './decide.ts'

// Routes each main-conversation turn to an effort level. Jev rates the prompt
// (with the end of the last reply, for short answers like "yes"); Haiku rates
// it when Jev fails. Every request of the turn goes out at that effort.
// /effort-router opens a pane that changes all of it.

// Jev answers the same question through either service, with that service's key
type Provider = 'openrouter' | 'typesafe'
const PROVIDERS: Record<Provider, { name: string; url: string; model: string; env: string }> = {
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', env: 'OPENROUTER_API_KEY' },
  typesafe: { name: 'TypeSafe', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', env: 'TYPESAFE_API_KEY' },
}
// OpenRouter keys start sk-or-; anything else is taken for a TypeSafe key
const providerOf = (key: string): Provider => (key.startsWith('sk-or-') ? 'openrouter' : 'typesafe')
const JEV_TIMEOUT_MS = 2000
const HAIKU_TIMEOUT_MS = 8000
const PANE = 'effort-router-settings'
const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const KEYCHAIN_SERVICE = 'effort-router'
const TEST_PROMPT = 'rename the variable cnt to count in utils.ts'

type Verdict = { source: Source; want?: Level; probs?: Probs; error?: string }

let enabled = true
let effortFor: Record<Level, Effort> = { trivial: 'low', standard: 'medium', hard: 'xhigh' }
// For a turn no classifier could rate; undefined sends the session's own effort
let unsureEffort: Effort | undefined
// Keys from the plugin settings, and which service to prefer when both have one
let configuredKeys: Record<Provider, string> = { openrouter: '', typesafe: '' }
let preferred: Provider = 'openrouter'
// Percentages and a count, as the settings hold them
let hardAt = 40
let trivialAt = 70

// Every Jev key found, one per service, with where it came from; undefined until the first lookup
type KeySource = 'settings' | 'environment' | 'keychain' | 'shell' | 'missing'
type FoundKey = { key: string; provider: Provider; source: KeySource }
type Keyring = Partial<Record<Provider, FoundKey>>
let keyring: Keyring | undefined
const other = (p: Provider): Provider => (p === 'openrouter' ? 'typesafe' : 'openrouter')
// The preferred service's key, else the other one
const activeKey = (ring: Keyring | undefined) => ring?.[preferred] ?? ring?.[other(preferred)]

// Whether the settings pane's drawing ran, and how it last failed
const renders = { count: 0, ok: 0, error: '' }

// The rating of the turn in flight; undefined when it couldn't be rated
let level: Level | undefined
// What that turn goes out at: its level's effort, or the unsure one
const turnEffort = () => (level ? effortFor[level] : unsureEffort)
let lastTurnId: string | undefined
const texts = new Map<string, string>()
let decisions: DecisionRow[] = []
let steps: StepRow[] = []

const paneOpen = atom({ plugin: 'effort-router', key: 'paneOpen' } as const, false)
const testResult = atom({ plugin: 'effort-router', key: 'testResult' } as const, '')
const notice = atom({ plugin: 'effort-router', key: 'notice' } as const, '')
const keyEditing = atom({ plugin: 'effort-router', key: 'keyEditing' } as const, false)
const classifierOpen = atom({ plugin: 'effort-router', key: 'classifierOpen' } as const, false)

// Resolves undefined once ms have passed, so a slow Jev can't hold the turn
function timeout($: EngineInterface, ms: number) {
  let cancel = () => {}
  const done = new Promise<undefined>(resolve => {
    const timer = $.clock.after(ms, () => resolve(undefined))
    cancel = () => timer.cancel()
  })
  return { done, cancel }
}

// Looks for each service's key in the plugin settings, the environment, the Keychain
// (a key pasted into the pane), then a login shell: the Desktop app doesn't start Claude
// Code from a shell, so a key exported in ~/.zshrc isn't in its environment. Once per load.
async function findKeys($: EngineInterface): Promise<Keyring> {
  if (keyring) return keyring
  const ring: Keyring = {}
  const add = (provider: Provider, key: string | undefined, source: KeySource) => {
    if (key && !ring[provider]) ring[provider] = { key, provider, source }
  }
  add('openrouter', configuredKeys.openrouter, 'settings')
  add('typesafe', configuredKeys.typesafe, 'settings')
  add('openrouter', await $.env.get('OPENROUTER_API_KEY'), 'environment')
  add('typesafe', await $.env.get('TYPESAFE_API_KEY'), 'environment')
  for (const provider of ['openrouter', 'typesafe'] as const) {
    if (ring[provider]) continue
    try {
      const r = await $.process.run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', provider, '-w'])
      if (r.exitCode === 0) add(provider, r.stdout.trim(), 'keychain')
    } catch {
      // No Keychain here (not macOS)
    }
  }
  if (!ring.openrouter || !ring.typesafe) {
    try {
      const shell = (await $.env.get('SHELL')) || '/bin/zsh'
      const r = await $.process.run([shell, '-lic', 'printf "%s\\n%s\\n" "$OPENROUTER_API_KEY" "$TYPESAFE_API_KEY"'], { timeoutMs: 5000 })
      const [openrouter = '', typesafe = ''] = r.stdout.split('\n').slice(-3, -1).map(l => l.trim())
      const valid = (k: string) => (r.exitCode === 0 && /^\S{20,}$/.test(k) ? k : undefined)
      add('openrouter', valid(openrouter), 'shell')
      add('typesafe', valid(typesafe), 'shell')
    } catch {
      // No shell, or it took too long: same as no key
    }
  }
  return (keyring = ring)
}

async function resolveKey($: EngineInterface): Promise<FoundKey> {
  return activeKey(await findKeys($)) ?? { key: '', provider: preferred, source: 'missing' }
}

async function askJev($: EngineInterface, prompt: string, previousReply: string): Promise<Verdict> {
  let found: FoundKey
  try {
    found = await resolveKey($)
  } catch (error) {
    return { source: 'none', error: `could not read the key: ${String(error).slice(0, 160)}` }
  }
  if (!found.key) return { source: 'none', error: 'no OPENROUTER_API_KEY or TYPESAFE_API_KEY' }
  const service = PROVIDERS[found.provider]
  const request = $.http.fetch(service.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${found.key}`, 'Content-Type': 'application/json' },
    body: jevBody(prompt, previousReply, service.model),
  })
  // A request that loses the race may still reject later
  request.catch(() => {})
  const timer = timeout($, JEV_TIMEOUT_MS)
  try {
    const res = await Promise.race([request, timer.done])
    if (res === undefined) return { source: 'none', error: `no answer in ${JEV_TIMEOUT_MS}ms` }
    if (!res.ok) return { source: 'none', error: `${service.name} answered HTTP ${res.status}` }
    const probs = parseJev(res.text)
    if (!probs) return { source: 'none', error: 'unreadable answer' }
    return { source: 'jev', want: fromProbs(probs, hardAt / 100, trivialAt / 100), probs }
  } catch (error) {
    return { source: 'none', error: String(error).slice(0, 200) }
  } finally {
    timer.cancel()
  }
}

async function askHaiku($: EngineInterface, prompt: string, previousReply: string): Promise<Level | undefined> {
  const r = await $.model.complete({
    model: 'haiku',
    system: HAIKU_SYSTEM,
    prompt: haikuPrompt(prompt, previousReply),
    maxTokens: 256,
    timeoutMs: HAIKU_TIMEOUT_MS,
    effort: 'low',
  })
  return r.isAnswered ? parseLabel(r.text) : undefined
}

async function classify($: EngineInterface, prompt: string, previousReply: string): Promise<Verdict> {
  const jev = await askJev($, prompt, previousReply)
  if (jev.source === 'jev') return jev
  const want = await askHaiku($, prompt, previousReply)
  return { source: want ? 'haiku' : 'none', want, error: jev.error }
}

// The end of the last reply with text: what a short prompt like "yes" answers
async function lastReply($: EngineInterface) {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'assistant' && m.text) return m.text as string
  }
  return ''
}

function label(v: Verdict, effort: Effort | undefined) {
  const from = v.source === 'jev' && v.probs ? `jev ${describe(v.probs)}` : v.source === 'haiku' ? 'haiku' : 'no classifier'
  const why = v.want === undefined ? 'unrated' : v.want
  return `effort ${effort ?? 'session'} · ${why} · ${from}`
}

async function setEnabled($: EngineInterface, on: boolean) {
  enabled = on
  await $.store.set('enabled', enabled)
  if (!enabled) $.ui.status(undefined)
  $.ui.invalidate('ui.render')
}

async function openSettings($: EngineInterface) {
  await update($, paneOpen, () => true)
  return $.ui.open({ id: PANE, title: 'Effort router', focus: true, closeOnEscape: true, rows: 28 })
}

// Writes one of this plugin's /config rows. The engine reloads the module
// with the new options, so the pane redraws from them.
// Puts a setting in force in this copy of the mod at once, so the pane changes on the press
function applyOption(field: string, value: string | number) {
  if (field === 'jev_service') preferred = value === 'typesafe' ? 'typesafe' : 'openrouter'
  else if (field === 'unsure_effort') unsureEffort = value === 'session' ? undefined : asEffort(value, 'xhigh')
  else if (field === 'hard_threshold') hardAt = asNumber(value, hardAt, 5, 95)
  else if (field === 'trivial_threshold') trivialAt = asNumber(value, trivialAt, 5, 99)
  else if (field.endsWith('_effort')) {
    const lvl = field.slice(0, -'_effort'.length) as Level
    if (lvl in effortFor) effortFor = { ...effortFor, [lvl]: asEffort(value, effortFor[lvl]) }
  }
}

async function saveOption($: EngineInterface, field: string, title: string, value: string | number) {
  applyOption(field, value)
  $.ui.invalidate('ui.render')
  // A new service needs its own check
  if (field === 'jev_service') void testJev($).catch(() => {})
  // Plugin settings are not /config rows, so $.config.set cannot write them: the pane's
  // choices live in the mod's own store and override the plugin settings at session.start
  try {
    const saved = await $.store.get('settings')
    await $.store.set('settings', { ...(saved && typeof saved === 'object' ? saved : {}), [field]: value })
    await update($, notice, () => `Saved ${title}.`)
  } catch (error) {
    await update($, notice, () => `Not saved: ${String(error)}`)
  }
}

// One Jev call with a fixed prompt: 'checking', then 'ok:<ms>' or 'fail:<why>'
async function testJev($: EngineInterface) {
  await update($, testResult, () => 'checking')
  const started = await $.clock.now()
  const v = await askJev($, TEST_PROMPT, '')
  const ms = Math.round((await $.clock.now()) - started)
  await update($, testResult, () => (v.source === 'jev' ? `ok:${ms}` : `fail:${v.error ?? 'no answer'}`))
}

function summary() {
  const now = `${level ?? 'unrated'}, sent at ${turnEffort() ?? "the session's own effort"}`
  const by = (s: Source) => decisions.filter(d => d.source === s).length
  return `Now: ${now} · ${decisions.length} turns rated (jev ${by('jev')}, haiku ${by('haiku')}, none ${by('none')})`
}

// Saves a pasted key in the macOS Keychain under its service, uses it, and checks it
async function saveKey($: EngineInterface, text: string) {
  const key = text.trim()
  if (!/^\S{20,}$/.test(key)) return update($, notice, () => 'That does not look like an OpenRouter or TypeSafe key.')
  const provider = providerOf(key)
  try {
    const r = await $.process.run(['security', 'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', provider, '-w', key])
    if (r.exitCode !== 0) return update($, notice, () => `Could not save the key: ${r.stderr.trim().slice(0, 160)}`)
  } catch (error) {
    return update($, notice, () => `Could not save the key: ${String(error).slice(0, 160)}`)
  }
  keyring = { ...keyring, [provider]: { key, provider, source: 'keychain' } }
  await update($, keyEditing, () => false)
  await update($, notice, () => '')
  // A pasted key is the one you mean to use: prefer its service (a settings change reloads the mod)
  if (provider !== preferred) await saveOption($, 'jev_service', 'service', provider)
  else await testJev($)
}

async function forgetKey($: EngineInterface) {
  for (const provider of ['openrouter', 'typesafe'] as const) {
    try {
      await $.process.run(['security', 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', provider])
    } catch {
      // Nothing saved
    }
  }
  keyring = undefined
  await update($, testResult, () => '')
  await findKeys($)
  $.ui.invalidate('ui.render')
}

// Drawings for the apps that draw SVG (desktop, VS Code). Colors are chosen to read
// on light and dark themes alike, since an SVG can't see the app's theme.
const ACCENT = '#8fb57e'
const TRACK = 'rgba(128,128,128,0.35)'
const svgDoc = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`
const SVG_ICON = svgDoc(
  18,
  18,
  `<g fill="none" stroke="${ACCENT}" stroke-width="1.6" stroke-linecap="round"><circle cx="5" cy="4" r="2"/><circle cx="13" cy="6" r="2"/><path d="M5 6v8M13 8c0 3-4 3-7.2 5.2"/></g>`,
)
const svgSwitch = (on: boolean) =>
  svgDoc(
    36,
    20,
    `<rect x="0.5" y="0.5" width="35" height="19" rx="9.5" fill="${on ? ACCENT : TRACK}"/><circle cx="${on ? 26 : 10}" cy="10" r="7" fill="${on ? '#1f2420' : '#fafafa'}"/>`,
  )
const svgBars = (filled: number) =>
  svgDoc(
    16,
    14,
    [0, 1, 2].map(i => `<rect x="${i * 5.5}" y="${10 - i * 4}" width="4" height="${4 + i * 4}" rx="1" fill="${i < filled ? ACCENT : TRACK}"/>`).join(''),
  )
const svgRule = (width: number, dashed = false) =>
  svgDoc(width, 3, `<line x1="0" y1="1.5" x2="${width}" y2="1.5" stroke="${TRACK}" stroke-width="1"${dashed ? ' stroke-dasharray="3 3"' : ''}/>`)

// The settings pane /effort-router opens
async function drawSettings($: EngineInterface, e: RenderInput<'Pane'>) {
  // Narrowing the surface first narrows the element table: mobile draws no Select or Input
  const ui = e.surface === 'mobile' ? $.ui.resolve(e) : undefined
  const full = e.surface === 'mobile' ? undefined : $.ui.resolve(e)
  const { Box, Text, Button } = full ?? ui!
  const isTerminal = e.surface === 'terminal'
  // Desktop and VS Code draw SVG; the terminal keeps text glyphs
  const Svg = full && 'Svg' in full ? full.Svg : undefined
  // The pane's width in CSS pixels, near enough for full-width drawings
  const px = Math.max(160, Math.round(e.props.bodyColumns * 7.5))
  const note = (text: string) => Text({ dimColor: true, size: 'footnote', wrap: 'wrap', children: [text] })
  const caption = (text: string) => Text({ dimColor: true, size: 'caption', children: [text.toUpperCase()] })
  // A label on the left and its control or value on the right
  const row = (left: unknown, right: unknown, key?: string) =>
    Box({
      ...(key ? { key } : {}),
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      columnGap: 'md',
      children: [left as never, right as never],
    })
  // A section: its title (with an optional caption on the right), then its rows
  const section = (title: string, children: unknown[], aside?: string) =>
    Box({
      flexDirection: 'column',
      gap: 'sm',
      children: [
        row(Text({ weight: 'semibold', size: 'heading', children: [title] }), aside ? caption(aside) : Text({ children: [''] })),
        ...(children as never[]),
      ],
    })
  const divider = Svg
    ? Svg({ source: svgRule(px), alt: '', width: px, height: 3 })
    : Text({ dimColor: true, wrap: 'truncate', children: ['─'.repeat(Math.max(8, e.props.bodyColumns))] })
  // Hotkeys only help in the terminal; elsewhere they are clutter
  const keys = (hotkey: string) => (isTerminal ? { hotkey, plain: true as const } : {})

  const header = Box({
    flexDirection: 'column',
    gap: 'xs',
    children: [
      row(
        Svg
          ? Box({
              flexDirection: 'row',
              columnGap: 'sm',
              alignItems: 'center',
              children: [Svg({ source: SVG_ICON, alt: '', width: 18, height: 18 }), Text({ weight: 'semibold', size: 'title', children: ['Effort router'] })],
            })
          : Text({ weight: 'semibold', size: 'title', children: ['⑂ Effort router'] }),
        // One Button on every surface: only a Button takes a press, and it holds text alone,
        // so a drawn switch beside it would look clickable and do nothing
        Button({
          key: 'toggle',
          ...keys('o'),
          ...(enabled ? { variant: 'primary' as const } : {}),
          onPress: () => setEnabled($, !enabled),
          children: [enabled ? 'Enabled ●' : 'Disabled ○'],
        }),
      ),
      note('Match reasoning effort to each prompt.'),
      note('Subagents keep their own settings.'),
    ],
  })
  const said = await read($, notice)
  const rated = `${decisions.length} turn${decisions.length === 1 ? '' : 's'} rated`
  const current = level ? `${level[0]!.toUpperCase()}${level.slice(1)}, ${EFFORT_LABEL[turnEffort()!]}` : turnEffort() ? `Unrated, ${EFFORT_LABEL[turnEffort()!]}` : 'Session default'
  const footer = Box({
    flexDirection: 'column',
    gap: 'xs',
    children: [row(note(`Current turn · ${current}`), note(rated)), ...(said ? [note(said)] : [])],
  })

  // Mobile: the switch and where things stand
  if (!full) return Box({ flexDirection: 'column', gap: 'md', children: [header, divider, footer] })
  const { Select, Input } = full

  const effortOptions = EFFORTS.map(v => ({ value: v, label: EFFORT_LABEL[v] }))
  const levelRow = (lvl: Level, bars: string, title: string) =>
    row(
      Box({
        flexDirection: 'row',
        columnGap: 'sm',
        alignItems: 'center',
        children: [
          Svg ? Svg({ source: svgBars(bars.trim().length), alt: '', width: 16, height: 14 }) : Text({ dimColor: true, children: [bars] }),
          Text({ children: [title] }),
        ],
      }),
      Select({
        key: `effort-${lvl}`,
        options: effortOptions,
        value: effortFor[lvl],
        onSelect: v => saveOption($, `${lvl}_effort`, `${lvl} effort`, v),
      }),
    )
  const ring = keyring
  const active = activeKey(ring)
  const editing = await read($, keyEditing)
  const check = await read($, testResult)
  const service = active ? PROVIDERS[active.provider].name : ''
  const from: Record<KeySource, string> = {
    settings: 'key from the plugin settings',
    environment: `key from ${active ? PROVIDERS[active.provider].env : ''}`,
    keychain: 'key saved in your Keychain',
    shell: 'key from your shell profile',
    missing: '',
  }
  // One line that says whether Jev works: the last check, else what was found
  const status = !ring
    ? Text({ dimColor: true, children: ['Looking for a key…'] })
    : !active
      ? Text({ color: 'yellow', children: ['○ No key · Haiku rates every turn'] })
      : check === 'checking'
        ? Text({ dimColor: true, children: [`◌ Checking ${service}…`] })
        : check.startsWith('fail:')
          ? Text({ color: 'red', wrap: 'wrap', children: [`✕ ${check.slice(5)}`] })
          : check.startsWith('ok:')
            ? Text({ color: 'green', children: [`● Connected · ${service} · ${check.slice(3)} ms`] })
            : Text({ children: [`● ${service} key found`] })
  const services =
    ring?.openrouter && ring.typesafe
      ? [
          Box({
            flexDirection: 'row',
            columnGap: 'sm',
            alignItems: 'center',
            children: [
              Text({ dimColor: true, children: ['Use'] }),
              ...(['openrouter', 'typesafe'] as const).map(p =>
                Button({
                  key: `service-${p}`,
                  label: PROVIDERS[p].name,
                  ...(p === active?.provider ? { variant: 'primary' as const } : {}),
                  onPress: () => (p === preferred ? undefined : saveOption($, 'jev_service', 'service', p)),
                }),
              ),
            ],
          }),
        ]
      : []
  const keyField = Input({
    key: 'key',
    placeholder: 'Paste an OpenRouter or TypeSafe key',
    value: '',
    submitLabel: 'save',
    onSubmit: text => saveKey($, text),
  })
  const keyControls =
    !active || editing
      ? [
          keyField,
          ...(active ? [Button({ key: 'cancel-key', label: 'Cancel', onPress: () => update($, keyEditing, () => false) })] : []),
        ]
      : [
          Box({
            flexDirection: 'row',
            columnGap: 'sm',
            children: [
              Button({ key: 'change-key', label: 'Change key', onPress: () => update($, keyEditing, () => true) }),
              Button({ key: 'test', label: 'Check again', ...keys('t'), onPress: () => testJev($) }),
              ...(active.source === 'keychain' ? [Button({ key: 'forget', label: 'Remove', onPress: () => forgetKey($) })] : []),
            ],
          }),
        ]
  const open = await read($, classifierOpen)
  const classifierState = !ring ? '…' : !active ? '○ None' : check.startsWith('fail:') ? `✕ ${service}` : `● ${service}`

  return Box({
    flexDirection: 'column',
    gap: 'md',
    children: [
      header,
      divider,
      section(
        'Routing rules',
        [
          levelRow('trivial', '▂  ', 'Trivial'),
          levelRow('standard', '▂▄ ', 'Standard'),
          levelRow('hard', '▂▄▆', 'Hard'),
          Svg
            ? Svg({ source: svgRule(px, true), alt: '', width: px, height: 3 })
            : Text({ dimColor: true, wrap: 'truncate', children: ['╌'.repeat(Math.max(8, e.props.bodyColumns))] }),
          row(
            Text({ children: ['↳  When unsure'] }),
            Select({
              key: 'effort-unsure',
              options: [{ value: 'session', label: 'Session default' }, ...effortOptions],
              value: unsureEffort ?? 'session',
              onSelect: v => saveOption($, 'unsure_effort', 'when unsure', v),
            }),
          ),
          note('Used when confidence is low or no classifier responds.'),
        ],
        'Reasoning effort',
      ),
      divider,
      Box({
        flexDirection: 'column',
        gap: 'sm',
        children: [
          row(
            Text({ weight: 'semibold', size: 'heading', children: ['Classifier'] }),
            Button({
              key: 'classifier',
              plain: true,
              onPress: () => update($, classifierOpen, v => !v),
              children: [
                Text({ color: active && !check.startsWith('fail:') ? 'green' : undefined, children: [classifierState] }),
                Text({ dimColor: true, children: [open ? '  ⌄' : '  ›'] }),
              ],
            }),
          ),
          ...(open ? [status, ...(active ? [note(`Jev ${from[active.source]}`)] : []), ...services, ...keyControls] : []),
        ],
      }),
      divider,
      footer,
    ],
  })
}

// Saves what the pane's drawing did where it can be read after the fact
function noteRender($: EngineInterface) {
  const note = { ...renders }
  $.clock.after(0, () => void $.store.set('render', note).catch(() => {}))
}

export const register: Register = (on, options) => {
  effortFor = {
    trivial: asEffort(options.trivial_effort, 'low'),
    standard: asEffort(options.standard_effort, 'medium'),
    hard: asEffort(options.hard_effort, 'xhigh'),
  }
  unsureEffort = options.unsure_effort === 'session' ? undefined : asEffort(options.unsure_effort, 'xhigh')
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  configuredKeys = { openrouter: text(options.openrouter_api_key), typesafe: text(options.typesafe_api_key) }
  preferred = options.jev_service === 'typesafe' ? 'typesafe' : 'openrouter'
  hardAt = asNumber(options.hard_threshold, 40, 5, 95)
  trivialAt = asNumber(options.trivial_threshold, 70, 5, 99)

  on('session.start', async ($, e, next) => {
    enabled = (await $.store.get('enabled')) !== false
    const savedDecisions = await $.store.get('decisions')
    if (Array.isArray(savedDecisions)) decisions = savedDecisions as DecisionRow[]
    const savedSteps = await $.store.get('steps')
    if (Array.isArray(savedSteps)) steps = savedSteps as StepRow[]
    const settings = await $.store.get('settings')
    if (settings && typeof settings === 'object') {
      for (const [field, value] of Object.entries(settings)) if (typeof value === 'string' || typeof value === 'number') applyOption(field, value)
    }
    if (await read($, paneOpen)) void openSettings($).catch(() => {})
    void findKeys($).then(() => $.ui.invalidate('ui.render')).catch(() => {})
    try {
      await $.command.register({
        name: 'effort-router',
        description: 'Effort router: no argument for the settings pane, or stats, on, off, try <prompt>, reset',
        argumentHint: '[stats|on|off|try <prompt>|reset]',
      })
    } catch (error) {
      $.ui.log('could not register /effort-router: ' + String(error))
    }
    return next(e)
  })

  on('command.run', { command: 'effort-router' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    switch (verb.toLowerCase()) {
      case '':
      case 'settings':
      case 'config': {
        const opened = await openSettings($)
        void testJev($).catch(() => {})
        return opened.isPlaced ? {} : { text: `The settings pane is waiting: ${opened.reason ?? 'no room'}.` }
      }
      case 'on':
      case 'off':
        await setEnabled($, verb.toLowerCase() === 'on')
        return { text: enabled ? 'Effort router on.' : "Effort router off: requests go out at the session's own effort." }
      case 'try': {
        const prompt = rest.join(' ')
        if (!prompt) return { text: 'Usage: /effort-router try <prompt>' }
        const v = await classify($, prompt, '')
        return { text: label(v, v.want && effortFor[v.want]) + (v.error ? ` (Jev: ${v.error})` : '') }
      }
      case 'reset':
        decisions = []
        steps = []
        await $.store.set('decisions', decisions)
        await $.store.set('steps', steps)
        $.ui.invalidate('ui.render')
        return { text: 'Cleared the router stats.' }
      case 'stats': {
        const now = `${level ?? 'unrated'} (${turnEffort() ?? "session's own"})`
        const map = `trivial ${effortFor.trivial}, standard ${effortFor.standard}, hard ${effortFor.hard}`
        const rules = `hard at ${hardAt}%, trivial at ${trivialAt}%`
        return {
          text: `Router ${enabled ? 'on' : 'off'}. Current turn: ${now}. Mapping: ${map}. Rules: ${rules}. Change them with /effort-router.\nKey: ${(() => { const k = activeKey(keyring); return k ? `${PROVIDERS[k.provider].name} from ${k.source}` : keyring ? 'none' : 'not looked up' })()}. Settings pane drawn ${renders.ok} of ${renders.count} times${renders.error ? `; last failure: ${renders.error}` : ''}.\n${report(decisions, steps)}`,
        }
      }
      default:
        return { text: 'Usage: /effort-router for settings, /effort-router stats, /effort-router on, /effort-router off, /effort-router try <prompt>, or /effort-router reset.' }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    renders.count += 1
    try {
      const tree = await drawSettings($, e)
      renders.ok += 1
      if (renders.ok === 1) noteRender($)
      return tree
    } catch (error) {
      renders.error = `threw: ${String(error).slice(0, 300)}`
      noteRender($)
      const { Text } = $.ui.resolve(e)
      return Text({ color: 'red', wrap: 'wrap', children: [`effort-router could not draw its settings (${renders.error}).`] })
    }
  }).catch(($, e, next) => {
    renders.error = `${next.error?.kind ?? 'failed'}: ${next.error?.message ?? ''}`.slice(0, 300)
    noteRender($)
    const { Text } = $.ui.resolve(e)
    return Text({ color: 'red', wrap: 'wrap', children: [`effort-router's settings hook failed (${renders.error}).`] })
  })

  // Closed by the person or the mod: stay closed. Closed by a reload: reopen at session.start.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await update($, paneOpen, () => false)
    return next(e)
  })

  // Keep each main turn's prompt for its first request
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) texts.set(e.turnId, e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagents keep their own effort, and a model without effort gets none
    if (e.agentId !== undefined || e.effort === undefined || !enabled) return yield* next(e)

    if (e.turnId !== lastTurnId) {
      lastTurnId = e.turnId
      const prompt = texts.get(e.turnId) ?? ''
      texts.clear()
      // A continuation has no prompt of its own: it keeps the effort of the turn it continues
      if (prompt.trim()) {
        const started = await $.clock.now()
        const v = await classify($, prompt, await lastReply($))
        // No rating (unsure, or both classifiers failed): the session's own effort
        level = v.want
        const effort = turnEffort()
        const row: DecisionRow = { at: started, source: v.source, ms: (await $.clock.now()) - started }
        if (v.want) row.want = v.want
        if (v.probs) row.probs = v.probs
        if (effort) row.effort = effort
        if (v.error) row.error = v.error
        decisions = [...decisions, row].slice(-KEEP)
        $.ui.status(label(v, effort))
        $.ui.log(label(v, effort) + ` · ${row.ms}ms` + (v.error ? ` · Jev: ${v.error}` : ''))
        $.ui.invalidate('ui.render')
        await $.store.set('decisions', decisions)
      }
    }

    const effort = turnEffort()
    const result = yield* next(effort && effort !== e.effort ? { ...e, effort } : e)

    const u = result.usage
    if (u) {
      steps = [
        ...steps,
        {
          at: await $.clock.now(),
          sent: String(effort ?? e.effort),
          input: u.input_tokens,
          read: u.cache_read_input_tokens,
          wrote: u.cache_creation_input_tokens,
          output: u.output_tokens,
        },
      ].slice(-KEEP)
      await $.store.set('steps', steps)
    }
    return result
  })
}
