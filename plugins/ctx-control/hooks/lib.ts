export const TAB_ORDER = ['skills', 'tools', 'files', 'other'] as const

export type CatalogTab = (typeof TAB_ORDER)[number]

export type CatalogItem = {
  id: string
  tab: CatalogTab
  label: string
  description: string
  tokens: number
  server?: string
  eager?: boolean
  kind?: string
  /** Remembered from an earlier session and not seen in this one: shown, never counted. */
  stale?: boolean
  /** Its tokens are a share of a total Claude Code reports only as a whole. */
  approximate?: boolean
}

export type ParsedTextItem = {
  id: string
  label: string
  description: string
  text: string
  start: number
  end: number
}

export type TabTotal = {
  count: number
  sentTokens: number
  savedTokens: number
}

export type Pagination = {
  page: number
  pageCount: number
  pageSize: number
  start: number
  end: number
  showPager: boolean
}

export type WeightedPagination = {
  page: number
  pageCount: number
  start: number
  end: number
  showPager: boolean
}

export type BudgetCells = {
  sent: Record<CatalogTab, number>
  fixed: number
  hidden: number
}

/** Claude Code's own context breakdown, reduced to what the pane needs. */
export type EngineCounts = {
  /** Every `used` row together: what Claude Code's Context panel shows as used. */
  used: number
  systemPrompt: number
  messages: number
  systemTools: number
  mcpInstructions: number
  agents: number
  skills: Record<string, number>
  memoryFiles: Record<string, number>
  /** Each memory file's kind as Claude Code names it (`User`, `Project`, …). */
  memoryFileTypes: Record<string, string>
  /** Eager (loaded) MCP tools only. */
  mcpTools: Record<string, number>
}

/** The slice of `SessionContextBreakdown` that `engineCountsFrom` reads. */
export type BreakdownInput = {
  categories: readonly { name: string; tokens: number; kind: string }[]
  memoryFiles: readonly { path: string; tokens: number; type?: string }[]
  mcpTools: readonly { name: string; tokens: number; isLoaded: boolean }[]
  agents: readonly { tokens: number }[]
  skills?: { skillFrontmatter: readonly { name: string; tokens: number }[] }
}

export type ContextSummary = {
  totals: Record<CatalogTab, TabTotal>
  /** What the four tabs send. */
  tabsSent: number
  /** What hiding and blocking take out. */
  saved: number
  /** The system prompt, the conversation and the rest no switch reaches. */
  fixed: number
  /** Everything that rides along with the next message. */
  total: number
  /** True when the numbers come from Claude Code's breakdown, not estimates. */
  fromEngine: boolean
}

export type ToolState = 'sent' | 'demand' | 'blocked'

const LEGACY_TAB_BY_GROUP: Record<string, CatalogTab | undefined> = {
  'instruction-files': 'files',
  memory: 'files',
  skills: 'skills',
  'mcp-docs': 'other',
  'hook-output': 'other',
  'mcp-tool-schemas': undefined,
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  const value = Math.round(tokens / 100) / 10
  return `${String(value).replace(/\.0$/, '')}k`
}

export function matchesPattern(id: string, pattern: string): boolean {
  return pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern
}

export function isHidden(id: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => matchesPattern(id, pattern))
}

export function isBlockPattern(pattern: string): boolean {
  return pattern.startsWith('block:')
}

export function isServerBlockPattern(pattern: string): boolean {
  return /^block:mcp__.+__\*$/.test(pattern)
}

export function isToolBlocked(tool: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern =>
    isBlockPattern(pattern) && matchesPattern(tool, pattern.slice('block:'.length)),
  )
}

export function toolState(item: CatalogItem, patterns: readonly string[]): ToolState {
  const name = item.id.startsWith('tool:') ? item.id.slice('tool:'.length) : item.id
  if (isToolBlocked(name, patterns)) return 'blocked'
  if (item.eager !== true || isHidden(item.id, patterns)) return 'demand'
  return 'sent'
}

export function withoutMatchingToolBlocks(
  patterns: readonly string[],
  tool: string,
): string[] {
  return patterns.filter(pattern =>
    !isBlockPattern(pattern) || !matchesPattern(tool, pattern.slice('block:'.length)),
  )
}

