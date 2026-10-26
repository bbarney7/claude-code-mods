import { atom, read, update } from 'claude-code'
import type { EngineInterface, Origin, PluginRegisterUses, Register, RenderInput } from 'claude-code'

import type { Activity, Category, ModRecord, Risk, Severity, Verdict } from '../types'
import { paneBody } from './pane'
import type { PaneAction, PaneProps } from './pane'

const SELF = 'mod-firewall'
const PANE = 'mod-firewall'
const ACTIVITY_CAP = 100

const mods = atom({ plugin: 'mod-firewall', key: 'mods' } as const, [])
const activity = atom({ plugin: 'mod-firewall', key: 'activity' } as const, [])
const blockedCount = atom({ plugin: 'mod-firewall', key: 'blockedCount' } as const, 0)

// ---------- what counts as sensitive ----------

export type Mode = 'ask' | 'strict' | 'audit'
export type Config = { mode: Mode; trusted: string[]; refuseRiskyAtLoad: boolean }
export const DEFAULT_CONFIG: Config = { mode: 'ask', trusted: [], refuseRiskyAtLoad: false }

export function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const mode = options.mode as Mode
  return {
    mode: mode === 'ask' || mode === 'strict' || mode === 'audit' ? mode : DEFAULT_CONFIG.mode,
    trusted: String(options.trusted ?? '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
    refuseRiskyAtLoad: options.refuseRiskyAtLoad === true,
  }
}

const SECRET_PATHS: readonly RegExp[] = [
  /(^|\/)\.env(\.[\w.-]+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.(npmrc|netrc|pypirc|git-credentials)$/,
  /(^|\/)\.config\/gh\/hosts\.ya?ml$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.claude\.json$/,
  /(^|\/)\.codex\/auth\.json$/,
  /(^|\/)Library\/Keychains\//,
]

export function isSecretPath(path: string): boolean {
  return SECRET_PATHS.some(pattern => pattern.test(path))
}

export function isSecretEnvName(name: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSW(OR)?D|PASS$|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i.test(name)
}

// Writes outside the project, or into places that run code later (shell rc files, launch agents, git hooks).
export function isRiskyWrite(path: string, projectRoot: string, home: string): boolean {
  if (/(^|\/)(\.zshrc|\.bashrc|\.bash_profile|\.profile|\.zprofile)$/.test(path)) return true
  if (/Library\/LaunchAgents\/|\/\.git\/hooks\/|\/\.ssh\/authorized_keys$/.test(path)) return true
  if (projectRoot && path.startsWith(`${projectRoot}/`)) return false
  if (path.startsWith('/tmp/') || path.startsWith('/private/tmp/') || path.startsWith('/var/folders/')) return false
  return path.startsWith('/') || (home !== '' && path.startsWith(home))
}

// Well-known token shapes, so a secret is caught even when it never sat in a .env file.
const TOKEN_PATTERNS: readonly [string, RegExp][] = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenRouter API key', /sk-or-v1-[A-Za-z0-9]{32,}/],
  ['an OpenAI API key', /sk-(?!ant-|or-)(proj-)?[A-Za-z0-9_-]{32,}/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

// Values from .env files worth watching for: long enough not to match by accident.
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2').trim()
    if (value.length >= 8) values.set(match[1] ?? '', value)
  }
  return values
}

// What secrets, if any, a piece of outgoing data carries: .env values by name, then token shapes.
export function findSecrets(text: string, known: ReadonlyMap<string, string>): string[] {
  if (!text) return []
  const found: string[] = []
  for (const [name, value] of known) {
    if (text.includes(value) || text.includes(encodeURIComponent(value))) found.push(`${name} from .env`)
  }
  for (const [label, pattern] of TOKEN_PATTERNS) {
    if (pattern.test(text)) found.push(label)
  }
  return found
}

// `grant` names what an "allow for this session" or "always allow" answer to a critical call covers:
// these secrets to this destination, so the same mod sending another secret, or elsewhere, still asks.
export type Check = { category: Category; severity: Severity; target: string; reason: string; grant?: string }

export function checkFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string } | undefined, known: ReadonlyMap<string, string>): Check {
  const method = (init?.method ?? 'GET').toUpperCase()
  let host = url
  try {
    host = new URL(url).host
  } catch {}
  const target = init?.socketPath ? `${method} ${url} (via socket ${init.socketPath})` : `${method} ${host}`
  const destination = init?.socketPath ? 'a local socket' : host
  const secrets = findSecrets([url, init?.body ?? '', ...Object.values(init?.headers ?? {})].join('\n'), known)
  if (secrets.length) {
    const sent = secrets.join(', ')
    return { category: 'network', severity: 'critical', target, reason: `send ${sent} to ${destination}`, grant: `${sent} to ${init?.socketPath ?? host}` }
  }
  return { category: 'network', severity: 'sensitive', target, reason: `network request to ${destination}` }
}

