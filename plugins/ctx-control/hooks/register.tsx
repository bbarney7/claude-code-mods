import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey, ToolCallResult } from 'claude-code'

import {
  TAB_ORDER,
  abbreviateHome,
  applyEngineCounts,
  blockCounts,
  budgetCells,
  contextSummary,
  createToolCatalogItem,
  engineCountsFrom,
  formatCount,
  wrappedLineCount,
  displayMcpServer,
  filterDeferredToolNames,
  normalizeMcpServerName,
  estimateTokens,
  filterMcpInstructions,
  filterSkillListing,
  folderLabel,
  formatTokens,
  isHidden,
  isServerBlockPattern,
  isToolBlocked,
  isToggleable,
  findProfile,
  migratePatterns,
  normalizePatterns,
  paginateHeights,
  parseMcpInstructions,
  parseMcpToolServer,
  parseProfiles,
  parseSkillListing,
  presetDiffers,
  profileNameError,
  profileNames,
  resolvePreset,
  sanitizeCatalog,
  showFromPreset,
  skillNamespace,
  splitArguments,
  stringArray,
  tabTotals,
  toolState,
  withoutMatchingToolBlocks,
} from './lib'
import type {
  CatalogItem,
  CatalogTab,
  ContextSummary,
  EngineCounts,
  ParsedTextItem,
  Profiles,
  ToolState,
} from './lib'

const PANE = 'ctx-control'
const activeTab = atom(
  { plugin: 'ctx-control', key: 'activeTab' } as const,
  'skills' as CatalogTab,
)
const filter = atom({ plugin: 'ctx-control', key: 'filter' } as const, '')
const page = atom({ plugin: 'ctx-control', key: 'page' } as const, 0)
const expandedToolGroups = atom(
  { plugin: 'ctx-control', key: 'expandedToolGroups' } as const,
  [] as string[],
)
// The pane's profile row: whether the name field is open, what's typed in it, and which
// profile's Delete has been pressed once and waits for a second press.
const profileNaming = atom({ plugin: 'ctx-control', key: 'profileNaming' } as const, false)
const profileDraft = atom({ plugin: 'ctx-control', key: 'profileDraft' } as const, '')
const profileDeleting = atom({ plugin: 'ctx-control', key: 'profileDeleting' } as const, '')
const INVALIDATED = [
  'prompt.context',
  'prompt.section',
  'prompt.attachment',
  'tool.describe',
] as const

const TAB_LABELS: Record<CatalogTab, string> = {
  skills: 'Skills',
  tools: 'Tools',
  files: 'Files',
  other: 'Other',
}

const TAB_COLORS: Record<CatalogTab, ThemeKey> = {
  skills: 'suggestion',
  tools: 'permission',
  files: 'success',
  other: 'warning',
}

let activeCwd = ''
let homeDir: string | undefined
let homeLoaded = false
let applyToastShown = false
let pendingPresetChange = false
let activePreset: string[] = []
let profiles: Profiles = {}
// The profile this folder last picked. Its patterns are applied again at every session start,
// so changes made since picking it last until they're saved to it or the session ends.
let activeProfile: string | undefined

const catalogCache = new Map<string, CatalogItem[]>()
const catalogQueue = new Map<string, Promise<void>>()
const presetCache = new Map<string, string[]>()
const skillFallbackByCwd = new Map<string, boolean>()
const confirmedSkillsByCwd = new Set<string>()
const knownSkills = new Set<string>()
const eagerTools = new Set<string>()
// Built-in tools the engine reported as on demand; a built-in in neither set is assumed eager.
const deferredBuiltins = new Set<string>()
const knownMcpServers = new Set<string>()
// Other-tab items seen in this session; the rest are remembered from earlier ones.
const confirmedOther = new Set<string>()

// Claude Code's own context breakdown (what its Context panel shows). It doesn't apply this
// mod's hiding (verified), so the pane subtracts what it hides itself.
let engineCounts: EngineCounts | undefined
let engineCountsAt = 0
let engineCountsInFlight: Promise<void> | undefined
// Each read asks the token-count API, so automatic refreshes wait this long between reads.
const ENGINE_COUNTS_MIN_AGE_MS = 30_000

type SectionRow = {
  kind: 'section'
  key: string
  label: string
}

type CaptionRow = {
  kind: 'caption'
  key: string
  text: string
}

type GroupRow = {
  kind: 'group'
  key: string
  label: string
  items: CatalogItem[]
  mode: 'generic' | 'eager' | 'deferred'
  expanded?: boolean
}

type ItemRow = {
  kind: 'item'
  key: string
  item: CatalogItem
}

type EmptyRow = {
  kind: 'empty'
  key: string
  text: string
}

type PaneRow = SectionRow | CaptionRow | GroupRow | ItemRow | EmptyRow

// What a hover card shows: the full name, what it is, and a dim line on what it costs.
type HoverCard = { title: string; body?: string; meta?: string }

// Cuts text to at most `max` characters at a word boundary, with an ellipsis.
function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

// Rows still to blank after our own /ctx ran: caveat, command line, output (that order, verified).
let ctxRowsToBlank = 0