export function filterDeferredToolNames(
  text: string,
  patterns: readonly string[],
): string {
  return text
    .split('\n')
    .filter(line => !isToolBlocked(line.trim(), patterns))
    .join('\n')
}

export function blockCounts(patterns: readonly string[]): {
  servers: number
  tools: number
} {
  let servers = 0
  let tools = 0
  for (const pattern of new Set(patterns.filter(isBlockPattern))) {
    if (isServerBlockPattern(pattern)) servers += 1
    else tools += 1
  }
  return { servers, tools }
}

export function normalizePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map(pattern => pattern.trim()).filter(Boolean))].sort()
}

export function migratePatterns(patterns: readonly string[]): string[] {
  return normalizePatterns(patterns.filter(pattern => !pattern.startsWith('mcptools:')))
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return undefined
  return normalizePatterns(value)
}

export function resolvePreset(
  folderPreset: readonly string[] | undefined,
  defaultPreset: readonly string[] | undefined,
): string[] {
  return migratePatterns(folderPreset ?? defaultPreset ?? [])
}

export function showFromPreset(
  hidden: readonly string[],
  requests: readonly string[],
  catalogIds: readonly string[],
): string[] {
  const wanted = normalizePatterns(requests)
  const targetIds = catalogIds.filter(id => wanted.some(pattern => matchesPattern(id, pattern)))
  const originallyHidden = catalogIds.filter(id => isHidden(id, hidden))
  const stillHidden = originallyHidden.filter(
    id => !wanted.some(pattern => matchesPattern(id, pattern)),
  )

  const kept = hidden.filter(pattern => {
    if (wanted.some(request => request === pattern || matchesPattern(pattern, request))) return false
    return !targetIds.some(id => matchesPattern(id, pattern))
  })

  for (const id of stillHidden) {
    if (!isHidden(id, kept)) kept.push(id)
  }

  return migratePatterns(kept)
}

function parseTextBlocks(
  text: string,
  startPattern: RegExp,
  identify: (line: string) => { id: string; label: string; description: string } | undefined,
): ParsedTextItem[] {
  const lines = text.split('\n')
  const starts: Array<{
    start: number
    identity: { id: string; label: string; description: string }
  }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!startPattern.test(line)) continue
    const identity = identify(line)
    if (identity !== undefined) starts.push({ start: index, identity })
  }

  return starts.map(({ start, identity }, index) => {
    const end = starts[index + 1]?.start ?? lines.length
    return { ...identity, text: lines.slice(start, end).join('\n'), start, end }
  })
}

export function parseSkillListing(text: string): ParsedTextItem[] {
  return parseTextBlocks(text, /^- /, line => {
    const rest = line.slice(2)
    const delimiter = rest.indexOf(': ')
    const name = (delimiter === -1 ? rest : rest.slice(0, delimiter)).trim()
    const description = delimiter === -1 ? '' : rest.slice(delimiter + 2).trim()
    return name.length > 0
      ? { id: `skill:${name}`, label: name, description }
      : undefined
  })
}

export function filterSkillListing(text: string, hidden: readonly string[]): string | null {
  return filterParsedBlocks(text, parseSkillListing(text), hidden)
}

export function normalizeMcpServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function parseMcpInstructions(
  text: string,
  knownServers: readonly string[] = [],
): ParsedTextItem[] {
  const normalizedServers = new Set(
    knownServers.map(normalizeMcpServerName).filter(name => name.length > 0),
  )
  const useEveryHeading = normalizedServers.size === 0
  return parseTextBlocks(text, /^## /, line => {
    const name = line.slice(3).trim()
    if (
      name.length === 0 ||
      (!useEveryHeading && !normalizedServers.has(normalizeMcpServerName(name)))
    ) return undefined
    return {
      id: `mcpdoc:${name}`,
      label: name,
      description: 'MCP server instructions',
    }
  }).map(item => {
    const body = item.text.split('\n').slice(1).join('\n')
    const raw = item.id.slice('mcpdoc:'.length)
    const label = guessMcpServerName(raw, body)
    const firstLine = body.split('\n').map(line => line.trim()).find(line => line !== '' && !line.startsWith('#'))
    const description = firstLine === undefined ? 'MCP server instructions' : summarizeDescription(firstLine)
    return { ...item, label, description }
  })
}