export function checkRead(path: string): Check {
  return isSecretPath(path)
    ? { category: 'secret-file', severity: 'sensitive', target: path, reason: `read a secrets file (${path})` }
    : { category: 'file-read', severity: 'info', target: path, reason: 'file read' }
}

export function checkWrite(path: string, projectRoot: string, home: string): Check {
  return isRiskyWrite(path, projectRoot, home)
    ? { category: 'file-write', severity: 'sensitive', target: path, reason: `write outside the project (${path})` }
    : { category: 'file-write', severity: 'info', target: path, reason: 'file write in the project' }
}

export function checkEnv(name: string): Check {
  return isSecretEnvName(name)
    ? { category: 'secret-env', severity: 'sensitive', target: name, reason: `read the environment variable ${name}` }
    : { category: 'env', severity: 'info', target: name, reason: 'environment variable read' }
}

export function checkProcess(argv: readonly string[]): Check {
  const shown = argv.join(' ').slice(0, 160)
  return { category: 'process', severity: 'sensitive', target: shown, reason: `run a program on your machine: ${shown}` }
}

// ---------- what a mod can do, from the engine's scan at load ----------

export function badgesFor(uses: PluginRegisterUses): { badges: string[]; risk: Risk } {
  const calls = new Set(uses.calls)
  const events = uses.events
  const has = (...names: string[]) => names.some(name => calls.has(name))
  const badges: string[] = []
  const network = has('http.fetch')
  const process = has('process.run', 'process.spawn')
  const files = has('fs.read', 'fs.list')
  const writes = has('fs.write')
  const secretEnv = (uses.env?.reads ?? []).filter(isSecretEnvName)
  const transcript = has('session.messages', 'model.fork')
  if (network) badges.push('network')
  if (process) badges.push('processes')
  if (files) badges.push('reads files')
  if (writes) badges.push('writes files')
  if (secretEnv.length) badges.push(`secret env: ${secretEnv.join(', ')}`)
  else if (uses.env?.reads.length) badges.push('env vars')
  if (transcript) badges.push('reads transcript')
  if (events.some(e => e === 'tool.call' || e === 'tool.check' || e === '*' || e.startsWith('tool.'))) badges.push('hooks tool calls')
  if (events.some(e => e === 'prompt.submit' || e === 'prompt.compose' || e === '*')) badges.push('rewrites prompts')
  if (events.some(e => ['http.fetch', 'fs.read', 'process.run', 'process.spawn', 'plugin.register', '*'].includes(e))) badges.push('watches other mods')
  const reach = process || files || writes || secretEnv.length > 0 || transcript
  const risk: Risk = network && reach ? 'high' : network || process || writes || secretEnv.length ? 'medium' : 'low'
  return { badges, risk }
}

// ---------- decisions ----------

export type Decision = 'allow' | 'ask' | 'block' | 'flag'

// `isSessionAllowed` is an answer given for this very call: the kind of call, or for a critical one the
// secret and destination it was granted for. Trust alone never lets a secret out.
export function decide(mode: Mode, severity: Severity, isTrusted: boolean, isBlockedMod: boolean, isSessionAllowed: boolean): Decision {
  if (severity === 'info') return 'allow'
  if (isBlockedMod) return 'block'
  if (mode === 'audit') return 'flag'
  if (severity === 'critical') return isSessionAllowed ? 'allow' : mode === 'strict' ? 'block' : 'ask'
  if (isTrusted || isSessionAllowed) return 'allow'
  return mode === 'strict' ? 'block' : 'ask'
}

// Calls Claude Code itself makes, or its bundled and admin-managed plugins, are not ours to police.
export function isPoliced(origin: Origin): boolean {
  if (origin.plugin === SELF || origin.plugin === 'engine' || origin.plugin === 'client') return false
  return origin.tier === 'user'
}

// ---------- module state (starts over on a reload) ----------

let config: Config = DEFAULT_CONFIG
let projectRoot = ''
let home = ''
let known = new Map<string, string>()
let rememberedTrust: string[] = []
let rememberedGrants: string[] = []
const sessionAllowed = new Set<string>()
const blockedMods = new Set<string>()
const pendingAsks = new Map<string, Promise<boolean>>()
let seq = 0