function isCtxCommandRow(content: unknown): boolean {
  if (ctxRowsToBlank === 0) return false
  const text = Array.isArray(content)
    ? content.map(block => (block !== null && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')
    : ''
  const ours = text.includes('<local-command-caveat>') ||
    /<command-name>\/(ctx-control:)?ctx<\/command-name>/.test(text) ||
    text.includes('<local-command-stdout>')
  if (!ours) {
    ctxRowsToBlank = 0
    return false
  }
  ctxRowsToBlank -= 1
  return true
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log($: EngineInterface, message: string, toDebug = false): void {
  try {
    $.ui.log(message, toDebug ? { to: 'debug' } : undefined)
  } catch {
    // Logging must never turn a best-effort update or /ctx into a skipped hook.
  }
}

async function trySet(
  $: EngineInterface,
  key: string,
  value: unknown,
): Promise<boolean> {
  try {
    await $.store.set(key, value)
    return true
  } catch (error) {
    log($, `ctx-control: could not save ${key}: ${errorMessage(error)}`, true)
    return false
  }
}

async function cwdForSession($: EngineInterface): Promise<string> {
  if (activeCwd !== '') return activeCwd
  activeCwd = await $.session.cwd()
  return activeCwd
}

async function loadHome($: EngineInterface): Promise<string | undefined> {
  if (!homeLoaded) {
    homeDir = await $.env.get('HOME')
    homeLoaded = true
  }
  return homeDir
}

const serverNameHints = new Map<string, string>()

async function loadServerNameHints($: EngineInterface): Promise<void> {
  try {
    const stored = await $.store.get('mcp:names')
    if (stored !== null && typeof stored === 'object') {
      for (const [server, name] of Object.entries(stored as Record<string, unknown>)) {
        if (typeof name === 'string') serverNameHints.set(server, name)
      }
    }
  } catch {
    // names are a nicety; the raw server id still shows
  }
}

async function saveServerNameHints(
  $: EngineInterface,
  items: readonly { id: string; label: string }[],
): Promise<void> {
  let changed = false
  for (const item of items) {
    const server = item.id.slice('mcpdoc:'.length)
    if (item.label === server || serverNameHints.get(server) === item.label) continue
    serverNameHints.set(server, item.label)
    changed = true
  }
  if (changed) await trySet($, 'mcp:names', Object.fromEntries(serverNameHints))
}

function serverLabel(server: string, toolNames: readonly string[]): string {
  return serverNameHints.get(server) ??
    [...serverNameHints.entries()].find(([key]) => normalizeMcpServerName(key) === normalizeMcpServerName(server))?.[1] ??
    displayMcpServer(server, toolNames)
}

async function loadCatalog(_$: EngineInterface, cwd: string): Promise<CatalogItem[]> {
  const cached = catalogCache.get(cwd)
  if (cached !== undefined) return cached
  catalogCache.set(cwd, [])
  return []
}

function sameCatalogItem(left: CatalogItem, right: CatalogItem): boolean {
  return left.id === right.id &&
    left.tab === right.tab &&
    left.label === right.label &&
    left.description === right.description &&
    left.tokens === right.tokens &&
    left.server === right.server &&
    left.eager === right.eager &&
    left.kind === right.kind
}

async function mergeCatalog(
  $: EngineInterface,
  cwd: string,
  incoming: readonly CatalogItem[],
): Promise<void> {
  if (incoming.length === 0) return
  const previous = catalogQueue.get(cwd) ?? Promise.resolve()
  const queued = previous.then(() => mergeCatalogNow($, cwd, incoming))
  catalogQueue.set(cwd, queued)
  await queued
  if (catalogQueue.get(cwd) === queued) catalogQueue.delete(cwd)
}

async function mergeCatalogNow(
  $: EngineInterface,
  cwd: string,
  incoming: readonly CatalogItem[],
): Promise<void> {
  const current = await loadCatalog($, cwd)
  const byId = new Map(current.map(item => [item.id, item]))
  let changed = false

  for (const item of incoming) {
    const previous = byId.get(item.id)
    if (previous === undefined || !sameCatalogItem(previous, item)) {
      byId.set(item.id, item)
      changed = true
    }
  }

  const other = incoming.filter(item => item.tab === 'other')
  if (other.length > 0) await rememberOtherItems($, other)

  if (!changed) return
  const merged = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
  catalogCache.set(cwd, merged)
  $.ui.invalidate('ui.render')
}

async function replaceCatalogTab(
  $: EngineInterface,
  cwd: string,
  tab: CatalogTab,
  incoming: readonly CatalogItem[],
): Promise<void> {
  const previous = catalogQueue.get(cwd) ?? Promise.resolve()
  const queued = previous.then(async () => {
    const current = await loadCatalog($, cwd)
    const replacement = [...incoming].sort((left, right) => left.id.localeCompare(right.id))
    const next = [
      ...current.filter(item => item.tab !== tab),
      ...replacement,
    ].sort((left, right) => left.id.localeCompare(right.id))
    if (
      current.length === next.length &&
      current.every((item, index) => {
        const candidate = next[index]
        return candidate !== undefined && sameCatalogItem(item, candidate)
      })
    ) return
    catalogCache.set(cwd, next)
    if (tab === 'other') await rememberOtherItems($, replacement)
    $.ui.invalidate('ui.render')
  })
  catalogQueue.set(cwd, queued)
  await queued
  if (catalogQueue.get(cwd) === queued) catalogQueue.delete(cwd)
}

let rememberedOtherItems: CatalogItem[] = []

function mergeNewestItems(
  current: readonly CatalogItem[],
  incoming: readonly CatalogItem[],
): CatalogItem[] {
  const byId = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) {
    byId.delete(item.id)
    byId.set(item.id, item)
  }
  return [...byId.values()].slice(-60)
}

async function rememberOtherItems(
  $: EngineInterface,
  incoming: readonly CatalogItem[],
): Promise<void> {
  const next = mergeNewestItems(rememberedOtherItems, incoming.filter(item => item.tab === 'other'))
  if (JSON.stringify(next) === JSON.stringify(rememberedOtherItems)) return
  rememberedOtherItems = next
  await trySet($, 'other:items', next)
}

async function deleteStoreKey($: EngineInterface, key: string): Promise<void> {
  try {
    await $.store.delete(key)
  } catch (error) {
    log($, `ctx-control: could not delete ${key}: ${errorMessage(error)}`, true)
  }
}

async function migrateStore(
  $: EngineInterface,
  home: string | undefined,
): Promise<void> {
  let keys: string[] = []
  try {
    keys = await $.store.keys()
  } catch (error) {
    log($, `ctx-control: could not list its store: ${errorMessage(error)}`, true)
  }

  const storedKnownRaw = await $.store.get('skills:known').catch(() => undefined)
  const storedKnown = stringArray(storedKnownRaw) ?? []
  const migratedKnown = new Set(storedKnown)
  const storedOtherRaw = await $.store.get('other:items').catch(() => undefined)
  const storedOther = sanitizeCatalog(storedOtherRaw).filter(item => item.tab === 'other')
  let migratedOther = storedOther
  const catalogKeys = keys.filter(key => key.startsWith('catalog:'))

  for (const key of catalogKeys) {
    const catalog = sanitizeCatalog(await $.store.get(key).catch(() => undefined))
    for (const item of catalog) {
      if (item.tab === 'skills' && item.id.startsWith('skill:')) {
        migratedKnown.add(item.id.slice('skill:'.length))
      }
    }
    migratedOther = mergeNewestItems(
      migratedOther,
      catalog.filter(item => item.tab === 'other'),
    )
  }

  const stalePresetKeys: string[] = []
  const scratchRoot = home === undefined
    ? undefined
    : `${home}/Library/Application Support/Claude/scratch-workspaces/`
  if (scratchRoot !== undefined) {
    for (const key of keys) {
      const prefix = ['preset:', 'profile:'].find(candidate => key.startsWith(candidate))
      if (prefix === undefined) continue
      const path = key.slice(prefix.length)
      if (!path.startsWith(scratchRoot)) continue
      const exists = await $.fs.stat(path).then(() => true).catch(() => false)
      if (!exists) stalePresetKeys.push(key)
    }
  }

  // Deleting old catalogs first is what lets migration recover an already-full store.
  for (const key of [...catalogKeys, ...stalePresetKeys]) await deleteStoreKey($, key)

  knownSkills.clear()
  for (const name of migratedKnown) knownSkills.add(name)
  rememberedOtherItems = migratedOther.slice(-60)
  const seededKnown = normalizePatterns([...knownSkills])
  if (
    stringArray(storedKnownRaw) === undefined ||
    JSON.stringify(storedKnown) !== JSON.stringify(seededKnown)
  ) await trySet($, 'skills:known', seededKnown)
  if (
    !Array.isArray(storedOtherRaw) ||
    JSON.stringify(storedOther) !== JSON.stringify(rememberedOtherItems)
  ) await trySet($, 'other:items', rememberedOtherItems)
}

async function loadToolRegistry($: EngineInterface): Promise<void> {
  const raw = await $.store.get('tools:eager').catch(() => undefined)
  const parsed = stringArray(raw)
  eagerTools.clear()
  for (const name of parsed ?? []) eagerTools.add(name)
  if (parsed === undefined) await trySet($, 'tools:eager', [])
  deferredBuiltins.clear()
  const deferred = stringArray(await $.store.get('tools:deferred').catch(() => undefined))
  for (const name of deferred ?? []) deferredBuiltins.add(name)
}

async function rememberSkills(
  $: EngineInterface,
  names: readonly string[],
): Promise<void> {
  const before = normalizePatterns([...knownSkills])
  for (const name of names) knownSkills.add(name)
  const next = normalizePatterns([...knownSkills])
  if (JSON.stringify(before) !== JSON.stringify(next)) await trySet($, 'skills:known', next)
}

async function recordToolEagerness(
  $: EngineInterface,
  name: string,
  eager: boolean,
): Promise<void> {
  const before = normalizePatterns([...eagerTools])
  if (eager) eagerTools.add(name)
  else eagerTools.delete(name)
  const next = normalizePatterns([...eagerTools])
  if (JSON.stringify(before) !== JSON.stringify(next)) await trySet($, 'tools:eager', next)

  // MCP tools are on demand unless listed eager; only built-ins need the opposite list.
  if (parseMcpToolServer(name) !== undefined) return
  const deferredBefore = deferredBuiltins.has(name)
  if (eager) deferredBuiltins.delete(name)
  else deferredBuiltins.add(name)
  if (deferredBefore !== deferredBuiltins.has(name)) {
    await trySet($, 'tools:deferred', normalizePatterns([...deferredBuiltins]))
  }
}

// `full` counts with the token-count API, as /context and the desktop's Context panel do;
// `summary` is local and free but overstates built-in tools (24.2k against 13.2k, measured).
async function readBreakdown($: EngineInterface) {
  try {
    const full = (await $.session.usage({ breakdown: 'full' })).context.breakdown
    if (full !== undefined) return full
  } catch (error) {
    log($, `ctx-control: full context breakdown failed, using the estimate: ${errorMessage(error)}`, true)
  }
  return (await $.session.usage({ breakdown: 'summary' })).context.breakdown
}

async function fetchEngineCounts($: EngineInterface): Promise<void> {
  // Stamped before asking, so a failing or empty answer is retried at most every so often.
  engineCountsAt = Date.now()
  try {
    const breakdown = await readBreakdown($)
    if (breakdown === undefined) return
    const next = engineCountsFrom(breakdown)
    if (JSON.stringify(next) === JSON.stringify(engineCounts)) return
    engineCounts = next
    // Instruction files otherwise only arrive with the first message; the breakdown has them now.
    await mergeCatalog($, activeCwd, Object.entries(next.memoryFiles).map(([path, tokens]) => {
      const kind = next.memoryFileTypes[path] ?? 'memory'
      return {
        id: `file:${path}`,
        tab: 'files' as const,
        label: abbreviateHome(path, homeDir),
        description: kind,
        kind,
        tokens,
      }
    }))
    $.ui.invalidate('ui.render')
    await refreshStatus($, activeCwd)
  } catch (error) {
    log($, `ctx-control: could not read Claude Code's context breakdown: ${errorMessage(error)}`, true)
  }
}

let trailingRefresh: { cancel: () => void } | undefined

/** Best effort: the pane falls back to estimates until Claude Code's breakdown arrives. */
async function refreshEngineCounts($: EngineInterface, force = false): Promise<void> {
  const age = Date.now() - engineCountsAt
  if (!force && age < ENGINE_COUNTS_MIN_AGE_MS) {
    // Too soon to ask again: read once more when the wait is over, so the last change still lands.
    try {
      trailingRefresh ??= $.clock.after(ENGINE_COUNTS_MIN_AGE_MS - age, () => {
        trailingRefresh = undefined
        void refreshEngineCounts($)
      })
    } catch (error) {
      log($, `ctx-control: could not schedule a context recount: ${errorMessage(error)}`, true)
    }
    return
  }
  trailingRefresh?.cancel()
  trailingRefresh = undefined
  if (engineCountsInFlight !== undefined) return engineCountsInFlight
  engineCountsInFlight = fetchEngineCounts($)
  try {
    await engineCountsInFlight
  } finally {
    engineCountsInFlight = undefined
  }
}

function isConfirmedOther(item: CatalogItem): boolean {
  if (confirmedOther.has(item.id)) return true
  if (!item.id.startsWith('mcpdoc:')) return false
  const heading = normalizeMcpServerName(item.id.slice('mcpdoc:'.length))
  return [...knownMcpServers].some(server => normalizeMcpServerName(server) === heading)
}

/** The catalog as the pane counts it: Claude Code's numbers applied, unconfirmed leftovers marked. */
function viewCatalog(catalog: readonly CatalogItem[]): CatalogItem[] {
  const marked = catalog.map(item =>
    item.tab === 'other' && !isConfirmedOther(item) ? { ...item, stale: true } : item,
  )
  return applyEngineCounts(marked, engineCounts)
}

async function summaryFor(
  $: EngineInterface,
  cwd: string,
): Promise<{ catalog: CatalogItem[]; hidden: string[]; summary: ContextSummary }> {
  const catalog = viewCatalog(await loadCatalog($, cwd))
  const hidden = await loadHidden($, cwd)
  return { catalog, hidden, summary: contextSummary(catalog, hidden, engineCounts) }
}

async function refreshAvailableCatalog(
  $: EngineInterface,
  cwd: string,
): Promise<void> {
  const [commands, tools] = await Promise.all([$.command.list(), $.tool.list()])
  const fallback = knownSkills.size === 0
  skillFallbackByCwd.set(cwd, fallback)

  const skillItems = commands
    .filter(command => fallback
      ? command.source === 'plugin' || command.source === 'user'
      : knownSkills.has(command.name))
    .map(command => ({
      id: `skill:${command.name}`,
      tab: 'skills' as const,
      label: command.name,
      description: command.description,
      tokens: estimateTokens(`- ${command.name}: ${command.description}`),
    }))
  const toolItems = tools.map(tool => {
    const eager = eagerTools.has(tool.name) || (!tool.mcp && !deferredBuiltins.has(tool.name))
    const server = parseMcpToolServer(tool.name)
    if (server !== undefined) knownMcpServers.add(server)
    return createToolCatalogItem(
      tool.name,
      tool.description,
      eager ? undefined : true,
    )
  })

  if (!confirmedSkillsByCwd.has(cwd)) {
    await replaceCatalogTab($, cwd, 'skills', skillItems)
  }
  await replaceCatalogTab($, cwd, 'tools', toolItems)
}

async function migrateStoredPreset(
  $: EngineInterface,
  key: string,
  value: unknown,
): Promise<string[] | undefined> {
  const parsed = stringArray(value)
  if (parsed === undefined) return undefined
  const migrated = migratePatterns(parsed)
  if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
    await trySet($, key, migrated)
  }
  return migrated
}

async function loadPresetAtSessionStart($: EngineInterface, cwd: string): Promise<string[]> {
  const folderKey = `preset:${cwd}`
  const folder = await migrateStoredPreset($, folderKey, await $.store.get(folderKey))
  const defaults = await migrateStoredPreset($, 'preset:default', await $.store.get('preset:default'))
  const hidden = resolvePreset(folder, defaults)
  presetCache.set(cwd, hidden)
  activePreset = hidden
  return hidden
}

async function loadHidden(_$: EngineInterface, cwd: string): Promise<string[]> {
  const cached = presetCache.get(cwd)
  if (cached !== undefined) return cached
  return cwd === activeCwd ? activePreset : []
}

function invalidateContext($: EngineInterface): void {
  for (const event of INVALIDATED) $.ui.invalidate(event)
  $.ui.invalidate('ui.render')
}

async function refreshStatus($: EngineInterface, cwd: string): Promise<void> {
  const { saved } = (await summaryFor($, cwd)).summary
  const counts = blockCounts(activePreset)
  const blocked = counts.servers + counts.tools
  const parts = [
    ...(saved === 0 ? [] : [`-${formatTokens(saved)} hidden`]),
    ...(blocked === 0 ? [] : [`blocking ${counts.servers} server${counts.servers === 1 ? '' : 's'} and ${counts.tools} tool${counts.tools === 1 ? '' : 's'}`]),
  ]
  $.ui.status(parts.length === 0 ? undefined : `ctx: ${parts.join(', ')}`)
}

async function saveFolderPreset(
  $: EngineInterface,
  cwd: string,
  hidden: readonly string[],
): Promise<void> {
  const normalized = migratePatterns(hidden)
  presetCache.set(cwd, normalized)
  if (cwd === activeCwd) activePreset = normalized
  pendingPresetChange = true
  invalidateContext($)
  await refreshStatus($, cwd)
  await trySet($, `preset:${cwd}`, normalized)
}

function showApplyToast($: EngineInterface): void {
  if (applyToastShown) return
  applyToastShown = true
  $.ui.toast(
    'Takes effect on your next message. The first one after a change costs a little more while the cache refreshes.',
  )
}

async function loadProfiles($: EngineInterface, cwd: string): Promise<void> {
  profiles = parseProfiles(await $.store.get('profiles').catch(() => undefined))
  const pointer = await $.store.get(`profile:${cwd}`).catch(() => undefined)
  activeProfile = typeof pointer === 'string' ? findProfile(profiles, pointer) : undefined
  if (typeof pointer === 'string' && activeProfile === undefined) {
    await deleteStoreKey($, `profile:${cwd}`)
  }
  const patterns = activeProfile === undefined ? undefined : profiles[activeProfile]
  if (patterns !== undefined && presetDiffers(patterns, await loadHidden($, cwd))) {
    presetCache.set(cwd, patterns)
    if (cwd === activeCwd) activePreset = patterns
    await trySet($, `preset:${cwd}`, patterns)
  }
}

async function saveProfiles($: EngineInterface): Promise<boolean> {
  return trySet($, 'profiles', profiles)
}

async function setActiveProfile(
  $: EngineInterface,
  cwd: string,
  name: string | undefined,
): Promise<void> {
  activeProfile = name
  if (name === undefined) await deleteStoreKey($, `profile:${cwd}`)
  else await trySet($, `profile:${cwd}`, name)
  $.ui.invalidate('ui.render')
}

async function useProfile($: EngineInterface, cwd: string, name: string): Promise<void> {
  const patterns = profiles[name]
  if (patterns === undefined) return
  await setActiveProfile($, cwd, name)
  await saveFolderPreset($, cwd, patterns)
  showApplyToast($)
}

// Saves what this folder has on and off now as a profile, new or replacing one, and uses it.
async function saveProfile($: EngineInterface, cwd: string, name: string): Promise<void> {
  profiles = { ...profiles, [name]: await loadHidden($, cwd) }
  if (!await saveProfiles($)) return
  await setActiveProfile($, cwd, name)
}

async function deleteProfile($: EngineInterface, cwd: string, name: string): Promise<void> {
  const { [name]: _removed, ...rest } = profiles
  profiles = rest
  await saveProfiles($)
  // The folder keeps what the profile had on and off; it just isn't tied to a profile now.
  if (activeProfile === name) await setActiveProfile($, cwd, undefined)
  else $.ui.invalidate('ui.render')
}

async function renameProfile(
  $: EngineInterface,
  cwd: string,
  from: string,
  to: string,
): Promise<void> {
  const { [from]: patterns, ...rest } = profiles
  if (patterns === undefined) return
  profiles = { ...rest, [to]: patterns }
  await saveProfiles($)
  if (activeProfile === from) await setActiveProfile($, cwd, to)
  else $.ui.invalidate('ui.render')
}

// Drops the folder's own settings and profile, so the default preset (or nothing) applies.
async function resetFolder($: EngineInterface, cwd: string): Promise<void> {
  await $.store.delete(`preset:${cwd}`)
  const defaults = migratePatterns(stringArray(await $.store.get('preset:default')) ?? [])
  presetCache.set(cwd, defaults)
  activePreset = defaults
  pendingPresetChange = true
  if (activeProfile !== undefined) await setActiveProfile($, cwd, undefined)
  invalidateContext($)
  await refreshStatus($, cwd)
}

async function submitProfileName($: EngineInterface, cwd: string, value: string): Promise<void> {
  const name = value.trim()
  if (profileNameError(name) !== undefined) {
    await update($, profileDraft, () => value)
    return
  }
  await saveProfile($, cwd, findProfile(profiles, name) ?? name)
  await update($, profileNaming, () => false)
  await update($, profileDraft, () => '')
}

async function setItemsVisibility(
  $: EngineInterface,
  cwd: string,
  ids: readonly string[],
  show: boolean,
): Promise<void> {
  if (ids.length === 0) return
  const catalog = await loadCatalog($, cwd)
  const hidden = await loadHidden($, cwd)
  const next = show
    ? showFromPreset(hidden, ids, catalog.map(item => item.id))
    : migratePatterns([...hidden, ...ids])
  await saveFolderPreset($, cwd, next)
  showApplyToast($)
}

async function toggleItem($: EngineInterface, cwd: string, id: string): Promise<void> {
  const catalog = await loadCatalog($, cwd)
  const item = catalog.find(candidate => candidate.id === id)
  if (item === undefined) return
  if (item.tab === 'tools') {
    await toggleTool($, cwd, item)
    return
  }
  if (!isToggleable(item)) return
  const hidden = await loadHidden($, cwd)
  await setItemsVisibility($, cwd, [id], isHidden(id, hidden))
}

function toolName(item: CatalogItem): string {
  return item.id.startsWith('tool:') ? item.id.slice('tool:'.length) : item.id
}

async function setToolState(
  $: EngineInterface,
  cwd: string,
  item: CatalogItem,
  state: ToolState,
): Promise<void> {
  const name = toolName(item)
  const hidden = await loadHidden($, cwd)
  let next = withoutMatchingToolBlocks(hidden, name).filter(pattern => pattern !== item.id)
  if (state === 'demand' && item.eager === true) next.push(item.id)
  if (state === 'blocked') next.push(`block:${name}`)
  await saveFolderPreset($, cwd, next)
  showApplyToast($)
}

async function toggleTool(
  $: EngineInterface,
  cwd: string,
  item: CatalogItem,
): Promise<void> {
  const hidden = await loadHidden($, cwd)
  const state = toolState(item, hidden)
  const next = item.eager === true
    ? state === 'sent'
      ? 'demand'
      : state === 'demand'
        ? 'blocked'
        : 'sent'
    : state === 'blocked' ? 'demand' : 'blocked'
  await setToolState($, cwd, item, next)
}

async function toggleToolGroup(
  $: EngineInterface,
  cwd: string,
  items: readonly CatalogItem[],
  mode: 'eager' | 'deferred',
): Promise<void> {
  if (items.length === 0) return
  const hidden = await loadHidden($, cwd)
  const states = items.map(item => toolState(item, hidden))
  const allBlocked = states.every(state => state === 'blocked')
  const allSent = states.every(state => state === 'sent')
  let next = [...hidden]
  for (const item of items) {
    next = withoutMatchingToolBlocks(next, toolName(item)).filter(pattern => pattern !== item.id)
  }

  if (allBlocked) {
    if (mode === 'eager') {
      // Clearing both kinds of rule returns eager tools to Sent.
    }
  } else if (mode === 'eager' && allSent) {
    next.push(...items.map(item => item.id))
  } else {
    const server = items[0]?.server
    if (server === undefined) next.push(...items.map(item => `block:${toolName(item)}`))
    else next.push(`block:mcp__${server}__*`)
  }

  await saveFolderPreset($, cwd, next)
  showApplyToast($)
}

async function setToolsBlocked(
  $: EngineInterface,
  cwd: string,
  items: readonly CatalogItem[],
  blocked: boolean,
): Promise<void> {
  let next = await loadHidden($, cwd)
  for (const item of items) {
    const name = toolName(item)
    next = withoutMatchingToolBlocks(next, name)
    if (blocked) next.push(`block:${name}`)
  }
  await saveFolderPreset($, cwd, next)
  showApplyToast($)
}

// Blocks or unblocks a whole tool group. An MCP server is blocked by one wildcard, so tools
// it adds later are blocked too; unblocking keeps each tool's Sent or On demand choice.
async function setGroupBlocked(
  $: EngineInterface,
  cwd: string,
  items: readonly CatalogItem[],
  blocked: boolean,
): Promise<void> {
  const server = items[0]?.server
  if (!blocked || server === undefined) {
    await setToolsBlocked($, cwd, items, blocked)
    return
  }
  let next = await loadHidden($, cwd)
  for (const item of items) next = withoutMatchingToolBlocks(next, toolName(item))
  next.push(`block:mcp__${server}__*`)
  await saveFolderPreset($, cwd, next)
  showApplyToast($)
}

async function toggleItems(
  $: EngineInterface,
  cwd: string,
  ids: readonly string[],
): Promise<void> {
  const hidden = await loadHidden($, cwd)
  const allHidden = ids.length > 0 && ids.every(id => isHidden(id, hidden))
  await setItemsVisibility($, cwd, ids, allHidden)
}

async function setActiveTab($: EngineInterface, value: CatalogTab): Promise<void> {
  await update($, activeTab, () => value)
  await update($, page, () => 0)
}

async function setFilter($: EngineInterface, value: string): Promise<void> {
  await update($, filter, () => value)
  await update($, page, () => 0)
}

async function setPage($: EngineInterface, value: number): Promise<void> {
  await update($, page, () => Math.max(0, Math.floor(value)))
}

async function toggleExpandedToolGroup($: EngineInterface, key: string): Promise<void> {
  await update($, expandedToolGroups, current =>
    current.includes(key)
      ? current.filter(candidate => candidate !== key)
      : [...current, key],
  )
  await update($, page, () => 0)
}

async function openPane($: EngineInterface, refresh = true) {
  if (refresh) await refreshAvailableCatalog($, await cwdForSession($))
  const opened = await $.ui.open({ id: PANE, title: 'Context' })
  void refreshEngineCounts($, true)
  return opened
}

function catalogItemFromParsed(item: ParsedTextItem, tab: CatalogTab): CatalogItem {
  return {
    id: item.id,
    tab,
    label: item.label,
    description: item.description,
    tokens: estimateTokens(item.text),
  }
}

function itemMatches(item: CatalogItem, query: string): boolean {
  if (query === '') return true
  return item.label.toLowerCase().includes(query) ||
    item.description.toLowerCase().includes(query) ||
    item.id.toLowerCase().includes(query) ||
    (item.server?.toLowerCase().includes(query) ?? false)
}

function sumTokens(items: readonly CatalogItem[]): number {
  return items.reduce((sum, item) => sum + item.tokens, 0)
}

function sortedItems(items: readonly CatalogItem[]): CatalogItem[] {
  return [...items].sort(
    (left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label),
  )
}

function groupedBy(
  items: readonly CatalogItem[],
  groupFor: (item: CatalogItem) => string,
): Array<{ key: string; label: string; items: CatalogItem[] }> {
  const byKey = new Map<string, CatalogItem[]>()
  for (const item of items) {
    const key = groupFor(item)
    byKey.set(key, [...(byKey.get(key) ?? []), item])
  }
  return [...byKey.entries()].map(([key, members]) => ({
    key,
    label: key,
    items: sortedItems(members),
  }))
}

function toolGroups(
  items: readonly CatalogItem[],
): Array<{ key: string; label: string; items: CatalogItem[] }> {
  const groups = groupedBy(items, item => item.server ?? 'Built-in').map(group => ({
    ...group,
    label: group.key === 'Built-in'
      ? 'Built-in'
      : serverLabel(group.key, group.items.map(item => item.label)),
  }))
  return groups.sort((left, right) => {
    if (left.key === 'Built-in') return -1
    if (right.key === 'Built-in') return 1
    return sumTokens(right.items) - sumTokens(left.items) || left.label.localeCompare(right.label)
  })
}

function genericGroups(
  items: readonly CatalogItem[],
  tab: Exclude<CatalogTab, 'tools'>,
): Array<{ key: string; label: string; items: CatalogItem[] }> {
  if (tab === 'skills') {
    return groupedBy(items, skillNamespace).sort(
      (left, right) => sumTokens(right.items) - sumTokens(left.items) ||
        left.label.localeCompare(right.label),
    )
  }
  if (tab === 'files') {
    const order: string[] = ['Instruction files', 'Memory']
    return groupedBy(items, item => item.id.startsWith('file:')
      ? 'Instruction files'
      : 'Memory')
      .sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key))
  }
  const order: string[] = ['MCP server docs', 'Hook output', 'Subagents', 'Other']
  return groupedBy(items, item => {
    if (item.id.startsWith('mcpdoc:')) return 'MCP server docs'
    if (item.id === 'hook:context') return 'Hook output'
    if (item.id === 'attachment:agent_listing_delta') return 'Subagents'
    return 'Other'
  }).sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key))
}