const NAME_STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Use', 'Used', 'Using', 'When', 'Where', 'What', 'Which', 'With',
  'For', 'From', 'And', 'But', 'Not', 'Never', 'Always', 'Only', 'Each', 'Every', 'Any', 'All',
  'You', 'Your', 'Its', 'It', 'If', 'Then', 'Else', 'One', 'Two', 'Call', 'Read', 'Write', 'Make',
  'Get', 'Set', 'Add', 'See', 'Ask', 'Keep', 'Do', 'Don', 'Tools', 'Tool', 'MCP', 'API', 'URL',
  'JSON', 'ID', 'IDs', 'Claude', 'Returns', 'Return', 'Note', 'Important', 'IMPORTANT', 'True',
  'False', 'Treat', 'Tools', 'Core', 'Choosing', 'Finding', 'Dates', 'Recommend', 'Search',
  'Create', 'Save', 'Link', 'Users', 'User', 'Here', 'There', 'Some', 'More', 'Most', 'First',
])

/** A readable name for an MCP server whose id is a UUID, from its own instructions text. */
export function guessMcpServerName(server: string, body: string, toolNames: readonly string[] = []): string {
  if (!isUuidLike(server)) return displayMcpServer(server, toolNames)
  const lines = body.split('\n').map(line => line.trim()).filter(line => line !== '')

  // "Claude Docs: living docs you create…" → "Claude Docs"
  const lead = /^([A-Z][\w.&+-]*(?: [A-Z][\w.&+-]*){0,2}):\s/.exec(lines[0] ?? '')
  if (lead?.[1] !== undefined) return lead[1]

  // "## Todoist Task and Project Management Tools" → "Todoist"
  const heading = lines.find(line => /^#{2,3} /.test(line))
  const headingWord = heading?.replace(/^#+ /, '').split(/\s+/)[0]
  if (headingWord !== undefined && /^[A-Z][\w.-]{2,}$/.test(headingWord) && !NAME_STOPWORDS.has(headingWord)) {
    return headingWord
  }

  // The capitalised word the text keeps repeating ("Notion")
  const counts = new Map<string, number>()
  for (const match of body.matchAll(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)) {
    const word = match[0]
    if (NAME_STOPWORDS.has(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]
  if (top !== undefined && top[1] >= 2) return top[0]

  const fromTools = displayMcpServer(server, toolNames)
  if (fromTools !== server && !fromTools.endsWith('…')) return fromTools
  return `Connector ${server.slice(0, 8)}`
}

export function filterMcpInstructions(
  text: string,
  hidden: readonly string[],
  knownServers: readonly string[] = [],
): string | null {
  return filterParsedBlocks(text, parseMcpInstructions(text, knownServers), hidden)
}

function filterParsedBlocks(
  text: string,
  items: readonly ParsedTextItem[],
  hidden: readonly string[],
): string | null {
  if (items.length === 0) return text
  if (items.every(item => isHidden(item.id, hidden))) return null
  const lines = text.split('\n')
  const removed = new Set<number>()
  for (const item of items) {
    if (!isHidden(item.id, hidden)) continue
    for (let index = item.start; index < item.end; index += 1) removed.add(index)
  }
  return lines.filter((_line, index) => !removed.has(index)).join('\n')
}

export function parseMcpToolServer(tool: string): string | undefined {
  return /^mcp__(.+?)__.+/.exec(tool)?.[1]
}

export function parseMcpToolName(tool: string): string {
  return /^mcp__.+?__(.+)/.exec(tool)?.[1] ?? tool
}

export function summarizeDescription(description: string, limit = 100): string {
  const normalized = description.trim().replace(/\s+/g, ' ')
  const sentence = /^.*?[.!?](?:\s|$)/.exec(normalized)?.[0].trim() ?? normalized
  return sentence.slice(0, Math.max(0, limit)).trimEnd()
}

export function createToolCatalogItem(
  name: string,
  description: string,
  isDeferred: boolean | undefined,
): CatalogItem {
  const server = parseMcpToolServer(name)
  const summary = summarizeDescription(description)
  return {
    id: `tool:${name}`,
    tab: 'tools',
    label: server === undefined ? name : parseMcpToolName(name),
    description: summary,
    tokens: estimateTokens(name + description),
    ...(server === undefined ? {} : { server }),
    eager: isDeferred !== true,
  }
}

function isUuidLike(server: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(server)
}

export function displayMcpServer(server: string, toolNames: readonly string[]): string {
  if (!isUuidLike(server)) {
    return server.replace(/^claude_ai_/i, '').replace(/_/g, ' ').trim()
  }

  const names = [...toolNames].sort((left, right) => left.localeCompare(right))
  const parts = names.map(name => name.split(/[_-]+/).filter(Boolean))
  let shared = parts[0]?.length ?? 0
  for (let index = 1; index < parts.length; index += 1) {
    let count = 0
    while (
      count < shared &&
      count < (parts[index]?.length ?? 0) &&
      parts[0]?.[count]?.toLowerCase() === parts[index]?.[count]?.toLowerCase()
    ) count += 1
    shared = count
  }
  const prefix = (parts[0] ?? []).slice(0, shared).join(' ')
  if (prefix.length >= 3) return prefix

  const fallback = names.slice(0, 2).join(', ')
  return fallback === '' ? server : `${fallback} …`
}

export function skillNamespace(item: Pick<CatalogItem, 'label'> | string): string {
  const name = typeof item === 'string' ? item : item.label
  const delimiter = name.lastIndexOf(':')
  return delimiter === -1 ? 'Personal & built-in' : name.slice(0, delimiter)
}

export function isToggleable(item: CatalogItem): boolean {
  return item.tab !== 'tools' || item.eager === true
}

export function tabTotals(
  catalog: readonly CatalogItem[],
  hidden: readonly string[],
): Record<CatalogTab, TabTotal> {
  const totals: Record<CatalogTab, TabTotal> = {
    skills: { count: 0, sentTokens: 0, savedTokens: 0 },
    tools: { count: 0, sentTokens: 0, savedTokens: 0 },
    files: { count: 0, sentTokens: 0, savedTokens: 0 },
    other: { count: 0, sentTokens: 0, savedTokens: 0 },
  }
  for (const item of catalog) {
    const total = totals[item.tab]
    total.count += 1
    if (!isToggleable(item) || item.stale === true) continue
    const blocked = item.tab === 'tools' && isToolBlocked(
      item.id.startsWith('tool:') ? item.id.slice('tool:'.length) : item.id,
      hidden,
    )
    if (blocked || isHidden(item.id, hidden)) total.savedTokens += item.tokens
    else total.sentTokens += item.tokens
  }
  return totals
}

export function paginate(
  totalRows: number,
  viewportRows: number,
  fixedRows: number,
  requestedPage: number,
): Pagination {
  const withoutPager = Math.max(1, Math.floor(viewportRows) - fixedRows)
  const showPager = totalRows > withoutPager
  const pageSize = Math.max(1, withoutPager - (showPager ? 1 : 0))
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize))
  const page = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1))
  const start = page * pageSize
  return {
    page,
    pageCount,
    pageSize,
    start,
    end: Math.min(totalRows, start + pageSize),
    showPager,
  }
}