const ALLOW_ONCE = 'Allow once'
const ALLOW_SESSION = 'Allow for this session'
const ALWAYS = 'Always trust this mod'
const ALWAYS_SEND = 'Always allow sending this there'
const BLOCK = 'Block'

async function loadSecrets($: EngineInterface) {
  projectRoot = await $.session.root()
  home = (await $.env.get('HOME')) ?? ''
  const found = new Map<string, string>()
  for (const name of ['.env', '.env.local', '.env.development', '.env.production']) {
    try {
      for (const [key, value] of parseDotenv(await $.fs.read(`${projectRoot}/${name}`))) found.set(key, value)
    } catch {}
  }
  known = found
  await reloadTrust($)
  await reloadGrants($)
}

// The store is shared by every session of this plugin: read it fresh, so a trust given in another
// open session counts here, and a write here keeps what the others added.
async function reloadTrust($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get('trusted')
  rememberedTrust = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
  return rememberedTrust
}

async function reloadGrants($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get('secretGrants')
  rememberedGrants = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
  return rememberedGrants
}

// What an answer to this call is remembered under: the kind of call, or the secret and its destination.
function grantKey(mod: string, check: Check): string {
  return check.grant ? `${mod}:secret:${check.grant}` : `${mod}:${check.category}`
}

async function setGrants($: EngineInterface, fn: (grants: string[]) => string[]) {
  rememberedGrants = fn(await reloadGrants($))
  await $.store.set('secretGrants', rememberedGrants)
}

function isTrusted(mod: string): boolean {
  return config.trusted.includes(mod) || rememberedTrust.includes(mod)
}

async function setTrust($: EngineInterface, mod: string, trusted: boolean) {
  const stored = await reloadTrust($)
  rememberedTrust = trusted ? [...new Set([...stored, mod])] : stored.filter(name => name !== mod)
  if (trusted) blockedMods.delete(mod)
  await $.store.set('trusted', rememberedTrust)
  if (!trusted) await setGrants($, grants => grants.filter(key => !key.startsWith(`${mod}:`)))
  await touchMod($, mod, m => m)
}

async function setBlocked($: EngineInterface, mod: string, blocked: boolean) {
  if (blocked) {
    blockedMods.add(mod)
    rememberedTrust = (await reloadTrust($)).filter(name => name !== mod)
    await $.store.set('trusted', rememberedTrust)
    await setGrants($, grants => grants.filter(key => !key.startsWith(`${mod}:`)))
  } else blockedMods.delete(mod)
  await touchMod($, mod, m => m)
}

async function touchMod($: EngineInterface, name: string, fn: (mod: ModRecord) => ModRecord, provenance = '') {
  await update($, mods, list => {
    const at = list.findIndex(m => m.name === name)
    const base: ModRecord = list[at] ?? { name, provenance, badges: [], risk: 'low', seenAt: 'runtime', allowed: 0, blocked: 0 }
    const next = fn(base)
    return at >= 0 ? list.map((m, i) => (i === at ? next : m)) : [...list, next]
  })
}

async function record($: EngineInterface, mod: string, check: Check, verdict: Verdict) {
  seq += 1
  const entry: Activity = { id: `a${seq}`, at: await $.clock.now(), mod, category: check.category, target: check.target, verdict, reason: check.reason }
  await update($, activity, list => [...list, entry].slice(-ACTIVITY_CAP))
  if (verdict === 'info') return
  await touchMod($, mod, m => ({
    ...m,
    allowed: m.allowed + (verdict === 'allowed' || verdict === 'asked-allowed' || verdict === 'flagged' ? 1 : 0),
    blocked: m.blocked + (verdict === 'blocked' ? 1 : 0),
  }))
  if (verdict === 'blocked') {
    const total = (await read($, blockedCount)) + 1
    await update($, blockedCount, () => total)
    $.ui.status(`🛡 mod firewall: ${total} blocked`)
    $.ui.toast(`🛡 Blocked ${mod}: ${check.reason}`)
  }
  if (verdict === 'flagged' && check.severity === 'critical') $.ui.toast(`🛡 ${mod} sent a secret: ${check.reason}`)
}