function emptyMessage(tab: CatalogTab, hasItemsInTab: boolean, query: string): string {
  if (hasItemsInTab && query !== '') return 'No matches.'
  if (tab === 'other') {
    return 'Nothing here yet in this session. MCP instructions and hook output show up on your next message.'
  }
  return 'Nothing here yet.'
}

function rowsForTab(
  catalog: readonly CatalogItem[],
  tab: CatalogTab,
  query: string,
  expanded: readonly string[] = [],
): PaneRow[] {
  const tabItems = catalog.filter(item => item.tab === tab)
  const filtered = tabItems.filter(item => itemMatches(item, query))
  if (filtered.length === 0) {
    return [{
      kind: 'empty',
      key: `empty:${tab}`,
      text: emptyMessage(tab, tabItems.length > 0, query),
    }]
  }

  const rows: PaneRow[] = []
  if (tab !== 'tools') {
    for (const group of genericGroups(filtered, tab)) {
      rows.push({ ...group, kind: 'group', key: `group:${tab}:${group.key}`, mode: 'generic' })
      for (const item of group.items) {
        rows.push({ kind: 'item', key: `item:${item.id}`, item })
      }
    }
    return rows
  }

  const eager = filtered.filter(item => item.eager === true)
  if (eager.length > 0) {
    rows.push({
      kind: 'section',
      key: 'section:sent',
      label: 'Sent with every message',
    })
    for (const group of toolGroups(eager)) {
      rows.push({
        ...group,
        kind: 'group',
        key: `group:tool:eager:${group.key}`,
        mode: 'eager',
      })
      for (const item of group.items) {
        rows.push({ kind: 'item', key: `item:${item.id}`, item })
      }
    }
  }

  const deferred = filtered.filter(item => item.eager !== true)
  if (deferred.length > 0) {
    rows.push({
      kind: 'section',
      key: 'section:demand',
      label: 'On demand',
    })
    for (const group of toolGroups(deferred)) {
      const groupKey = `group:tool:deferred:${group.key}`
      const isExpanded = query !== '' || expanded.includes(group.key)
      rows.push({
        kind: 'group',
        key: groupKey,
        label: group.label,
        items: group.items,
        mode: 'deferred',
        expanded: isExpanded,
      })
      if (isExpanded) {
        for (const item of group.items) {
          rows.push({ kind: 'item', key: `item:${item.id}`, item })
        }
      }
    }
  }
  return rows
}