export function paginateHeights(
  rowHeights: readonly number[],
  viewportRows: number,
  fixedRows: number,
  requestedPage: number,
): WeightedPagination {
  const roomWithoutPager = Math.max(1, Math.floor(viewportRows) - fixedRows)
  const totalHeight = rowHeights.reduce(
    (sum, height) => sum + Math.max(1, Math.floor(height)),
    0,
  )
  const showPager = totalHeight > roomWithoutPager
  const capacity = Math.max(1, roomWithoutPager - (showPager ? 1 : 0))
  const pages: Array<{ start: number; end: number }> = []
  let start = 0
  let height = 0

  for (let index = 0; index < rowHeights.length; index += 1) {
    const rowHeight = Math.max(1, Math.floor(rowHeights[index] ?? 1))
    if (index > start && height + rowHeight > capacity) {
      pages.push({ start, end: index })
      start = index
      height = 0
    }
    height += rowHeight
  }
  pages.push({ start, end: rowHeights.length })

  const pageCount = Math.max(1, pages.length)
  const page = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1))
  const selected = pages[page] ?? { start: 0, end: 0 }
  return { page, pageCount, ...selected, showPager }
}

export function budgetCells(
  totals: Readonly<Record<CatalogTab, TabTotal>>,
  requestedWidth: number,
  fixedTokens = 0,
): BudgetCells {
  const width = Math.max(0, Math.floor(requestedWidth))
  const sent = Object.fromEntries(TAB_ORDER.map(tab => [tab, 0])) as Record<
    CatalogTab,
    number
  >
  const fixedSent = Math.max(0, fixedTokens)
  const total = fixedSent + TAB_ORDER.reduce(
    (sum, tab) => sum + totals[tab].sentTokens + totals[tab].savedTokens,
    0,
  )
  if (width === 0 || total === 0) return { sent, fixed: 0, hidden: width }

  // The fixed part is one more segment, drawn after the four tabs.
  type Segment = CatalogTab | 'fixed'
  const tokensOf = (segment: Segment): number =>
    segment === 'fixed' ? fixedSent : totals[segment].sentTokens
  const cells: Record<Segment, number> = { ...sent, fixed: 0 }
  const segments: Segment[] = [...TAB_ORDER, 'fixed']
  const nonZero = segments.filter(segment => tokensOf(segment) > 0)
  const minimum = width >= nonZero.length ? 1 : 0
  for (const segment of nonZero) {
    cells[segment] = Math.max(minimum, Math.round(width * tokensOf(segment) / total))
  }

  let overflow = segments.reduce((sum, segment) => sum + cells[segment], 0) - width
  while (overflow > 0) {
    const reducible = [...segments]
      .filter(segment => cells[segment] > minimum)
      .sort((left, right) => cells[right] - cells[left])[0]
    if (reducible === undefined) break
    cells[reducible] -= 1
    overflow -= 1
  }

  for (const tab of TAB_ORDER) sent[tab] = cells[tab]
  const used = segments.reduce((sum, segment) => sum + cells[segment], 0)
  return { sent, fixed: cells.fixed, hidden: Math.max(0, width - used) }
}