// Asks once per mod and kind of call at a time: a burst of identical calls shares one dialog.
async function ask($: EngineInterface, mod: string, check: Check): Promise<boolean> {
  const key = `${grantKey(mod, check)}:${check.severity}`
  const waiting = pendingAsks.get(key)
  if (waiting) return waiting
  const asking = (async () => {
    const options = check.severity === 'critical' ? [ALLOW_ONCE, ALLOW_SESSION, ALWAYS_SEND, BLOCK] : [ALLOW_ONCE, ALLOW_SESSION, ALWAYS, BLOCK]
    const warning = check.severity === 'critical' ? '⚠ ' : ''
    try {
      const answer = await $.ui.ask(`${warning}The mod "${mod}" wants to ${check.reason}. Allow it?`, { options, header: 'Mod firewall' })
      if (answer === ALLOW_SESSION) sessionAllowed.add(grantKey(mod, check))
      if (answer === ALWAYS) await setTrust($, mod, true)
      if (answer === ALWAYS_SEND) await setGrants($, grants => [...new Set([...grants, grantKey(mod, check)])])
      if (answer === BLOCK) await setBlocked($, mod, true)
      return answer === ALLOW_ONCE || answer === ALLOW_SESSION || answer === ALWAYS || answer === ALWAYS_SEND
    } catch {
      // Dismissed, or nobody to ask (a -p run): the call does not go through.
      return false
    }
  })()
  pendingAsks.set(key, asking)
  try {
    return await asking
  } finally {
    pendingAsks.delete(key)
  }
}

// The one place every guarded call is judged. Returns a deny reason, or undefined to let it through.
async function judge($: EngineInterface, origin: Origin, check: Check): Promise<string | undefined> {
  if (!isPoliced(origin)) return undefined
  const mod = origin.plugin
  const key = grantKey(mod, check)
  const granted = () => sessionAllowed.has(key) || rememberedGrants.includes(key)
  let decision = decide(config.mode, check.severity, isTrusted(mod), blockedMods.has(mod), granted())
  if (decision === 'ask' && check.severity !== 'critical' && !isTrusted(mod) && (await reloadTrust($)).includes(mod)) decision = 'allow'
  // Granted in another open session since this one last looked.
  if (decision !== 'allow' && check.grant && !granted() && (await reloadGrants($)).includes(key)) {
    decision = decide(config.mode, check.severity, isTrusted(mod), blockedMods.has(mod), true)
  }
  if (decision === 'allow') {
    await record($, mod, check, check.severity === 'info' ? 'info' : 'allowed')
    return undefined
  }
  if (decision === 'flag') {
    await record($, mod, check, 'flagged')
    return undefined
  }
  if (decision === 'ask' && (await ask($, mod, check))) {
    await record($, mod, check, 'asked-allowed')
    return undefined
  }
  await record($, mod, check, 'blocked')
  return `mod firewall blocked ${mod}: ${check.reason}`
}

// ---------- drawing ----------

const VERDICT_MARK: Record<Verdict, string> = { allowed: '✓', 'asked-allowed': '✓', blocked: '✕', flagged: '!', info: '·' }
const VERDICT_COLOR: Record<Verdict, string> = { allowed: 'green', 'asked-allowed': 'green', blocked: 'red', flagged: 'yellow', info: 'gray' }
const RISK_COLOR: Record<Risk, string> = { low: 'green', medium: 'yellow', high: 'red' }

async function paneProps($: EngineInterface, rows: number): Promise<PaneProps> {
  const list = await read($, mods)
  const feed = await read($, activity)
  const blocked = await read($, blockedCount)
  const room = Math.max(5, rows - 8 - list.length * 3)
  return {
    header: `mode: ${config.mode} · ${list.length} mods seen · ${blocked} calls blocked · /config to change`,
    mods: list.map(mod => {
      const trusted = isTrusted(mod.name)
      const isBlocked = blockedMods.has(mod.name)
      const state = mod.refused ? `refused at load: ${mod.refused}` : isBlocked ? 'blocked' : trusted ? 'trusted' : 'watched'
      return {
        name: mod.name,
        color: RISK_COLOR[mod.risk],
        summary: `${mod.risk} risk · ${state} · ${mod.allowed} allowed, ${mod.blocked} blocked`,
        badges: mod.badges,
        trusted,
        blocked: isBlocked,
        refused: Boolean(mod.refused),
      }
    }),
    feed: feed.slice(-room).map(entry => ({
      id: entry.id,
      color: VERDICT_COLOR[entry.verdict],
      dim: entry.verdict === 'info',
      text: `${VERDICT_MARK[entry.verdict]} ${entry.mod}  ${entry.category}  ${entry.target.slice(0, 90)}${entry.verdict === 'blocked' ? '  (blocked)' : ''}`,
    })),
  }
}