function groupState(
  items: readonly CatalogItem[],
  hidden: readonly string[],
  mode: GroupRow['mode'],
): string {
  if (mode !== 'generic') {
    const states = items.map(item => toolState(item, hidden))
    if (states.every(state => state === 'blocked')) return 'Blocked'
    if (mode === 'deferred' && states.every(state => state !== 'blocked')) return 'Available'
    if (mode === 'eager' && states.every(state => state === 'sent')) return 'Sent'
    if (mode === 'eager' && states.every(state => state === 'demand')) return 'On demand'
    return 'Mixed'
  }
  const hiddenCount = items.filter(item => isHidden(item.id, hidden)).length
  if (hiddenCount === 0) return 'On'
  if (hiddenCount === items.length) return 'Off'
  return 'Mixed'
}

function truncateEnd(value: string, width: number): string {
  const available = Math.max(0, Math.floor(width))
  if (value.length <= available) return value
  if (available === 0) return ''
  if (available === 1) return '…'
  return `${value.slice(0, available - 1)}…`
}

function rowName(row: PaneRow): string {
  if (row.kind === 'item') return row.item.label
  if (row.kind === 'section' || row.kind === 'group') {
    return row.label
  }
  return ''
}

function tabLabels(
  totals: ReturnType<typeof tabTotals>,
): Record<CatalogTab, string> {
  return Object.fromEntries(
    TAB_ORDER.map(tab => [tab, `${TAB_LABELS[tab]} ${formatTokens(totals[tab].sentTokens)}`]),
  ) as Record<CatalogTab, string>
}

function wrappedTabRows(
  labels: Readonly<Record<CatalogTab, string>>,
  width: number,
  extraLabels: readonly string[] = [],
): number {
  let rows = 1
  let used = 0
  for (const label of [...TAB_ORDER.map(tab => labels[tab]), ...extraLabels]) {
    const itemWidth = Math.min(width, label.length + 6)
    const nextWidth = used === 0 ? itemWidth : used + 2 + itemWidth
    if (used > 0 && nextWidth > width) {
      rows += 1
      used = itemWidth
    } else {
      used = nextWidth
    }
  }
  return rows
}

// Rows a wrapping line of buttons takes, each counted as `[ label ]`.
function wrappedChipRows(labels: readonly string[], width: number, gap: number): number {
  let rows = 1
  let used = 0
  for (const label of labels) {
    const itemWidth = Math.min(width, label.length + 4)
    const nextWidth = used === 0 ? itemWidth : used + gap + itemWidth
    if (used > 0 && nextWidth > width) {
      rows += 1
      used = itemWidth
    } else {
      used = nextWidth
    }
  }
  return rows
}

function paneRowHeight(row: PaneRow, compact: boolean): number {
  if (compact) return 1
  if (row.kind === 'item') return 3
  if (row.kind === 'group') return 5
  if (row.kind === 'section') return 3
  return 1
}

function searchPlaceholder(tab: CatalogTab): string {
  return `Search ${TAB_LABELS[tab].toLowerCase()}…`
}

function toolStateMark(state: ToolState): string {
  if (state === 'sent') return '●'
  if (state === 'demand') return '◐'
  return '✕'
}

// /ctx output reaches the person as a log line, which surfaces cut (2,000 characters in a
// terminal, 10,000 elsewhere): totals go first, and on-demand tools are listed per server.
function summaryLines(summary: ContextSummary): string[] {
  const parts = TAB_ORDER.map(tab => `${TAB_LABELS[tab]} ${formatTokens(summary.totals[tab].sentTokens)}`)
  if (summary.fromEngine) parts.push(`fixed ${formatTokens(summary.fixed)}`)
  return [
    `Sending ~${formatTokens(summary.total)} with every message: ${parts.join(', ')}.`,
    summary.saved === 0 ? 'Hiding nothing.' : `Hiding ~${formatTokens(summary.saved)}.`,
    '',
  ]
}

function onDemandServerLines(items: readonly CatalogItem[], hidden: readonly string[]): string[] {
  return toolGroups(items).map(group =>
    `    ${group.label}, ${group.items.length} tools (${groupState(group.items, hidden, 'deferred').toLowerCase()})`)
}

function listForCatalog(
  catalog: readonly CatalogItem[],
  hidden: readonly string[],
  summary: ContextSummary,
): string {
  const lines: string[] = summaryLines(summary)
  for (const tab of TAB_ORDER) {
    lines.push(TAB_LABELS[tab])
    const items = catalog.filter(item => item.tab === tab)
    if (items.length === 0) {
      lines.push('  (none)')
      continue
    }
    if (tab === 'tools') {
      const eager = items.filter(item => item.eager === true)
      const deferred = items.filter(item => item.eager !== true)
      lines.push('  Sent with every message')
      for (const group of toolGroups(eager)) {
        lines.push(`    ${group.label}, ${group.items.length} tools, ~${formatTokens(sumTokens(group.items))}`)
        for (const item of group.items) {
          lines.push(`      ${toolStateMark(toolState(item, hidden))} ${item.id}  ~${formatTokens(item.tokens)}`)
        }
      }
      lines.push('  On demand')
      lines.push(...onDemandServerLines(deferred, hidden))
      continue
    }
    for (const group of genericGroups(items, tab)) {
      lines.push(`  ${group.label}, ${group.items.length} items, ~${formatTokens(sumTokens(group.items))}`)
      for (const item of group.items) {
        lines.push(`    ${isHidden(item.id, hidden) ? '○' : '●'} ${item.id}  ~${formatTokens(item.tokens)}`)
      }
    }
  }
  return lines.join('\n')
}

function listEagerTools(catalog: readonly CatalogItem[], hidden: readonly string[]): string {
  const tools = catalog.filter(item => item.tab === 'tools')
  if (tools.length === 0) return 'No tools have been discovered yet.'
  const eager = tools.filter(item => item.eager === true)
  const lines: string[] = ['Sent with every message']
  if (eager.length === 0) lines.push('  (none)')
  for (const item of sortedItems(eager)) {
    lines.push(`${toolStateMark(toolState(item, hidden))} ${item.id}  ~${formatTokens(item.tokens)}`)
  }
  lines.push('On demand')
  lines.push(...onDemandServerLines(tools.filter(item => item.eager !== true), hidden))
  return lines.join('\n')
}

const HELP = `Usage:
/ctx                         open the Context pane
/ctx list                    list catalog items grouped by tab
/ctx tools                   list eager tools worth deferring
/ctx profile                 list profiles
/ctx profile <name>          use a profile in this folder
/ctx profile save <name>     save what's on and off here as a profile
/ctx profile rename <a> <b>  rename a profile
/ctx profile delete <name>   delete a profile
/ctx profile none            stop using a profile here
/ctx hide <id-or-pattern>    hide items from the next message
/ctx show <id-or-pattern>    include items from the next message
/ctx only <pattern> [...]    hide catalog items except matches
/ctx block <tool|server>     block a tool or MCP server in this folder
/ctx unblock <tool|server>   unblock a tool or MCP server in this folder
/ctx reset                   remove this folder preset
/ctx save-default            copy this folder preset to the default
/ctx help                    show this help

Only a trailing * is a wildcard. Server block patterns look like mcp__<server>__*.`

type BlockTarget = {
  pattern: string
  label: string
  toolCount: number
  isServer: boolean
  tool?: string
}

function resolveBlockTarget(
  requested: string,
  catalog: readonly CatalogItem[],
): BlockTarget {
  const tools = catalog.filter(item => item.tab === 'tools')
  const exactTool = tools.find(item => toolName(item).toLowerCase() === requested.toLowerCase())
  if (exactTool !== undefined) {
    const name = toolName(exactTool)
    return { pattern: `block:${name}`, label: name, toolCount: 1, isServer: false, tool: name }
  }

  const groups = toolGroups(tools.filter(item => item.server !== undefined))
  const requestedServer = /^mcp__(.+)__\*$/.exec(requested)?.[1]
  const group = groups.find(candidate =>
    candidate.label.toLowerCase() === requested.toLowerCase() ||
    candidate.key.toLowerCase() === requested.toLowerCase() ||
    (requestedServer !== undefined && candidate.key.toLowerCase() === requestedServer.toLowerCase()),
  )
  if (group !== undefined) {
    return {
      pattern: `block:mcp__${group.key}__*`,
      label: group.label,
      toolCount: group.items.length,
      isServer: true,
    }
  }

  if (requestedServer !== undefined) {
    return {
      pattern: `block:${requested}`,
      label: serverLabel(requestedServer, []),
      toolCount: 0,
      isServer: true,
    }
  }
  return {
    pattern: `block:${requested}`,
    label: requested,
    toolCount: 1,
    isServer: false,
    tool: requested,
  }
}