/** Splits `total` across `weights` in proportion, the parts summing to `total` exactly. */
export function apportion(total: number, weights: readonly number[]): number[] {
  const whole = Math.max(0, Math.round(total))
  if (weights.length === 0) return []
  const positive = weights.map(weight => Math.max(0, weight))
  const sum = positive.reduce((acc, weight) => acc + weight, 0)
  const shares = sum === 0
    ? positive.map(() => whole / weights.length)
    : positive.map(weight => whole * weight / sum)
  const parts = shares.map(Math.floor)
  let left = whole - parts.reduce((acc, part) => acc + part, 0)
  const byRemainder = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const { index } of byRemainder) {
    if (left <= 0) break
    parts[index] = (parts[index] ?? 0) + 1
    left -= 1
  }
  return parts
}

/** Reads Claude Code's breakdown rows by name; any `used` row it doesn't know stays in `used`. */
export function engineCountsFrom(breakdown: BreakdownInput): EngineCounts {
  const row = (name: string): number => breakdown.categories
    .filter(category => category.kind === 'used' && category.name.toLowerCase() === name)
    .reduce((sum, category) => sum + category.tokens, 0)
  const byName = <T extends { tokens: number }>(
    entries: readonly T[],
    keyOf: (entry: T) => string,
  ): Record<string, number> => {
    const result: Record<string, number> = {}
    for (const entry of entries) result[keyOf(entry)] = (result[keyOf(entry)] ?? 0) + entry.tokens
    return result
  }
  return {
    used: breakdown.categories
      .filter(category => category.kind === 'used')
      .reduce((sum, category) => sum + category.tokens, 0),
    systemPrompt: row('system prompt'),
    messages: row('messages'),
    systemTools: row('system tools'),
    mcpInstructions: row('mcp server instructions'),
    agents: breakdown.agents.reduce((sum, agent) => sum + agent.tokens, 0),
    skills: byName(breakdown.skills?.skillFrontmatter ?? [], skill => skill.name),
    memoryFiles: byName(breakdown.memoryFiles, file => file.path),
    memoryFileTypes: Object.fromEntries(
      breakdown.memoryFiles.map(file => [file.path, (file.type ?? 'memory').toLowerCase()]),
    ),
    mcpTools: byName(breakdown.mcpTools.filter(tool => tool.isLoaded), tool => tool.name),
  }
}