async function paneAction($: EngineInterface, a: PaneAction) {
  if (a.type === 'clear') await update($, activity, () => [])
  else if (a.type === 'trust' || a.type === 'untrust') await setTrust($, a.mod, a.type === 'trust')
  else await setBlocked($, a.mod, a.type === 'block')
}

async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const elements = $.ui.resolve(e)
  const props = await paneProps($, e.viewport?.rows ?? 30)
  const Client = e.surface === 'desktop' && 'Client' in elements ? elements.Client : undefined
  if (Client) return <Client key="firewall-pane" module="./pane.tsx" width="100%" props={props} />
  return paneBody(elements, props, a => void paneAction($, a))
}

// ---------- registration ----------

// Each command is also declared in commands/, so a host lists it as `/mod-firewall:<name>` before
// any session exists (the desktop app's empty chat); the hooks answer both spellings.
export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await loadSecrets($)
    await $.command.register({ name: 'firewall', description: 'Open the mod firewall: what every mod is doing, and trust or block them' }).catch(
      error => $.ui.toast(`mod-firewall: ${String(error)}`),
    )
    return next(e)
  })

  on('command.run', { command: ['firewall', 'mod-firewall:firewall'] }, async $ => {
    await $.ui.open({ id: PANE, title: 'Mod firewall' })
    return { text: 'Mod firewall opened.' }
  })

  // At load: record what each later mod uses, and refuse risky untrusted ones when asked to.
  on('plugin.register', async ($, e, next) => {
    if (e.name === SELF || e.tier !== 'user') return next(e)
    const { badges, risk } = badgesFor(e.uses)
    $.ui.log(`mod-firewall: saw ${e.name} (${e.provenance}) at load: ${risk} risk${badges.length ? `, ${badges.join(', ')}` : ''}`, { to: 'debug' })
    const refuse = config.refuseRiskyAtLoad && risk === 'high' && !isTrusted(e.name) ? `uses ${badges.join(', ')}` : undefined
    await touchMod($, e.name, m => ({ ...m, provenance: e.provenance, badges, risk, seenAt: 'load', refused: refuse }), e.provenance)
    if (refuse) {
      $.ui.toast(`🛡 Refused to load ${e.name}: ${refuse}`)
      return { refuse: `mod firewall: ${refuse}` }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  on('http.fetch', async ($, e, next) => {
    const denied = await judge($, next.origin, checkFetch(e.url, e.init, known))
    return denied ? ({ deny: denied } as never) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : ({ deny: 'mod firewall could not judge this request' } as never)))

  on('fs.read', async ($, e, next) => {
    const denied = await judge($, next.origin, checkRead(e.path))
    return denied ? ({ deny: denied } as never) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : ({ deny: 'mod firewall could not judge this read' } as never)))

  on('fs.write', async ($, e, next) => {
    const denied = await judge($, next.origin, checkWrite(e.path, projectRoot, home))
    return denied ? ({ deny: denied } as never) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : ({ deny: 'mod firewall could not judge this write' } as never)))

  on('env.get', async ($, e, next) => {
    const denied = await judge($, next.origin, checkEnv(e.name))
    return denied ? ({ deny: denied } as never) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : ({ deny: 'mod firewall could not judge this read' } as never)))

  on('process.run', async ($, e, next) => {
    const denied = await judge($, next.origin, checkProcess(e.argv))
    return denied ? ({ deny: denied } as never) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : ({ deny: 'mod firewall could not judge this command' } as never)))

  on('process.spawn', async function* ($, e, next) {
    const denied = await judge($, next.origin, checkProcess(e.argv))
    if (denied) return { deny: denied } as never
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    if (next.called) return yield* next(e)
    return { deny: 'mod firewall could not judge this command' } as never
  })

  // Transcript access is logged, not gated: a mod reading the conversation is worth knowing about.
  on('session.messages', async ($, e, next) => {
    if (isPoliced(next.origin)) {
      await record($, next.origin.plugin, { category: 'transcript', severity: 'info', target: 'session.messages', reason: 'read the conversation' }, 'info')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The desktop's pane module posts the button pressed.
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'firewall-pane') return next(e)
    const a = e.data as PaneAction | undefined
    const isModAction = (a?.type === 'trust' || a?.type === 'untrust' || a?.type === 'block' || a?.type === 'unblock') && typeof a.mod === 'string'
    if (a && (isModAction || a.type === 'clear')) await paneAction($, a)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: 'mod-firewall' }, ($, e) => renderPane($, e))
}