function blockCommandMessage(verb: 'Blocked' | 'Unblocked', target: BlockTarget): string {
  const count = target.isServer
    ? ` (${target.toolCount} tool${target.toolCount === 1 ? '' : 's'})`
    : ''
  return `${verb} ${target.label}${count} in this folder. Applies from your next message.`
}

async function handleCommand(
  $: EngineInterface,
  argsText: string,
): Promise<{ text: string }> {
  const cwd = await cwdForSession($)
  const args = splitArguments(argsText)
  const subcommand = args[0]

  if (subcommand === undefined) {
    const opened = await openPane($)
    if (!opened.isPlaced) log($, `ctx-control: ${opened.reason}`)
    return { text: 'Context pane opened.' }
  }
  if (subcommand === 'help') return { text: HELP }

  if (subcommand === 'profile' || subcommand === 'profiles') {
    return { text: await handleProfileCommand($, cwd, args.slice(1)) }
  }

  if (subcommand === 'list' || subcommand === 'tools') await refreshEngineCounts($, true)
  const { catalog, hidden, summary } = await summaryFor($, cwd)
  const catalogIds = catalog.map(item => item.id)

  if (subcommand === 'list') return { text: listForCatalog(catalog, hidden, summary) }
  if (subcommand === 'tools') return { text: listEagerTools(catalog, hidden) }

  if (subcommand === 'block' || subcommand === 'unblock') {
    const requested = args.slice(1).join(' ').trim()
    if (requested === '') return { text: `Usage: /ctx ${subcommand} <tool|server>` }
    const target = resolveBlockTarget(requested, catalog)
    const next = subcommand === 'block'
      ? migratePatterns([...hidden, target.pattern])
      : target.tool === undefined
        ? hidden.filter(pattern => pattern !== target.pattern)
        : withoutMatchingToolBlocks(hidden, target.tool)
    await saveFolderPreset($, cwd, next)
    showApplyToast($)
    return {
      text: blockCommandMessage(subcommand === 'block' ? 'Blocked' : 'Unblocked', target),
    }
  }

  if (subcommand === 'hide' || subcommand === 'show' || subcommand === 'only') {
    const requested = normalizePatterns(args.slice(1))
    if (requested.length === 0) {
      return { text: `Usage: /ctx ${subcommand} <id-or-pattern> [...]` }
    }

    let next: string[]
    if (subcommand === 'hide') {
      next = migratePatterns([...hidden, ...requested])
    } else if (subcommand === 'show') {
      next = showFromPreset(hidden, requested, catalogIds)
    } else {
      next = catalog
        .filter(isToggleable)
        .filter(item => !requested.some(pattern => isHidden(item.id, [pattern])))
        .map(item => item.id)
    }

    await saveFolderPreset($, cwd, next)
    const affected = subcommand === 'only'
      ? catalog.filter(item => isToggleable(item) && isHidden(item.id, next))
      : catalog.filter(item => {
        if (!isToggleable(item)) return false
        const wasHidden = isHidden(item.id, hidden)
        const isNowHidden = isHidden(item.id, next)
        return subcommand === 'hide'
          ? !wasHidden && isNowHidden
          : wasHidden && !isNowHidden
      })
    const affectedTokens = sumTokens(affected)
    const verb = subcommand === 'show' ? 'showing' : 'hiding'
    return {
      text: `Now ${verb} ${affected.length} item(s) (~${formatTokens(affectedTokens)}); applies from the next message.`,
    }
  }

  if (subcommand === 'reset') {
    await resetFolder($, cwd)
    return { text: 'Removed the folder preset; the default now applies from the next message.' }
  }

  if (subcommand === 'save-default') {
    const folder = migratePatterns(stringArray(await $.store.get(`preset:${cwd}`)) ?? hidden)
    await trySet($, 'preset:default', folder)
    invalidateContext($)
    await refreshStatus($, cwd)
    return { text: `Saved ${folder.length} entry/entries as the default; applies from the next message.` }
  }

  return { text: HELP }
}

function listProfiles(hidden: readonly string[]): string {
  const names = profileNames(profiles)
  if (names.length === 0) {
    return 'No profiles yet. Set things on and off, then /ctx profile save <name>.'
  }
  const lines = names.map(name => {
    const marker = name === activeProfile
      ? presetDiffers(profiles[name] ?? [], hidden) ? ' (in use, changed)' : ' (in use)'
      : ''
    return `  ${name}, ${profiles[name]?.length ?? 0} rule(s)${marker}`
  })
  return ['Profiles:', ...lines].join('\n')
}

async function handleProfileCommand(
  $: EngineInterface,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const [action, ...rest] = args
  const hidden = await loadHidden($, cwd)
  if (action === undefined) return listProfiles(hidden)

  const verb = action.toLowerCase()
  if (verb === 'none') {
    await resetFolder($, cwd)
    return 'Stopped using a profile here; the default applies from the next message.'
  }
  if (verb === 'save') {
    const name = rest.join(' ').trim()
    const error = profileNameError(name)
    if (error !== undefined) return `${error} Usage: /ctx profile save <name>`
    const existing = findProfile(profiles, name)
    await saveProfile($, cwd, existing ?? name)
    return `${existing === undefined ? 'Saved' : 'Updated'} profile ${existing ?? name} (${hidden.length} rule(s)); this folder uses it.`
  }
  if (verb === 'delete') {
    const name = findProfile(profiles, rest.join(' ').trim())
    if (name === undefined) return `No such profile. ${listProfiles(hidden)}`
    await deleteProfile($, cwd, name)
    return `Deleted profile ${name}. This folder keeps its current settings.`
  }
  if (verb === 'rename') {
    const [fromText, toText] = rest
    const from = fromText === undefined ? undefined : findProfile(profiles, fromText)
    if (from === undefined || toText === undefined) {
      return 'Usage: /ctx profile rename <name> <new-name> (quote names with spaces)'
    }
    const error = profileNameError(toText)
    if (error !== undefined) return error
    const clash = findProfile(profiles, toText)
    if (clash !== undefined && clash !== from) return `A profile named ${clash} already exists.`
    await renameProfile($, cwd, from, toText)
    return `Renamed ${from} to ${toText}.`
  }

  const name = findProfile(profiles, args.join(' ').trim())
  if (name === undefined) return `No such profile. ${listProfiles(hidden)}`
  await useProfile($, cwd, name)
  return `Using profile ${name} in this folder; applies from the next message.`
}

function serverPatternBlocks(server: string, patterns: readonly string[]): boolean {
  const probe = `mcp__${server}__ctx_control_probe`
  return patterns.some(pattern => isServerBlockPattern(pattern) &&
    isToolBlocked(probe, [pattern]))
}

function filterAttachment(
  type: string,
  text: string,
  patterns: readonly string[],
): string | null {
  if (type === 'skill_listing') return filterSkillListing(text, patterns)
  if (type === 'deferred_tools_delta') return filterDeferredToolNames(text, patterns)
  if (type === 'hook_additional_context') {
    return isHidden('hook:context', patterns) ? null : text
  }
  if (type === 'agent_listing_delta') {
    return isHidden('attachment:agent_listing_delta', patterns) ? null : text
  }
  if (type === 'mcp_instructions_delta') {
    const servers = [...knownMcpServers]
    const items = parseMcpInstructions(text, servers)
    const blockedDocIds = items.flatMap(item => {
      const raw = item.id.slice('mcpdoc:'.length)
      const server = servers.find(candidate =>
        normalizeMcpServerName(candidate) === normalizeMcpServerName(raw) ||
        serverLabel(candidate, []).toLowerCase() === item.label.toLowerCase(),
      )
      return server !== undefined && serverPatternBlocks(server, patterns) ? [item.id] : []
    })
    return filterMcpInstructions(text, [...patterns, ...blockedDocIds], servers)
  }
  return text
}

function describeAnswer<T extends { description: string; isDeferred?: boolean }>(
  tool: string,
  result: T,
  patterns: readonly string[],
): T {
  const hidden = isHidden(`tool:${tool}`, patterns)
  return hidden || isToolBlocked(tool, patterns)
    ? { ...result, isDeferred: true }
    : result
}

function filterToolSearchResult(
  result: ToolCallResult<'ToolSearch'>,
  patterns: readonly string[],
): ToolCallResult<'ToolSearch'> {
  if (result.isError === true || result.deny !== undefined) return result
  const found = result.result
  const matches = found.matches.filter(name => !isToolBlocked(name, patterns))
  const removed = found.matches.filter(name => isToolBlocked(name, patterns))
  if (removed.length === 0) return result
  return {
    result: { ...found, matches },
    context: [
      ...(result.context ?? []),
      `ctx-control blocked these tools in this folder: ${removed.join(', ')}. Do not try to use them; the user can unblock them with /ctx.`,
    ],
  }
}

const BLOCK_REASON = 'Blocked in this folder by ctx-control. The user can unblock it with /ctx.'
const PANEL_NOTE = "Claude Code's Context panel still counts hidden items. It can't see what mods remove."

function tokensPhrase(item: CatalogItem): string {
  const count = `${formatCount(item.tokens)} token${item.tokens === 1 ? '' : 's'}`
  return item.approximate === true ? `About ${count}` : count
}