/** An on-demand tool costs only its line in the list of on-demand tool names. */
export function deferredNameTokens(tool: string): number {
  return estimateTokens(`${tool}\n`)
}

/**
 * Replaces estimates with Claude Code's own numbers where it reports them per item, and
 * shares out the totals it reports only as a whole (built-in tools, MCP server docs).
 */
export function applyEngineCounts(
  catalog: readonly CatalogItem[],
  counts: EngineCounts | undefined,
): CatalogItem[] {
  const result = catalog.map(item => {
    if (item.tab === 'tools' && item.eager !== true) {
      return { ...item, tokens: deferredNameTokens(item.id.slice('tool:'.length)) }
    }
    if (counts === undefined) return item
    if (item.tab === 'skills') {
      const tokens = counts.skills[item.label]
      return tokens === undefined ? item : { ...item, tokens }
    }
    if (item.tab === 'files' && item.id.startsWith('file:')) {
      const tokens = counts.memoryFiles[item.id.slice('file:'.length)]
      return tokens === undefined ? item : { ...item, tokens }
    }
    if (item.tab === 'tools' && item.server !== undefined) {
      const tokens = counts.mcpTools[item.id.slice('tool:'.length)]
      return tokens === undefined ? item : { ...item, tokens }
    }
    if (item.id === 'attachment:agent_listing_delta' && counts.agents > 0 && item.stale !== true) {
      return { ...item, tokens: counts.agents }
    }
    return item
  })
  if (counts === undefined) return result

  const shareOut = (members: number[], total: number): void => {
    if (members.length === 0 || total <= 0) return
    const parts = apportion(total, members.map(index => result[index]?.tokens ?? 0))
    members.forEach((index, position) => {
      const item = result[index]
      if (item !== undefined) result[index] = { ...item, tokens: parts[position] ?? 0, approximate: true }
    })
  }
  const indexes = (test: (item: CatalogItem) => boolean): number[] =>
    result.flatMap((item, index) => (test(item) ? [index] : []))
  shareOut(
    indexes(item => item.tab === 'tools' && item.eager === true && item.server === undefined),
    counts.systemTools,
  )
  shareOut(
    indexes(item => item.tab === 'other' && item.id.startsWith('mcpdoc:') && item.stale !== true),
    counts.mcpInstructions,
  )
  return result
}

/**
 * The headline and its parts. With Claude Code's breakdown the total is its `used` figure
 * less what this mod removes, so it matches Claude Code's panel whenever nothing is hidden.
 */
export function contextSummary(
  catalog: readonly CatalogItem[],
  hidden: readonly string[],
  counts: EngineCounts | undefined,
): ContextSummary {
  const totals = tabTotals(catalog, hidden)
  const tabsSent = TAB_ORDER.reduce((sum, tab) => sum + totals[tab].sentTokens, 0)
  const saved = TAB_ORDER.reduce((sum, tab) => sum + totals[tab].savedTokens, 0)
  if (counts === undefined) {
    return { totals, tabsSent, saved, fixed: 0, total: tabsSent, fromEngine: false }
  }
  const total = Math.max(tabsSent, counts.used - saved)
  return { totals, tabsSent, saved, fixed: total - tabsSent, total, fromEngine: true }
}

export function formatCount(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** How many rows `text` takes when wrapped to `width` columns. */
export function wrappedLineCount(text: string, width: number): number {
  const room = Math.max(1, Math.floor(width))
  return text.split('\n').reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / room)),
    0,
  )
}