/** The last line of an item's hover card: what it costs and where it stands. */
function itemCardMeta(item: CatalogItem, hidden: readonly string[]): string {
  if (item.stale === true) return 'Seen in an earlier session, not this one, so not counted.'
  if (item.tab === 'tools') {
    const state = toolState(item, hidden)
    if (state === 'blocked') return "Blocked: Claude can't search for it or call it."
    if (item.eager !== true) return 'On demand: only its name is sent until Claude loads it.'
    return state === 'demand'
      ? `${tokensPhrase(item)}, moved to on demand so they're not sent.`
      : `${tokensPhrase(item)}, sent with every message.`
  }
  return isHidden(item.id, hidden)
    ? `${tokensPhrase(item)}, hidden from your messages.`
    : `${tokensPhrase(item)}, sent with every message.`
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    activeCwd = e.cwd
    applyToastShown = false
    pendingPresetChange = false
    confirmedSkillsByCwd.delete(e.cwd)
    knownMcpServers.clear()
    confirmedOther.clear()
    engineCounts = undefined
    engineCountsAt = 0
    trailingRefresh?.cancel()
    trailingRefresh = undefined
    // First, so /ctx exists even if anything below fails.
    await $.command.register({
      name: 'ctx',
      description: 'Show, hide, defer, or block context and tools for this folder',
      argumentHint: '[list|tools|profile|hide|show|only|block|unblock|reset|save-default|help]',
    })
    const home = await loadHome($)
    await migrateStore($, home)
    await loadToolRegistry($)
    catalogCache.set(e.cwd, [...rememberedOtherItems])
    const folderPreset = await $.store.get(`preset:${e.cwd}`)
    await loadPresetAtSessionStart($, e.cwd)
    await loadProfiles($, e.cwd)
    await loadServerNameHints($)
    await refreshAvailableCatalog($, e.cwd)
    // In the background: counting takes a few seconds and the pane redraws when it lands. MCP
    // servers keep connecting for a while after start, so read again once they've settled.
    void refreshEngineCounts($, true)
    try {
      $.clock.after(10_000, () => { void refreshEngineCounts($, true) })
    } catch (error) {
      log($, `ctx-control: could not schedule a context recount: ${errorMessage(error)}`, true)
    }
    await refreshStatus($, e.cwd)

    const hasFolderPreset = folderPreset !== undefined
    const canShow = e.isInteractive || e.surface !== null
    if (canShow && (!hasFolderPreset || options.openOnStart === true)) {
      await openPane($, false)
    }
    return next(e)
  })

  // /ctx is also declared in commands/, so the desktop app lists it as `/ctx-control:ctx` before
  // any session exists (its empty New session screen); this hook answers both spellings.
  on('command.run', { command: ['ctx', 'ctx-control:ctx'] }, async ($, e) => {
    try {
      const result = await handleCommand($, e.args)
      log($, result.text)
      ctxRowsToBlank = 3
      return { text: '' }
    } catch (error) {
      ctxRowsToBlank = 0
      log($, `ctx-control: ${errorMessage(error)}`)
      return { text: '' }
    }
  }).catch(($, _e, next) => {
    ctxRowsToBlank = 0
    log($, `ctx-control: ${next.error.message}`)
    return { text: '' }
  })

  // /ctx is a control surface, not conversation: keep its rows out of what the model reads.
  // The engine never lets a hook refuse its own rows, but an emptied row is stored as "(no content)".
  on('session.append', { door: 'command' }, async ($, e, next) => {
    if (!isCtxCommandRow(e.message.content)) return next(e)
    return next({ ...e, message: { ...e.message, content: [] } })
  }).catch(($, e, next) => ctxRowsToBlank > 0
    ? next({ ...e, message: { ...e.message, content: [] } })
    : next(e))

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const patterns = activePreset
    const files = result.instructionFiles ?? e.instructionFiles
    if (files === undefined) return result
    const answer = {
      ...result,
      instructionFiles: files.filter(file => !isHidden(`file:${file.path}`, patterns)),
    }
    try {
      if (pendingPresetChange) {
        pendingPresetChange = false
        $.ui.invalidate('ui.render')
      }
      await mergeCatalog(
        $,
        activeCwd,
        files.map(file => ({
          id: `file:${file.path}`,
          tab: 'files',
          label: abbreviateHome(file.path, homeDir),
          description: file.kind,
          kind: file.kind,
          tokens: estimateTokens(file.content),
        })),
      )
      await refreshStatus($, activeCwd)
    } catch (error) {
      log($, `ctx-control: prompt.context catalog update failed: ${errorMessage(error)}`, true)
    }
    return answer
  }).catch(async (_$, e, next) => {
    const result = await next(e)
    const files = result.instructionFiles ?? e.instructionFiles
    return files === undefined ? result : {
      ...result,
      instructionFiles: files.filter(file => !isHidden(`file:${file.path}`, activePreset)),
    }
  })

  on('prompt.section', { name: 'memory' }, async ($, e, next) => {
    const result = await next(e)
    const answer = isHidden('section:memory', activePreset) ? { text: null } : result
    try {
      if (result.text !== null) {
        await mergeCatalog($, activeCwd, [{
          id: 'section:memory',
          tab: 'files',
          label: 'Memory index',
          description: 'Memory section',
          tokens: estimateTokens(result.text),
        }])
      }
      await refreshStatus($, activeCwd)
    } catch (error) {
      log($, `ctx-control: prompt.section catalog update failed: ${errorMessage(error)}`, true)
    }
    return answer
  }).catch(async (_$, e, next) => {
    const result = await next(e)
    return isHidden('section:memory', activePreset) ? { text: null } : result
  })

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e)
    if (result.text === null) return result
    const answer = { text: filterAttachment(e.type, result.text, activePreset) }

    try {
      if (e.type === 'skill_listing') {
        const items = parseSkillListing(result.text)
        await rememberSkills($, items.map(item => item.label))
        await replaceCatalogTab(
          $,
          activeCwd,
          'skills',
          items.map(item => catalogItemFromParsed(item, 'skills')),
        )
        skillFallbackByCwd.set(activeCwd, false)
        confirmedSkillsByCwd.add(activeCwd)
      } else if (e.type === 'mcp_instructions_delta') {
        const items = parseMcpInstructions(result.text, [...knownMcpServers])
        for (const item of items) confirmedOther.add(item.id)
        await saveServerNameHints($, items)
        await mergeCatalog($, activeCwd, items.map(item => catalogItemFromParsed(item, 'other')))
      } else if (e.type === 'hook_additional_context') {
        confirmedOther.add('hook:context')
        await mergeCatalog($, activeCwd, [{
          id: 'hook:context',
          tab: 'other',
          label: 'SessionStart hook output',
          description: 'Hook-added context',
          tokens: estimateTokens(result.text),
        }])
      } else if (e.type === 'agent_listing_delta') {
        confirmedOther.add('attachment:agent_listing_delta')
        await mergeCatalog($, activeCwd, [{
          id: 'attachment:agent_listing_delta',
          tab: 'other',
          label: 'Subagent type list',
          description: 'Available subagent types',
          tokens: estimateTokens(result.text),
        }])
      }
      await refreshStatus($, activeCwd)
    } catch (error) {
      log($, `ctx-control: prompt.attachment catalog update failed: ${errorMessage(error)}`, true)
    }
    return answer
  }).catch(async (_$, e, next) => {
    const result = await next(e)
    return result.text === null
      ? result
      : { text: filterAttachment(e.type, result.text, activePreset) }
  })

  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    const answer = describeAnswer(e.tool, result, activePreset)
    const item = createToolCatalogItem(e.tool, result.description, result.isDeferred)
    try {
      const server = parseMcpToolServer(e.tool)
      if (server !== undefined) knownMcpServers.add(server)
      await recordToolEagerness($, e.tool, item.eager === true)
      await mergeCatalog($, activeCwd, [item])
      await refreshStatus($, activeCwd)
    } catch (error) {
      log($, `ctx-control: tool.describe catalog update failed: ${errorMessage(error)}`, true)
    }
    return answer
  }).catch(async (_$, e, next) => describeAnswer(e.tool, await next(e), activePreset))

  on('tool.check', async (_$, e, next) => {
    const blocked = isToolBlocked(e.tool, activePreset)
    if (blocked) return { decision: 'deny', reason: BLOCK_REASON }
    return next(e)
  }).catch((_$, e, next) => isToolBlocked(e.tool, activePreset)
    ? { decision: 'deny', reason: BLOCK_REASON }
    : next(e))

  on('tool.call', { tool: 'ToolSearch' }, async (_$, e, next) =>
    filterToolSearchResult(await next(e), activePreset),
  // Never refuse the search itself: that would cut off every on-demand tool, not just blocked ones.
  ).catch(async (_$, e, next) => filterToolSearchResult(await next(e), activePreset))

  // After each turn the context moved: re-read Claude Code's breakdown (throttled, best effort).
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) await refreshEngineCounts($)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (
      e.surface !== 'terminal' &&
      e.surface !== 'desktop' &&
      e.surface !== 'vscode' &&
      e.surface !== 'mobile'
    ) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const cwd = await cwdForSession($)
    const { catalog, hidden, summary } = await summaryFor($, cwd)
    if (engineCounts === undefined) void refreshEngineCounts($)
    const selectedTab = await read($, activeTab)
    const filterValue = await read($, filter)
    const query = filterValue.trim().toLowerCase()
    const requestedPage = await read($, page)
    const expandedGroups = await read($, expandedToolGroups)
    const { totals, saved } = summary
    const sent = summary.total
    const bodyColumns = Math.max(1, Math.floor(e.props.bodyColumns))
    const compact = e.surface === 'terminal'
    const canHover = e.surface !== 'mobile'
    const padX = compact ? 1 : 2
    const contentColumns = Math.max(1, bodyColumns - padX * 2)
    const folder = folderLabel(cwd, homeDir)
    const labels = tabLabels(totals)
    const showFixed = summary.fromEngine && summary.fixed > 0
    const fixedLabel = `Fixed ${formatTokens(summary.fixed)}`
    const tabRowCount = wrappedTabRows(labels, contentColumns, showFixed ? [fixedLabel] : [])
    const fallbackCaption = selectedTab === 'skills' && skillFallbackByCwd.get(cwd) === true
    // Claude Code's own Context panel can't see what a mod removes, so say why the two differ.
    const showPanelNote = summary.fromEngine && saved > 0
    const panelNoteRows = !showPanelNote ? 0 : compact ? 1 : 1 + wrappedLineCount(PANEL_NOTE, contentColumns)
    const rows = rowsForTab(catalog, selectedTab, query, expandedGroups)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const names = profileNames(profiles)
    const naming = Input !== undefined && await read($, profileNaming)
    const draft = await read($, profileDraft)
    const deleting = await read($, profileDeleting)
    const profilePatterns = activeProfile === undefined ? undefined : profiles[activeProfile]
    const profileChanged = profilePatterns !== undefined && presetDiffers(profilePatterns, hidden)
    const draftError = draft.trim() === '' ? undefined : profileNameError(draft.trim())
    const profileRowCount = wrappedChipRows(
      ['Profile', 'None', ...names, ...(Input === undefined ? [] : ['+ New'])],
      contentColumns,
      compact ? 2 : 3,
    )
    const showProfileActions = naming || activeProfile !== undefined
    const profileHeaderRows = compact
      ? profileRowCount + (showProfileActions ? 1 : 0)
      : profileRowCount * 2 + (showProfileActions ? 2 : 0)
    const headerRows = profileHeaderRows + (compact
      ? 3 + tabRowCount + (selectedTab === 'tools' ? 1 : 0) + (fallbackCaption ? 1 : 0) + panelNoteRows
      : 1 + 2 + 2 + tabRowCount * 2 + 3 + (selectedTab === 'tools' ? 1 : 0) + (fallbackCaption ? 1 : 0) + 2 + panelNoteRows)
    const fixedRows = headerRows + 1 + (compact ? 0 : 2)
    const paging = paginateHeights(
      rows.map(row => paneRowHeight(row, compact)),
      bodyRows,
      fixedRows,
      requestedPage,
    )
    const shownRows = rows.slice(paging.start, paging.end)
    const filteredItems = catalog
      .filter(item => item.tab === selectedTab && itemMatches(item, query))
    const filteredIds = filteredItems
      .filter(isToggleable)
      .map(item => item.id)
    const allFilteredHidden = filteredIds.length > 0 &&
      filteredIds.every(id => isHidden(id, hidden))
    const allFilteredBlocked = filteredItems.length > 0 &&
      filteredItems.every(item => item.tab === 'tools' && toolState(item, hidden) === 'blocked')
    const longestName = shownRows.reduce(
      (longest, row) => Math.max(longest, rowName(row).length),
      0,
    )
    const itemColumns = compact ? Math.max(1, contentColumns - 2) : contentColumns
    const nameW = Math.min(
      Math.floor(itemColumns * 0.5),
      Math.max(12, longestName + 2),
    )
    const tokenW = 6
    const showDescription = itemColumns - nameW - tokenW - 2 >= 16
    const cells = budgetCells(totals, contentColumns, showFixed ? summary.fixed : 0)

    // Hover cards: hidden until the pointer is over a member of their hover group, painted over
    // the rows without moving them. An absolute Box paints over only what is drawn before it,
    // so every card is drawn last, after the rows and the pager, and joins its row by `scope`.
    // The surface is `inverseText`, the theme's opposite of text and so close to the app's own
    // background in light and dark themes, lifted off the rows by a subtle border. No key of
    // their own: a keyed card would be its own hover scope.
    const cardWidth = Math.max(12, contentColumns - 2)
    // The border takes a row above and below and, with the padding, two columns each side.
    const cardHeight = (card: HoverCard, width: number): number =>
      2 + [card.title, card.body, card.meta].reduce(
        (sum, line) => sum + (line === undefined ? 0 : wrappedLineCount(line, width - 4)),
        0,
      )
    const hoverCard = (
      name: string,
      card: HoverCard,
      place: { top: number; left?: number; width?: number; scope?: string },
    ) => (
      <Box
        position="absolute"
        top={place.top}
        left={place.left ?? 2}
        width={place.width ?? cardWidth}
        display="none"
        hover={place.scope === undefined ? { display: 'flex' } : { scope: place.scope, display: 'flex' }}
        backgroundColor="inverseText"
        borderStyle="round"
        borderColor="subtle"
        paddingX={1}
        flexDirection="column"
      >
        <Text key={`${name}:title`} weight="semibold">{card.title}</Text>
        {card.body !== undefined && <Text key={`${name}:body`}>{card.body}</Text>}
        {card.meta !== undefined && <Text key={`${name}:meta`} size="footnote" dimColor>{card.meta}</Text>}
      </Box>
    )
    // A card that runs past the end of the list can be cut off, so it opens below its row when
    // it fits inside the list, else above, and a list too short for either gets blank room.
    const rowTops: number[] = []
    const rowsHeight = shownRows.reduce((top, row) => {
      rowTops.push(top)
      return top + paneRowHeight(row, compact)
    }, 0)
    const listHeight = rowsHeight + (paging.showPager ? (compact ? 1 : 2) : 0)
    let cardsBottom = 0
    const cardTop = (index: number, contentRows: number, height: number): number => {
      const rowTop = rowTops[index] ?? 0
      const below = rowTop + contentRows
      const top = below + height <= listHeight || rowTop < height ? below : rowTop - height
      cardsBottom = Math.max(cardsBottom, top + height)
      return top
    }
    const overlayCards: JSX.Element[] = []
    const descriptionRoom = cardWidth * 5
    const fixedCard: HoverCard | undefined = engineCounts === undefined ? undefined : {
      title: 'Always sent',
      body: `Mostly the system prompt (${formatTokens(engineCounts.systemPrompt)}) and this conversation (${formatTokens(engineCounts.messages)}).`,
      meta: 'Claude Code sends these with every message. Nothing here turns them off.',
    }
    const fixedCardWidth = Math.min(contentColumns, 48)
    const fixedCardBottom = showFixed && canHover && fixedCard !== undefined ? cardHeight(fixedCard, fixedCardWidth) : 0
    const hidingStatus = saved === 0
      ? 'Hiding nothing yet. In '
      : pendingPresetChange
        ? `Hiding ${formatTokens(saved)} from your next message. In `
        : `Hiding ${formatTokens(saved)}. In `
    const counts = blockCounts(hidden)
    const blockingStatus = counts.servers + counts.tools === 0
      ? ''
      : `Blocking ${counts.servers} server${counts.servers === 1 ? '' : 's'} and ${counts.tools} tool${counts.tools === 1 ? '' : 's'}. `
    const statusPrefix = `${hidingStatus.replace(/ In $/, ' ')}${blockingStatus}In `

    return (
      <Box flexDirection="column" width={bodyColumns} paddingX={padX} paddingTop={compact ? 0 : 1}>
        <Box
          key="header"
          flexDirection="column"
          width={contentColumns}
          rowGap={compact ? 0 : 1}
          marginBottom={compact ? 0 : 2}
        >
          <Box
            key="profiles"
            flexDirection="row"
            flexWrap="wrap"
            columnGap={compact ? 2 : 3}
            width={contentColumns}
          >
            <Box flexShrink={0}><Text dimColor>Profile</Text></Box>
            {['', ...names].map(name => {
              const selected = (activeProfile ?? '') === name
              return (
                <Box key={`profile-wrap:${name}`} flexShrink={0}>
                  <Button
                    key={name === '' ? 'profile:none' : `profile:use:${name}`}
                    {...(selected ? { variant: 'primary' as const } : { plain: true as const })}
                    label={name === '' ? 'None' : name}
                    onPress={() => {
                      void update($, profileDeleting, () => '')
                      if (name === '') {
                        if (activeProfile !== undefined) void resetFolder($, cwd)
                      } else {
                        void useProfile($, cwd, name)
                      }
                    }}
                  />
                </Box>
              )
            })}
            {Input !== undefined && (
              <Box key="profile-wrap:new" flexShrink={0}>
                <Button
                  key="profile:new"
                  plain
                  label="+ New"
                  onPress={() => {
                    void update($, profileDraft, () => '')
                    void update($, profileNaming, () => true)
                    // Asks for the keyboard so the name field's autoFocus takes the typing; the
                    // surface grants it only over an empty prompt.
                    $.ui.open({ id: PANE, title: 'Context', focus: true }).catch((error: unknown) => {
                      log($, `ctx-control: could not focus the pane: ${errorMessage(error)}`, true)
                    })
                  }}
                />
              </Box>
            )}
          </Box>
          {naming && Input !== undefined ? (
            <Box key="profile-actions" flexDirection="row" width={contentColumns} columnGap={compact ? 1 : 2}>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Input
                  key="profile-name"
                  placeholder={draftError ?? "Name it; saves what's on and off now"}
                  value={draft}
                  autoFocus
                  submitLabel="Save"
                  onInput={value => { void update($, profileDraft, () => value) }}
                  onSubmit={value => { void submitProfileName($, cwd, value) }}
                />
              </Box>
              <Box flexShrink={0}>
                <Button
                  key="profile:cancel"
                  plain
                  label="Cancel"
                  onPress={() => {
                    void update($, profileNaming, () => false)
                    void update($, profileDraft, () => '')
                  }}
                />
              </Box>
            </Box>
          ) : activeProfile !== undefined && (
            <Box key="profile-actions" flexDirection="row" width={contentColumns} columnGap={compact ? 2 : 3}>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text size="footnote" dimColor wrap="truncate-end">
                  {profileChanged
                    ? `Changed since you picked ${activeProfile}`
                    : `Changes here can be saved to ${activeProfile}`}
                </Text>
              </Box>
              {profileChanged && (
                <Box key="profile-save-wrap" flexShrink={0}>
                  <Button
                    key="profile:save"
                    variant="primary"
                    label={`Save to ${activeProfile}`}
                    onPress={() => { void saveProfile($, cwd, activeProfile ?? '') }}
                  />
                </Box>
              )}
              {profileChanged && (
                <Box key="profile-revert-wrap" flexShrink={0}>
                  <Button
                    key="profile:revert"
                    plain
                    label="Revert"
                    onPress={() => { void useProfile($, cwd, activeProfile ?? '') }}
                  />
                </Box>
              )}
              {!profileChanged && (
                <Box key="profile-delete-wrap" flexShrink={0}>
                  <Button
                    key="profile:delete"
                    plain
                    label={deleting === activeProfile ? `Delete ${activeProfile}? Press again` : 'Delete'}
                    onPress={() => {
                      const name = activeProfile
                      if (name === undefined) return
                      if (deleting === name) {
                        void update($, profileDeleting, () => '')
                        void deleteProfile($, cwd, name)
                      } else {
                        void update($, profileDeleting, () => name)
                      }
                    }}
                  />
                </Box>
              )}
            </Box>
          )}
          {compact ? (
            <Box key="headline" flexDirection="row" width={contentColumns} overflow="hidden">
              <Box flexShrink={0}>
                <Text weight="bold" tabular>{formatTokens(sent)}</Text>
              </Box>
              <Text wrap="truncate-end"> tokens ride along with every message</Text>
            </Box>
          ) : (
            <Box key="headline" flexDirection="column" width={contentColumns}>
              <Text size="title" weight="bold" tabular>{formatTokens(sent)} tokens</Text>
              <Text size="footnote" dimColor wrap="truncate-end">ride along with every message</Text>
            </Box>
          )}
          <Box key="budget-bar" flexDirection="row" width={contentColumns} overflow="hidden">
            {TAB_ORDER.map(tab => cells.sent[tab] === 0 ? null : (
              <Text key={`budget:${tab}`} color={TAB_COLORS[tab]}>
                {'█'.repeat(cells.sent[tab])}
              </Text>
            ))}
            {cells.fixed > 0 && (
              <Text key="budget:fixed" color="subtle">{'█'.repeat(cells.fixed)}</Text>
            )}
            {cells.hidden > 0 && (
              <Text key="budget:hidden" color="inactive">{'░'.repeat(cells.hidden)}</Text>
            )}
          </Box>
          <Box
            key="tab-bar"
            flexDirection="row"
            flexWrap="wrap"
            columnGap={compact ? 2 : 3}
            rowGap={compact ? 0 : 1}
            width={contentColumns}
          >
            {TAB_ORDER.map((tab, index) => (
              <Box key={`tab-wrap:${tab}`} flexDirection="row" flexShrink={0}>
                <Box flexShrink={0}><Text color={TAB_COLORS[tab]}>● </Text></Box>
                {selectedTab === tab ? (
                  <Button
                    key={`tab:${tab}`}
                    hotkey={String(index + 1)}
                    variant="primary"
                    label={labels[tab]}
                    onPress={() => { void setActiveTab($, tab) }}
                  />
                ) : (
                  <Button
                    key={`tab:${tab}`}
                    hotkey={String(index + 1)}
                    plain
                    label={labels[tab]}
                    onPress={() => { void setActiveTab($, tab) }}
                  />
                )}
              </Box>
            ))}
            {showFixed && (
              <Box
                key="legend:fixed"
                flexDirection="row"
                flexShrink={0}
                hover={{ scope: 'ctx-control-fixed' }}
              >
                <Box flexShrink={0}><Text color="subtle">● </Text></Box>
                <Text dimColor>{fixedLabel}</Text>
              </Box>
            )}
          </Box>
          {selectedTab === 'tools' && (
            <Box key="tools-footnote" width={contentColumns} overflow="hidden">
              <Text size="footnote" dimColor wrap="truncate-end">
                Click a tool or Block all. Blocked tools can't be searched for or called.
              </Text>
            </Box>
          )}
          {compact ? (
            <Box key="status" flexDirection="row" width={contentColumns} overflow="hidden">
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text size="footnote" dimColor wrap="truncate-end">{statusPrefix}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text size="footnote" dimColor wrap="truncate-start">{folder}</Text>
              </Box>
              <Box flexShrink={0}><Text size="footnote" dimColor>.</Text></Box>
            </Box>
          ) : (
            <Box key="status" flexDirection="column" width={contentColumns} overflow="hidden">
              <Text size="footnote" wrap="truncate-end">{statusPrefix.replace(/ In $/, '')}</Text>
              <Text size="footnote" dimColor wrap="truncate-start">{folder}</Text>
            </Box>
          )}
          {showPanelNote && (
            <Box key="panel-note" width={contentColumns} overflow="hidden">
              <Text size="footnote" dimColor wrap={compact ? 'truncate-end' : 'wrap'}>{PANEL_NOTE}</Text>
            </Box>
          )}
          {fallbackCaption && (
            <Box key="skills-fallback-caption" width={contentColumns} overflow="hidden">
              <Text size="footnote" dimColor wrap="truncate-end">
                Showing commands until your first message confirms which are skills
              </Text>
            </Box>
          )}
        </Box>
        <Box key="filter-row" flexDirection="row" width={contentColumns} columnGap={compact ? 1 : 2}>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {Input === undefined ? (
              <Text size="footnote" dimColor>{searchPlaceholder(selectedTab)}</Text>
            ) : (
              <Input
                key="filter"
                placeholder={searchPlaceholder(selectedTab)}
                value={filterValue}
                onInput={value => { void setFilter($, value) }}
                onSubmit={value => { void setFilter($, value) }}
              />
            )}
          </Box>
          <Box flexShrink={0}>
            <Button
              key="toggle-filtered"
              label={selectedTab === 'tools'
                ? allFilteredBlocked ? 'Unblock all' : 'Block all'
                : allFilteredHidden ? 'Show all' : 'Hide all'}
              onPress={() => {
                if (selectedTab === 'tools') {
                  void setToolsBlocked($, cwd, filteredItems, !allFilteredBlocked)
                } else {
                  void setItemsVisibility($, cwd, filteredIds, allFilteredHidden)
                }
              }}
            />
          </Box>
        </Box>
        <Box key="rows" flexDirection="column" width={contentColumns}>
          {shownRows.map((row, rowIndex) => {
            // Gives a row a hover card: the wrapper joins the card's hover group, the row keeps
            // its own key and one-line text, and the card waits for the overlay after the pager.
            const withCard = (
              rowBox: JSX.Element,
              card: HoverCard,
              contentRows: number,
            ) => {
              const scope = `ctx-control-card-${rowIndex}`
              overlayCards.push(hoverCard(row.key, card, {
                top: cardTop(rowIndex, contentRows, cardHeight(card, cardWidth)),
                scope,
              }))
              return (
                <Box key={`hover:${row.key}`} flexDirection="column" width={contentColumns} hover={{ scope }}>
                  {rowBox}
                </Box>
              )
            }
            if (row.kind === 'empty') {
              return (
                <Box key={row.key} flexDirection="row" width={contentColumns} overflow="hidden">
                  <Text size="footnote" dimColor wrap="truncate-end">{row.text}</Text>
                </Box>
              )
            }
            if (row.kind === 'caption') {
              return (
                <Box key={row.key} flexDirection="row" width={contentColumns} overflow="hidden">
                  <Text size="footnote" dimColor wrap="truncate-end">{row.text}</Text>
                </Box>
              )
            }
            if (row.kind === 'section') {
              return (
                <Box
                  key={row.key}
                  flexDirection="row"
                  width={contentColumns}
                  marginTop={compact ? 0 : 2}
                  overflow="hidden"
                >
                  <Text weight="semibold" wrap="truncate-end">{row.label}</Text>
                </Box>
              )
            }
            if (row.kind === 'group') {
              const noun = selectedTab === 'skills'
                ? 'skills'
                : selectedTab === 'tools'
                  ? 'tools'
                  : 'items'
              const count = `${row.items.length} ${row.items.length === 1 ? noun.slice(0, -1) : noun}`
              const detail = row.mode === 'deferred'
                ? count
                : `${count}, ${formatTokens(sumTokens(row.items))} tokens`
              const labelRoom = contentColumns >= 50 ? Math.floor(contentColumns * 0.4) : contentColumns - 12
              // A fixed name column from 50 columns up, so every group's count starts at the same
              // place; deferred rows give one column of it to their ▸.
              const labelWidth = contentColumns >= 50
                ? labelRoom - (row.mode === 'deferred' ? 1 : 0)
                : undefined
              const groupBlocked = row.items.length > 0 &&
                row.items.every(item => toolState(item, hidden) === 'blocked')
              const groupBox = (
                <Box
                  key={row.key}
                  flexDirection="row"
                  width={contentColumns}
                  marginTop={compact ? 0 : 1}
                >
                  {row.mode === 'deferred' && (
                    <Box flexShrink={0}>
                      <Button
                        key={`${row.key}:expand`}
                        plain
                        label={row.expanded === true ? '▾' : '▸'}
                        onPress={() => { void toggleExpandedToolGroup($, row.items[0]?.server ?? 'Built-in') }}
                      />
                    </Box>
                  )}
                  <Box
                    {...(labelWidth === undefined
                      ? { flexGrow: 1, flexShrink: 1 }
                      : { width: labelWidth, flexShrink: 0 })}
                    overflow="hidden"
                  >
                    <Text weight="semibold" wrap="truncate-end">{row.label}</Text>
                  </Box>
                  {(contentColumns >= 50 || row.mode === 'deferred') && (
                    <Box flexGrow={1} flexShrink={1} marginX={1} overflow="hidden">
                      <Text size="footnote" dimColor tabular wrap="truncate-end">{detail}</Text>
                    </Box>
                  )}
                  <Box flexShrink={0}>
                    <Button
                      key={`${row.key}:toggle`}
                      plain
                      label={groupState(row.items, hidden, row.mode)}
                      onPress={() => {
                        if (row.mode === 'generic') {
                          void toggleItems($, cwd, row.items.map(item => item.id))
                        } else {
                          void toggleToolGroup($, cwd, row.items, row.mode)
                        }
                      }}
                    />
                  </Box>
                  {row.mode !== 'generic' && (
                    <Box flexShrink={0} marginLeft={1}>
                      <Button
                        key={`${row.key}:all`}
                        label={groupBlocked ? 'Unblock all' : 'Block all'}
                        onPress={() => { void setGroupBlocked($, cwd, row.items, !groupBlocked) }}
                      />
                    </Box>
                  )}
                </Box>
              )
              return canHover && row.label.length > labelRoom
                ? withCard(groupBox, { title: row.label, meta: `${detail}.` }, compact ? 1 : 2)
                : groupBox
            }

            const state = row.item.tab === 'tools' ? toolState(row.item, hidden) : undefined
            const included = state === undefined ? !isHidden(row.item.id, hidden) : state !== 'blocked'
            const mark = state === undefined ? included ? '●' : '○' : toolStateMark(state)
            const markColor: ThemeKey = state === 'blocked'
              ? 'error'
              : state === 'demand'
                ? 'inactive'
                : included ? TAB_COLORS[selectedTab] : 'inactive'
            const dimmed = state === 'blocked' || !included
            const itemNameWidth = compact
              ? Math.max(1, nameW - 2)
              : Math.max(1, itemColumns - tokenW - 3)
            const description = row.item.description.replace(/\s+/g, ' ').trim()
            const descriptionWidth = compact
              ? showDescription ? itemColumns - nameW - tokenW - 2 : 0
              : itemColumns - 2
            const needsCard = canHover && (
              row.item.label.length > itemNameWidth ||
              description.length > descriptionWidth ||
              row.item.stale === true
            )
            const card: HoverCard = {
              title: row.item.label,
              ...(description === '' ? {} : { body: clipAtWord(description, descriptionRoom) }),
              meta: itemCardMeta(row.item, hidden),
            }
            const rowDim = dimmed || row.item.stale === true
            if (!compact) {
              const itemBox = (
                <Box
                  key={row.key}
                  flexDirection="column"
                  width={itemColumns}
                  marginBottom={1}
                >
                  <Box flexDirection="row" width={itemColumns}>
                    <Box flexShrink={0}>
                      <Text color={markColor}>
                        {mark}{' '}
                      </Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1} overflow="hidden">
                      <Button
                        key={`${row.key}:toggle`}
                        plain
                        dimColor={rowDim}
                        onPress={() => { void toggleItem($, cwd, row.item.id) }}
                      >
                        <Text size="body" weight="medium">
                          {truncateEnd(row.item.label, itemNameWidth)}
                        </Text>
                      </Button>
                    </Box>
                    <Box flexShrink={0} width={tokenW} justifyContent="flex-end">
                      <Text size="footnote" tabular dimColor wrap="truncate-start">
                        {row.item.stale === true ? '–' : formatTokens(row.item.tokens)}
                      </Text>
                    </Box>
                  </Box>
                  <Box marginLeft={2} overflow="hidden">
                    <Text size="footnote" dimColor wrap="truncate-end">
                      {row.item.stale === true ? 'Seen in an earlier session' : description}
                    </Text>
                  </Box>
                </Box>
              )
              return needsCard ? withCard(itemBox, card, 2) : itemBox
            }
            const compactBox = (
              <Box
                key={row.key}
                flexDirection="row"
                width={itemColumns}
                marginLeft={2}
              >
                <Box width={nameW} flexDirection="row" flexShrink={0} overflow="hidden">
                  <Box flexShrink={0}>
                    <Text color={markColor}>
                      {mark}{' '}
                    </Text>
                  </Box>
                  <Button
                    key={`${row.key}:toggle`}
                    plain
                    dimColor={rowDim}
                    label={truncateEnd(row.item.label, itemNameWidth)}
                    onPress={() => { void toggleItem($, cwd, row.item.id) }}
                  />
                </Box>
                {showDescription ? (
                  <Box flexGrow={1} flexShrink={1} marginX={1} overflow="hidden">
                    <Text dimColor wrap="truncate-end">
                      {row.item.stale === true ? 'Seen in an earlier session' : description}
                    </Text>
                  </Box>
                ) : <Box flexGrow={1} flexShrink={1} />}
                <Box
                  flexDirection="row"
                  flexShrink={0}
                  justifyContent="flex-end"
                  overflow="hidden"
                  width={tokenW}
                >
                  <Text size="footnote" tabular dimColor wrap="truncate-start">
                    {row.item.stale === true ? '–' : formatTokens(row.item.tokens)}
                  </Text>
                </Box>
              </Box>
            )
            return needsCard ? withCard(compactBox, card, 1) : compactBox
          })}
          {paging.showPager && (
            <Box
              key="page-controls"
              flexDirection="row"
              justifyContent="flex-end"
              width={contentColumns}
              marginTop={compact ? 0 : 1}
            >
              <Button
                key="page:prev"
                plain
                dimColor={paging.page === 0}
                label="Previous"
                onPress={() => { void setPage($, paging.page - 1) }}
              />
              <Text size="footnote" tabular dimColor>
                {'  '}Page {paging.page + 1} of {paging.pageCount}{'  '}
              </Text>
              <Button
                key="page:next"
                plain
                dimColor={paging.page + 1 === paging.pageCount}
                label="Next"
                onPress={() => { void setPage($, Math.min(paging.page + 1, paging.pageCount - 1)) }}
              />
            </Box>
          )}
          {Math.max(cardsBottom, fixedCardBottom) > listHeight && (
            <Box key="card-room" height={Math.max(cardsBottom, fixedCardBottom) - listHeight} />
          )}
          {showFixed && canHover && fixedCard !== undefined && hoverCard('fixed', fixedCard, {
            top: 0,
            left: 0,
            width: fixedCardWidth,
            scope: 'ctx-control-fixed',
          })}
          {overlayCards}
        </Box>
      </Box>
    )
  })
}