export function abbreviateHome(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export function folderLabel(path: string, home: string | undefined): string {
  const scratchRoot = home === undefined
    ? undefined
    : `${home}/Library/Application Support/Claude/scratch-workspaces/`
  if (scratchRoot !== undefined && path.startsWith(scratchRoot)) {
    return "this session's folder"
  }
  return abbreviateHome(path, home)
}

export function splitArguments(input: string): string[] {
  const values: string[] = []
  let value = ''
  let quote: '"' | "'" | undefined
  let escaping = false

  for (const character of input.trim()) {
    if (escaping) {
      value += character
      escaping = false
    } else if (character === '\\' && quote !== "'") {
      escaping = true
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else value += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (value !== '') {
        values.push(value)
        value = ''
      }
    } else {
      value += character
    }
  }

  if (escaping) value += '\\'
  if (value !== '') values.push(value)
  return values
}

function legacyDescription(id: string, group: string | undefined): string {
  if (id === 'section:memory') return 'Memory section'
  if (id === 'hook:context') return 'Hook-added context'
  if (id === 'attachment:agent_listing_delta') return 'Available subagent types'
  if (group === 'mcp-docs') return 'MCP server instructions'
  return ''
}

export function sanitizeCatalog(value: unknown): CatalogItem[] {
  if (!Array.isArray(value)) return []
  const tabs = new Set<string>(TAB_ORDER)
  const result: CatalogItem[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (
      typeof record.id !== 'string' ||
      record.id.startsWith('mcptools:') ||
      typeof record.label !== 'string' ||
      typeof record.tokens !== 'number'
    ) continue

    const legacyGroup = typeof record.group === 'string' ? record.group : undefined
    const tab = typeof record.tab === 'string' && tabs.has(record.tab)
      ? record.tab as CatalogTab
      : legacyGroup === undefined
        ? undefined
        : LEGACY_TAB_BY_GROUP[legacyGroup]
    if (tab === undefined) continue

    const candidate: CatalogItem = {
      id: record.id,
      tab,
      label: record.label,
      description: typeof record.description === 'string'
        ? record.description
        : legacyDescription(record.id, legacyGroup),
      tokens: Math.max(0, Math.ceil(record.tokens)),
    }
    if (typeof record.server === 'string') candidate.server = record.server
    if (typeof record.eager === 'boolean') candidate.eager = record.eager
    if (typeof record.kind === 'string') candidate.kind = record.kind
    result.push(candidate)
  }
  return result
}

// Profiles: named sets of the same patterns a folder preset holds, kept in one store key.
export type Profiles = Record<string, string[]>

const PROFILE_SUBCOMMANDS = new Set(['save', 'delete', 'rename', 'none'])
export const PROFILE_NAME_MAX = 32

export function parseProfiles(value: unknown): Profiles {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const profiles: Profiles = {}
  for (const [name, patterns] of Object.entries(value as Record<string, unknown>)) {
    const parsed = stringArray(patterns)
    if (parsed !== undefined && profileNameError(name) === undefined) {
      profiles[name] = migratePatterns(parsed)
    }
  }
  return profiles
}

export function profileNameError(name: string): string | undefined {
  if (name.trim() === '') return 'Give the profile a name.'
  if (name !== name.trim()) return 'A profile name can\'t start or end with a space.'
  if (name.length > PROFILE_NAME_MAX) return `Keep the name to ${PROFILE_NAME_MAX} characters.`
  if (PROFILE_SUBCOMMANDS.has(name.toLowerCase())) return `"${name}" is a /ctx profile command; pick another name.`
  return undefined
}

export function profileNames(profiles: Profiles): string[] {
  return Object.keys(profiles).sort((left, right) => left.localeCompare(right))
}

// Finds a profile by name, ignoring case, so `/ctx profile coding` finds "Coding".
export function findProfile(profiles: Profiles, name: string): string | undefined {
  if (Object.hasOwn(profiles, name)) return name
  const lower = name.toLowerCase()
  return profileNames(profiles).find(candidate => candidate.toLowerCase() === lower)
}

export function presetDiffers(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(migratePatterns(left)) !== JSON.stringify(migratePatterns(right))
}
