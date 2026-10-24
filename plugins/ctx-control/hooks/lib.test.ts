import { expect, mock, test } from 'claude-code/testing'
import type { CommandInfo, On, SessionUsage, ToolInfo } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import {
  apportion,
  applyEngineCounts,
  budgetCells,
  contextSummary,
  deferredNameTokens,
  engineCountsFrom,
  formatTokens,
  createToolCatalogItem,
  displayMcpServer,
  filterMcpInstructions,
  filterSkillListing,
  findProfile,
  folderLabel,
  isHidden,
  migratePatterns,
  paginate,
  paginateHeights,
  parseMcpInstructions,
  parseProfiles,
  presetDiffers,
  profileNameError,
  guessMcpServerName,
  parseSkillListing,
  resolvePreset,
  sanitizeCatalog,
  skillNamespace,
  tabTotals,
} from './lib'

function mockCatalogApis(
  on: On,
  commands: readonly CommandInfo[] = [],
  tools: readonly ToolInfo[] = [],
): void {
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [...commands] }))
  on('tool.list', () => ({ value: [...tools] }))
}

function mockUiApis(on: On, logs: string[] = []): void {
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
}

test('skill listings preserve descriptions and group by the last namespace separator', () => {
  const text = [
    'Available skills:',
    '- superpowers:brainstorming: Creative work before building.',
    '  Continuation for brainstorming.',
    '- hyperframes-registry',
    '- app:video:planner: Plan a video.',
  ].join('\n')
  const items = parseSkillListing(text)

  expect(items.map(item => ({ id: item.id, description: item.description }))).toEqual([
    {
      id: 'skill:superpowers:brainstorming',
      description: 'Creative work before building.',
    },
    { id: 'skill:hyperframes-registry', description: '' },
    { id: 'skill:app:video:planner', description: 'Plan a video.' },
  ])
  expect(skillNamespace('superpowers:brainstorming')).toBe('superpowers')
  expect(skillNamespace('app:video:planner')).toBe('app:video')
  expect(skillNamespace('run')).toBe('Personal & built-in')
  expect(filterSkillListing(text, ['skill:superpowers:*', 'skill:hyperframes-registry'])).toBe(
    ['Available skills:', '- app:video:planner: Plan a video.'].join('\n'),
  )
})

test('MCP instruction filtering removes complete server sections only', () => {
  const text = [
    'The following MCP servers have provided instructions:',
    '## claude.ai Notion',
    'Use Notion carefully.',
    '## Internal heading',
    'This belongs to Notion.',
    '## rea',
    'Use REA carefully.',
  ].join('\n')
  const servers = ['claude_ai_Notion', 'rea']

  expect(parseMcpInstructions(text, servers).map(item => item.id)).toEqual([
    'mcpdoc:claude.ai Notion',
    'mcpdoc:rea',
  ])
  expect(filterMcpInstructions(text, ['mcpdoc:claude.ai Notion'], servers)).toBe([
    'The following MCP servers have provided instructions:',
    '## rea',
    'Use REA carefully.',
  ].join('\n'))
})

test('wildcards and preset fallback still work', () => {
  expect(isHidden('skill:superpowers:brainstorming', ['skill:superpowers:*'])).toBe(true)
  expect(isHidden('skill:run', ['skill:superpowers:*'])).toBe(false)
  expect(resolvePreset(['skill:folder'], ['skill:default'])).toEqual(['skill:folder'])
  expect(resolvePreset(undefined, ['skill:default'])).toEqual(['skill:default'])
})

test('UUID MCP servers derive readable names from their tools', () => {
  const uuid = '86127aa0-546f-4abc-8123-111111111111'
  expect(displayMcpServer(uuid, ['vidiq_balance', 'vidiq_bookmarks_list'])).toBe('vidiq')
  expect(displayMcpServer(uuid, ['create_event', 'list_events'])).toBe(
    'create_event, list_events …',
  )
  expect(displayMcpServer('claude_ai_Notion', ['query'])).toBe('Notion')
})

test('tools are classified from the engine deferral value before overrides', () => {
  const eager = createToolCatalogItem(
    'Write',
    'Writes a file. A second sentence is not shown.',
    undefined,
  )
  const deferred = createToolCatalogItem(
    'mcp__claude_ai_Notion__search',
    'Search Notion. More detail.',
    true,
  )

  expect(eager).toMatchObject({
    id: 'tool:Write',
    tab: 'tools',
    label: 'Write',
    description: 'Writes a file.',
    eager: true,
  })
  expect(deferred).toMatchObject({
    id: 'tool:mcp__claude_ai_Notion__search',
    label: 'search',
    server: 'claude_ai_Notion',
    description: 'Search Notion.',
    eager: false,
  })
})

test('legacy mcptools entries are removed from catalogs and presets', () => {
  expect(sanitizeCatalog([
    { id: 'mcptools:old', group: 'mcp-tool-schemas', label: 'old', tokens: 100 },
    { id: 'skill:one', group: 'skills', label: 'one', tokens: 10 },
  ])).toEqual([{
    id: 'skill:one',
    tab: 'skills',
    label: 'one',
    description: '',
    tokens: 10,
  }])
  expect(migratePatterns(['mcptools:*', 'mcptools:old', 'skill:*'])).toEqual(['skill:*'])
})

test('tab totals count all items but exclude already-on-demand tools from token totals', () => {
  const catalog = [
    { id: 'skill:a', tab: 'skills' as const, label: 'a', description: '', tokens: 40 },
    { id: 'skill:b', tab: 'skills' as const, label: 'b', description: '', tokens: 20 },
    {
      id: 'tool:Write',
      tab: 'tools' as const,
      label: 'Write',
      description: '',
      tokens: 60,
      eager: true,
    },
    {
      id: 'tool:mcp__notion__search',
      tab: 'tools' as const,
      label: 'search',
      description: '',
      tokens: 5_000,
      server: 'notion',
      eager: false,
    },
  ]
  const totals = tabTotals(catalog, ['skill:b', 'tool:Write'])

  expect(totals.skills).toEqual({ count: 2, sentTokens: 40, savedTokens: 20 })
  expect(totals.tools).toEqual({ count: 2, sentTokens: 0, savedTokens: 60 })
})

test('paging reserves a row for controls and clamps the requested page', () => {
  expect(paginate(20, 12, 6, 99)).toEqual({
    page: 3,
    pageCount: 4,
    pageSize: 5,
    start: 15,
    end: 20,
    showPager: true,
  })
  expect(paginate(6, 12, 6, 0).showPager).toBe(false)
})

test('weighted paging keeps two-line desktop items together', () => {
  expect(paginateHeights([3, 2, 2, 3, 2], 12, 4, 0)).toEqual({
    page: 0,
    pageCount: 2,
    start: 0,
    end: 3,
    showPager: true,
  })
})

test('budget bar cells sum to the width and preserve non-zero categories', () => {
  const totals = {
    skills: { count: 2, sentTokens: 1, savedTokens: 0 },
    tools: { count: 2, sentTokens: 70, savedTokens: 10 },
    files: { count: 1, sentTokens: 1, savedTokens: 0 },
    other: { count: 1, sentTokens: 1, savedTokens: 17 },
  }
  const cells = budgetCells(totals, 40)
  const sum = Object.values(cells.sent).reduce((total, value) => total + value, 0) +
    cells.hidden

  expect(sum).toBe(40)
  expect(cells.sent.skills).toBe(1)
  expect(cells.sent.files).toBe(1)
  expect(cells.sent.other).toBe(1)
})

test('scratch workspace paths use the session folder label', () => {
  expect(folderLabel(
    '/home/test/Library/Application Support/Claude/scratch-workspaces/abc/work',
    '/home/test',
  )).toBe("this session's folder")
  expect(folderLabel('/home/test/brain', '/home/test')).toBe('~/brain')
})

test('session start populates known skills from command.list without an attachment', async ($, on) => {
  const logs: string[] = []
  mock.store(on, { 'skills:known': ['superpowers:brainstorming'] })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on, logs)
  mockCatalogApis(on, [{
    name: 'superpowers:brainstorming',
    description: 'Use before creative work.',
    source: 'plugin',
    plugin: 'superpowers',
  }])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/instant-skills', surface: null, isInteractive: false })
  const result = await $.command.run({
    command: 'ctx',
    args: 'list',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(result).toMatchObject({ text: '' })
  expect(logs.at(-1)).toContain('skill:superpowers:brainstorming')
})

test('a real skill listing stays authoritative when the pane reopens', async ($, on) => {
  const logs: string[] = []
  mock.store(on, { 'skills:known': ['one'] })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on, logs)
  mockCatalogApis(on, [{
    name: 'one',
    description: 'A command-list description deliberately much longer than the real listing.',
    source: 'plugin',
    plugin: 'skills',
  }])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

  await $.session.start({ cwd: '/confirmed-skills', surface: null, isInteractive: false })
  await $.prompt.attachment({
    type: 'skill_listing',
    text: '- one: Real skill.',
    origin: { kind: 'engine' },
  })
  await $.command.run({
    command: 'ctx',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  const result = await $.command.run({
    command: 'ctx',
    args: 'list',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(result).toMatchObject({ text: '' })
  expect(logs.at(-1)).toContain('skill:one  ~5')
})

test('session start seeds the global skill registry from old catalogs', async ($, on) => {
  const writes = new Map<string, unknown>()
  on('store.set', { key: 'skills:known' }, (_$, e, next) => {
    writes.set(e.key, e.value)
    return next(e)
  })
  mock.store(on, {
    'catalog:/older-folder': [{
      id: 'skill:hyperframes',
      tab: 'skills',
      label: 'hyperframes',
      description: 'Build motion.',
      tokens: 10,
    }],
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on, [{
    name: 'hyperframes',
    description: 'Build motion.',
    source: 'user',
  }])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/new-folder', surface: null, isInteractive: false })

  expect(writes.get('skills:known')).toEqual(['hyperframes'])
})

test('session start populates tool.list with eager registry classification', async ($, on) => {
  const logs: string[] = []
  mock.store(on, { 'tools:eager': ['mcp__Claude_Browser__click'] })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on, logs)
  mockCatalogApis(on, [], [
    { name: 'Write', description: 'Write a file.', mcp: false },
    { name: 'mcp__Claude_Browser__click', description: 'Click a page.', mcp: true },
    { name: 'mcp__Notion__search', description: 'Search Notion.', mcp: true },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/instant-tools', surface: null, isInteractive: false })
  const result = await $.command.run({
    command: 'ctx',
    args: 'list',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(result).toMatchObject({ text: '' })
  expect(logs.at(-1)).toContain('tool:Write')
  expect(logs.at(-1)).toContain('tool:mcp__Claude_Browser__click')
  expect(logs.at(-1)).toContain('Notion, 1 tools')
})

test('prompt.context filters individual instruction files', async ($, on) => {
  mock.store(on, { 'preset:/context-files': ['file:/context-files/AGENTS.md'] })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.context', (_$, e) => ({
    blocks: e.blocks,
    instructionFiles: e.instructionFiles,
  }))

  await $.session.start({ cwd: '/context-files', surface: null, isInteractive: false })
  const result = await $.prompt.context({
    blocks: [{ name: 'claudeMd', text: 'instructions' }],
    instructionFiles: [
      { path: '/context-files/CLAUDE.md', kind: 'project', content: 'keep this' },
      { path: '/context-files/AGENTS.md', kind: 'project', content: 'hide this' },
    ],
  })

  expect(result.instructionFiles?.map(file => file.path)).toEqual([
    '/context-files/CLAUDE.md',
  ])
})

test('tool.describe records every tool and really defers hidden eager tools', async ($, on) => {
  const logs: string[] = []
  mock.store(on, { 'preset:/tool-deferral': ['tool:Write'] })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on, logs)
  mockCatalogApis(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.describe', (_$, e) => ({
    description: e.description,
    ...(e.isDeferred === true ? { isDeferred: true as const } : {}),
  }))

  await $.session.start({ cwd: '/tool-deferral', surface: null, isInteractive: false })
  const write = await $.tool.describe({
    tool: 'Write',
    description: 'Writes files.',
    provider: { plugin: 'engine', tier: 'core' },
  })
  const notion = await $.tool.describe({
    tool: 'mcp__claude_ai_Notion__search',
    description: 'Search Notion.',
    isDeferred: true,
    provider: { plugin: 'mcp:claude_ai_Notion', tier: 'user' },
  })

  expect(write.isDeferred).toBe(true)
  expect(notion.isDeferred).toBe(true)

  const eager = await $.command.run({
    command: 'ctx',
    args: 'tools',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(eager).toMatchObject({ text: '' })
  expect(logs.at(-1)).toContain('tool:Write')
  // On-demand tools are listed per server so the log line stays short.
  expect(logs.at(-1)).toContain('Notion, 1 tools (available)')
})

test('migration deletes old catalogs and seeds only the small registries', async ($, on) => {
  const writes = new Map<string, unknown>()
  const deletes: string[] = []
  const operations: string[] = []
  for (const key of [
    'catalog:/migration',
    'skills:known',
    'other:items',
    'preset:/migration',
    'preset:default',
  ]) {
    on('store.set', { key }, (_$, e, next) => {
      writes.set(e.key, e.value)
      operations.push(`set:${e.key}`)
      return next(e)
    })
  }
  for (const key of [
    'catalog:/migration',
    'preset:/home/test/Library/Application Support/Claude/scratch-workspaces/gone',
  ]) {
    on('store.delete', { key }, (_$, e, next) => {
      deletes.push(e.key)
      operations.push(`delete:${e.key}`)
      return next(e)
    })
  }
  mock.store(on, {
    'catalog:/migration': [
      { id: 'mcptools:old', group: 'mcp-tool-schemas', label: 'old', tokens: 100 },
      { id: 'skill:one', group: 'skills', label: 'one', tokens: 10 },
      { id: 'hook:context', tab: 'other', label: 'Hook', description: 'Output', tokens: 4 },
    ],
    'preset:/migration': ['mcptools:*', 'skill:one'],
    'preset:default': ['mcptools:old', 'file:*'],
    'preset:/home/test/Library/Application Support/Claude/scratch-workspaces/gone': [],
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/migration', surface: null, isInteractive: false })

  expect(deletes).toContain('catalog:/migration')
  expect(deletes).toContain(
    'preset:/home/test/Library/Application Support/Claude/scratch-workspaces/gone',
  )
  expect(operations.findIndex(operation => operation.startsWith('set:'))).toBeGreaterThan(
    Math.max(...operations.map((operation, index) => operation.startsWith('delete:') ? index : -1)),
  )
  expect([...writes.keys()].some(key => key.startsWith('catalog:'))).toBe(false)
  expect(writes.get('skills:known')).toEqual(['one'])
  expect(writes.get('other:items')).toEqual([{
    id: 'hook:context', tab: 'other', label: 'Hook', description: 'Output', tokens: 4,
  }])
  expect(writes.get('preset:/migration')).toEqual(['skill:one'])
  expect(writes.get('preset:default')).toEqual(['file:*'])
})

test('/ctx hide, show, and only update the folder preset', async ($, on) => {
  const logs: string[] = []
  const presetWrites: unknown[] = []
  on('store.set', { key: 'preset:/commands' }, (_$, e, next) => {
    presetWrites.push(e.value)
    return next(e)
  })
  mock.store(on, {
    'skills:known': ['a', 'b'],
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on, logs)
  mockCatalogApis(on, [
    { name: 'a', description: 'Skill A.', source: 'user' },
    { name: 'b', description: 'Skill B.', source: 'user' },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))

  await $.session.start({ cwd: '/commands', surface: null, isInteractive: false })
  await $.prompt.context({
    blocks: [],
    instructionFiles: [{
      path: '/commands/CLAUDE.md', kind: 'project', content: 'x'.repeat(120),
    }],
  })
  const hideResult = await $.command.run({
    command: 'ctx',
    args: 'hide skill:a',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(presetWrites.at(-1)).toEqual(['skill:a'])
  expect(hideResult).toMatchObject({ text: '' })
  expect(logs.at(-1)).toContain('Now hiding 1 item(s)')

  const showResult = await $.command.run({
    command: 'ctx',
    args: 'show skill:a',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(presetWrites.at(-1)).toEqual([])
  expect(showResult).toMatchObject({ text: '' })
  expect(logs.at(-1)).toContain('Now showing 1 item(s)')

  const onlyResult = await $.command.run({
    command: 'ctx',
    args: 'only skill:b',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(presetWrites.at(-1)).toEqual([
    'file:/commands/CLAUDE.md',
    'skill:a',
  ])
  expect(onlyResult).toMatchObject({ text: '' })
  expect(logs.at(-1)).toContain('Now hiding 2 item(s)')
})

test('hiding survives a full store that rejects every best-effort write', async ($, on) => {
  for (const key of ['skills:known', 'other:items', 'tools:eager']) {
    on('store.set', { key }, () => ({ deny: 'the store is full' }))
  }
  mock.store(on, {
    'preset:/full-store': ['section:memory', 'skill:hidden'],
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('prompt.section', (_$, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/full-store', surface: null, isInteractive: false })
  const skills = await $.prompt.attachment({
    type: 'skill_listing',
    text: ['Available skills:', '- hidden: remove me', '- visible: keep me'].join('\n'),
    origin: { kind: 'engine' },
  })
  const memory = await $.prompt.section({
    name: 'memory',
    text: 'memory text',
  })

  expect(skills.text).toBe(['Available skills:', '- visible: keep me'].join('\n'))
  expect(memory.text).toBe(null)
})

test('/ctx swallows an internal failure, logs it, and never reaches the stub', async ($, on) => {
  const logs: string[] = []
  let stubRuns = 0
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on, logs)
  mockCatalogApis(on)
  on('ui.open', () => ({ deny: 'pane failed' }))
  on('command.run', { command: 'ctx' }, () => {
    stubRuns += 1
    return { text: 'stub ran' }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/command-error', surface: null, isInteractive: false })
  const result = await $.command.run({
    command: 'ctx',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(result).toMatchObject({ text: '' })
  expect(stubRuns).toBe(0)
  expect(logs.some(line => line.startsWith('ctx-control: '))).toBe(true)
})

test('blocked deferred names are removed exactly and ToolSearch carries a context note', async ($, on) => {
  mock.store(on, {
    'preset:/deferred-blocks': ['block:Write', 'block:mcp__vidiq__*'],
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on, [], [
    { name: 'mcp__vidiq__search', description: 'Search vidIQ.', mcp: true },
    { name: 'mcp__other__ping', description: 'Ping another server.', mcp: true },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'ToolSearch' }, (_$, e) => ({
    result: {
      matches: ['Write', 'Read', 'mcp__vidiq__search'],
      query: e.query,
      total_deferred_tools: 3,
    },
  }))

  await $.session.start({ cwd: '/deferred-blocks', surface: null, isInteractive: false })
  const delta = await $.prompt.attachment({
    type: 'deferred_tools_delta',
    text: ['Deferred tools:', 'Write', '  Write  ', 'Read', 'Write extra', 'mcp__vidiq__search'].join('\n'),
    origin: { kind: 'engine' },
  })
  expect(delta.text).toBe(['Deferred tools:', 'Read', 'Write extra'].join('\n'))

  const instructions = await $.prompt.attachment({
    type: 'mcp_instructions_delta',
    text: ['MCP instructions:', '## vidiq', 'Blocked docs.', '## other', 'Allowed docs.'].join('\n'),
    origin: { kind: 'engine' },
  })
  expect(instructions.text).toBe(['MCP instructions:', '## other', 'Allowed docs.'].join('\n'))

  const search = await $.tool.call({ tool: 'ToolSearch', query: 'tools', max_results: 5 })
  expect('result' in search && search.result).toMatchObject({ matches: ['Read'] })
  expect('result' in search ? search.context?.[0] : undefined).toContain(
    'ctx-control blocked these tools in this folder: Write, mcp__vidiq__search.',
  )
})

test('tool.check fails closed for blocked built-ins, MCP tools, and later server tools', async ($, on) => {
  mock.store(on, {
    'preset:/tool-blocks': ['block:Write', 'block:mcp__future__*'],
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.describe', (_$, e) => ({
    description: e.description,
    ...(e.isDeferred === true ? { isDeferred: true as const } : {}),
  }))

  await $.session.start({ cwd: '/tool-blocks', surface: null, isInteractive: false })
  expect(await $.tool.check({ tool: 'Write', input: {} })).toMatchObject({
    decision: 'deny', reason: 'Blocked in this folder by ctx-control. The user can unblock it with /ctx.',
  })
  expect(await $.tool.check({ tool: 'mcp__future__new_tool', input: {} })).toMatchObject({
    decision: 'deny',
  })
  expect(await $.tool.check({ tool: 'Read', input: {} })).toMatchObject({ decision: 'allow' })

  const write = await $.tool.describe({
    tool: 'Write', description: 'Writes files.', provider: { plugin: 'engine', tier: 'core' },
  })
  const later = await $.tool.describe({
    tool: 'mcp__future__new_tool',
    description: 'A tool first seen after the block.',
    provider: { plugin: 'mcp:future', tier: 'user' },
  })
  expect(write.isDeferred).toBe(true)
  expect(later.isDeferred).toBe(true)
})

test('/ctx block maps a readable server label to its wildcard pattern', async ($, on) => {
  const logs: string[] = []
  const writes: unknown[] = []
  on('store.set', { key: 'preset:/block-command' }, (_$, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on, logs)
  mockCatalogApis(on, [], [
    { name: 'mcp__86127aa0-546f-4abc-8123-111111111111__vidiq_balance', description: 'Balance.', mcp: true },
    { name: 'mcp__86127aa0-546f-4abc-8123-111111111111__vidiq_bookmarks', description: 'Bookmarks.', mcp: true },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/block-command', surface: null, isInteractive: false })
  const result = await $.command.run({
    command: 'ctx', args: 'block vidiq', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(result).toMatchObject({ text: '' })
  expect(writes.at(-1)).toEqual([
    'block:mcp__86127aa0-546f-4abc-8123-111111111111__*',
  ])
  expect(logs.at(-1)).toBe(
    'Blocked vidiq (2 tools) in this folder. Applies from your next message.',
  )
})

test('the Context pane renders every tab on every supported surface', async ($, on) => {
  mock.store(on, {
    'skills:known': ['superpowers:brainstorming'],
    'catalog:/pane': [
      {
        id: 'skill:superpowers:brainstorming',
        tab: 'skills',
        label: 'superpowers:brainstorming',
        description: 'Creative work before building.',
        tokens: 120,
      },
      {
        id: 'tool:Write',
        tab: 'tools',
        label: 'Write',
        description: 'Writes files.',
        tokens: 90,
        eager: true,
      },
      {
        id: 'tool:mcp__claude_ai_Notion__search',
        tab: 'tools',
        label: 'search',
        description: 'Search Notion.',
        tokens: 80,
        server: 'claude_ai_Notion',
        eager: false,
      },
      {
        id: 'file:/pane/CLAUDE.md',
        tab: 'files',
        label: '/pane/CLAUDE.md',
        description: 'project',
        kind: 'project',
        tokens: 70,
      },
      {
        id: 'mcpdoc:Notion',
        tab: 'other',
        label: 'Notion',
        description: 'MCP server instructions',
        tokens: 60,
      },
    ],
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on, [{
    name: 'superpowers:brainstorming',
    description: 'Creative work before building.',
    source: 'plugin',
    plugin: 'superpowers',
  }], [
    { name: 'Write', description: 'Writes files.', mcp: false },
    {
      name: 'mcp__claude_ai_Notion__search',
      description: 'Search Notion.',
      mcp: true,
    },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  await $.session.start({ cwd: '/pane', surface: null, isInteractive: false })
  await $.prompt.context({
    blocks: [],
    instructionFiles: [{
      path: '/pane/CLAUDE.md', kind: 'project', content: 'context',
    }],
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ctx-control',
      surface,
      component: 'Pane',
      requestId: 'ctx-control',
      viewport: { columns: 140, rows: 60, isFullscreen: true },
      props: {
        title: 'Context',
        isFocused: false,
        bodyColumns: 100,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 54 },
        view: {},
      },
    })

    await ui.press({ key: 'tab:skills' })
    expect(await ui.find({ key: 'item:skill:superpowers:brainstorming' })).toBeDefined()
    await ui.press({ key: 'tab:tools' })
    expect(await ui.find({ key: 'group:tool:eager:Built-in' })).toBeDefined()
    expect(await ui.find({ key: 'group:tool:deferred:claude_ai_Notion' })).toBeDefined()
    await ui.press({ key: 'tab:files' })
    expect(await ui.find({ key: 'item:file:/pane/CLAUDE.md' })).toBeDefined()
    await ui.press({ key: 'tab:other' })
    expect(await ui.find({ key: 'item:mcpdoc:Notion' })).toBeDefined()
    await ui.unmount()
  }
})

test('legend tabs and paged rows fit terminal and desktop at 40 and 100 columns', async ($, on) => {
  const cwd = '/pane-layout/with-a-very-long-folder-name'
  const skillNames = Array.from(
    { length: 12 },
    (_value, index) => `artifact-capabilities-${index}-with-an-extremely-long-name`,
  )
  const commands = skillNames.map(name => ({
    name,
    description: 'A deliberately long description that must truncate without wrapping onto another row.',
    source: 'plugin' as const,
    plugin: 'artifacts',
  }))
  const eagerTools = Array.from({ length: 10 }, (_value, index) => ({
    name: `ExtremelyLongBuiltinToolName${index}`,
    description: 'A deliberately long eager-tool description that must remain on the same row.',
    mcp: false,
  }))
  const deferredTools = Array.from({ length: 3 }, (_value, index) => ({
    name: `mcp__claude_ai_Notion__very_long_deferred_tool_name_${index}`,
    description: 'A deferred tool description.',
    mcp: true,
  }))
  mock.store(on, {
    'skills:known': skillNames,
    [`catalog:${cwd}`]: [
      {
        id: 'file:/pane-layout/CLAUDE.md',
        tab: 'files',
        label: '/pane-layout/CLAUDE.md',
        description: 'project',
        tokens: 70,
      },
      {
        id: 'mcpdoc:Notion',
        tab: 'other',
        label: 'Notion',
        description: 'MCP server instructions',
        tokens: 60,
      },
    ],
  })
  mock.env(on, { HOME: '/home/test' })
  mockCatalogApis(on, commands, [...eagerTools, ...deferredTools])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd, surface: null, isInteractive: false })

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [40, 100] as const) {
      const bodyRows = 16
      const contentColumns = bodyColumns - (surface === 'terminal' ? 2 : 4)
      const ui = await $.ui.mount({
        plugin: 'ctx-control',
        surface,
        component: 'Pane',
        requestId: 'ctx-control',
        viewport: { columns: 160, rows: 80, isFullscreen: true },
        props: {
          title: 'Context',
          isFocused: false,
          bodyColumns,
          placement: 'dock',
          scroll: { offset: 0, bodyRows },
          view: {},
        },
      })

      for (const tab of ['skills', 'tools'] as const) {
        await ui.press({ key: `tab:${tab}` })

        expect((await ui.find({ key: 'headline' }))?.text).toContain(
          'ride along with every message',
        )
        expect((await ui.find({ key: 'budget-bar' }))?.text.length).toBe(contentColumns)
        expect((await ui.find({ key: 'tab-bar' }))?.props).toMatchObject({
          flexWrap: 'wrap',
          width: contentColumns,
        })
        for (const name of ['skills', 'tools', 'files', 'other']) {
          const legend = await ui.find({ key: `tab-wrap:${name}` })
          const button = await ui.find({ key: `tab:${name}` })
          expect(legend).toBeDefined()
          expect((legend?.text.length ?? 0) <= contentColumns).toBe(true)
          expect(button?.text.includes('·')).toBe(false)
        }

        expect(await ui.find({ key: 'page-controls' })).toBeDefined()
        const boxes = await ui.findAll({ type: 'Box' })
        // No bordered rows; only the floating hover cards carry a border.
        expect(boxes.some(box => box.props.borderStyle !== undefined && box.props.position !== 'absolute')).toBe(false)
        expect(boxes.every(box =>
          typeof box.props.width !== 'number' || box.props.width <= bodyColumns,
        )).toBe(true)
        const paneRows = boxes.filter(box =>
          box.key !== undefined && /^(?:item|group|section|caption|summary):/.test(box.key),
        )
        expect(paneRows.length > 0).toBe(true)
        for (const row of paneRows) {
          expect(row.text.includes('\n')).toBe(false)
        }
      }
      await ui.unmount()
    }
  }
})

test('Tools pane shows both sections, state marks, and collapsed server controls at narrow widths', async ($, on) => {
  mock.store(on, {
    'preset:/tool-pane': [
      'tool:Write',
      'block:mcp__claude_ai_Notion__*',
    ],
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on, [], [
    { name: 'Bash', description: 'Runs commands.', mcp: false },
    { name: 'Write', description: 'Writes files.', mcp: false },
    { name: 'mcp__claude_ai_Notion__search', description: 'Search Notion.', mcp: true },
    { name: 'mcp__claude_ai_Notion__fetch', description: 'Fetch Notion.', mcp: true },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tool-pane', surface: null, isInteractive: false })

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [40, 100] as const) {
      const ui = await $.ui.mount({
        plugin: 'ctx-control',
        surface,
        component: 'Pane',
        requestId: 'ctx-control',
        viewport: { columns: 140, rows: 100, isFullscreen: true },
        props: {
          title: 'Context',
          isFocused: false,
          bodyColumns,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 80 },
          view: {},
        },
      })
      await ui.press({ key: 'tab:tools' })

      expect((await ui.find({ key: 'tools-footnote' }))?.text).toContain(
        "Blocked tools can't be searched for or called.",
      )
      expect((await ui.find({ key: 'section:sent' }))?.text).toContain('Sent with every message')
      expect((await ui.find({ key: 'section:demand' }))?.text).toContain('On demand')
      expect((await ui.find({ key: 'item:tool:Bash' }))?.text).toContain('●')
      expect((await ui.find({ key: 'item:tool:Write' }))?.text).toContain('◐')
      const groupKey = 'group:tool:deferred:claude_ai_Notion'
      expect((await ui.find({ key: `${groupKey}:toggle` }))?.text).toContain('Blocked')
      if (await ui.find({ key: 'item:tool:mcp__claude_ai_Notion__search' }) === undefined) {
        await ui.press({ key: `${groupKey}:expand` })
      }
      expect((await ui.find({ key: 'item:tool:mcp__claude_ai_Notion__search' }))?.text).toContain('✕')

      const boxes = await ui.findAll({ type: 'Box' })
      expect(boxes.every(box =>
        typeof box.props.width !== 'number' || box.props.width <= bodyColumns,
      )).toBe(true)
      for (const row of boxes.filter(box => box.key?.startsWith('group:tool:') === true || box.key?.startsWith('item:tool:') === true)) {
        expect(row.text.includes('\n')).toBe(false)
      }
      await ui.unmount()
    }
  }
})

test('a tool group\'s Block all button blocks or unblocks every tool in it at once', async ($, on) => {
  const writes: string[][] = []
  on('store.set', { key: 'preset:/group-all' }, (_$, e, next) => {
    writes.push(e.value as string[])
    return next(e)
  })
  mock.store(on, { 'preset:/group-all': ['tool:Write'] })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on, [], [
    { name: 'Bash', description: 'Runs commands.', mcp: false },
    { name: 'Write', description: 'Writes files.', mcp: false },
    { name: 'mcp__claude_ai_Notion__search', description: 'Search Notion.', mcp: true },
    { name: 'mcp__claude_ai_Notion__fetch', description: 'Fetch Notion.', mcp: true },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/group-all', surface: null, isInteractive: false })

  const ui = await $.ui.mount({
    plugin: 'ctx-control',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ctx-control',
    viewport: { columns: 140, rows: 100, isFullscreen: true },
    props: {
      title: 'Context',
      isFocused: false,
      bodyColumns: 100,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 80 },
      view: {},
    },
  })
  await ui.press({ key: 'tab:tools' })
  const notion = 'group:tool:deferred:claude_ai_Notion'
  const builtIn = 'group:tool:eager:Built-in'
  // Preset changes redraw through $.ui.invalidate, which a mounted test tree doesn't follow.
  const redraw = async () => {
    await ui.press({ key: 'tab:skills' })
    await ui.press({ key: 'tab:tools' })
  }

  expect((await ui.find({ key: `${notion}:all` }))?.text).toContain('Block all')
  await ui.press({ key: `${notion}:all` })
  expect([...writes.at(-1) ?? []].sort()).toEqual(['tool:Write', 'block:mcp__claude_ai_Notion__*'].sort())
  await redraw()
  expect((await ui.find({ key: `${notion}:toggle` }))?.text).toContain('Blocked')
  expect((await ui.find({ key: `${notion}:all` }))?.text).toContain('Unblock all')

  await ui.press({ key: `${notion}:all` })
  expect(writes.at(-1)).toEqual(['tool:Write'])
  await redraw()
  expect((await ui.find({ key: `${notion}:toggle` }))?.text).toContain('Available')

  // Unblocking a built-in group keeps Write on demand rather than sending it again.
  await ui.press({ key: `${builtIn}:all` })
  expect([...writes.at(-1) ?? []].sort()).toEqual(['tool:Write', 'block:Bash', 'block:Write'].sort())
  await redraw()
  expect((await ui.find({ key: `${builtIn}:all` }))?.text).toContain('Unblock all')
  await ui.press({ key: `${builtIn}:all` })
  expect(writes.at(-1)).toEqual(['tool:Write'])
  await ui.unmount()
})

test('UUID MCP doc sections get readable names from their own text', () => {
  const text = [
    'The following MCP servers have provided instructions for how to use their tools and resources:',
    '',
    '## 1a59c906-04da-521d-bda7-7f71b9f9e01c',
    'Claude Docs: living docs you create and edit here. A docs skill your client lists loads first.',
    '',
    '## b8a1ebca-506f-462a-9a04-0a50afcd0e00',
    '',
    '## Todoist Task and Project Management Tools',
    '',
    'You have access to comprehensive Todoist management tools for personal productivity.',
    '',
    '### Core Capabilities:',
    '- Create, update, complete, and search tasks',
    '',
    '## e88f46bd-2080-4560-a3d6-be32db168ee7',
    'Use the Notion search tool for every content search.',
    'This Notion connection stores useful chat work in pages and databases. Recommend Notion for work.',
    '',
    '## 6f616b42-0ed8-571e-823f-ee4aca6b7ce9',
    'call it before drawing anything.',
    '',
    '## rea',
    'REA provides reverse-engineering tools.',
  ].join('\n')
  const servers = [
    '1a59c906-04da-521d-bda7-7f71b9f9e01c',
    'b8a1ebca-506f-462a-9a04-0a50afcd0e00',
    'e88f46bd-2080-4560-a3d6-be32db168ee7',
    '6f616b42-0ed8-571e-823f-ee4aca6b7ce9',
    'rea',
  ]
  const items = parseMcpInstructions(text, servers)
  expect(items.map(item => item.label)).toEqual(['Claude Docs', 'Todoist', 'Notion', 'Connector 6f616b42', 'rea'])
  expect(items.map(item => item.id)).toEqual(servers.map(server => `mcpdoc:${server}`))
  expect(items[2]?.description).toBe('Use the Notion search tool for every content search.')
  expect(guessMcpServerName('rea', 'anything')).toBe('rea')
})

// Claude Code's breakdown as a probe mod read it on 2026-10-19 (build 2.1.304), trimmed.
const PROBE_BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3663, kind: 'used' },
    { name: 'System tools', tokens: 19276, kind: 'used' },
    { name: 'MCP tools', tokens: 807, kind: 'used' },
    { name: 'MCP server instructions', tokens: 2780, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 343585, kind: 'deferred' },
    { name: 'System tools (deferred)', tokens: 34303, kind: 'deferred' },
    { name: 'Custom agents', tokens: 2711, kind: 'used' },
    { name: 'Memory files', tokens: 1061, kind: 'used' },
    { name: 'Skills', tokens: 9961, kind: 'used' },
    { name: 'Messages', tokens: 1160, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { name: 'Free space', tokens: 925581, kind: 'free' },
  ],
  memoryFiles: [{ path: '/home/test/.claude/CLAUDE.md', tokens: 1061 }],
  mcpTools: [
    { name: 'mcp__claude_ai_Claude_Docs__batch', tokens: 198, isLoaded: true },
    { name: 'mcp__claude_ai_Claude_Docs__guide', tokens: 251, isLoaded: true },
    { name: 'mcp__claude_ai_Claude_Docs__update', tokens: 358, isLoaded: true },
    { name: 'mcp__claude_ai_vidIQ__vidiq_balance', tokens: 1400, isLoaded: false },
  ],
  agents: [{ tokens: 2000 }, { tokens: 711 }],
  skills: {
    skillFrontmatter: [
      { name: 'agent-run-audit', tokens: 189 },
      { name: 'dataviz', tokens: 9772 },
    ],
  },
}
const PROBE_USED = 41419

function usageWith(breakdown: typeof PROBE_BREAKDOWN): SessionUsage {
  return {
    startedAt: 0,
    context: { window: 1_000_000, breakdown },
    rateLimits: [],
  } as unknown as SessionUsage
}

test('Claude Code counts replace estimates and the headline equals its used total', () => {
  const counts = engineCountsFrom(PROBE_BREAKDOWN)
  expect(counts.used).toBe(PROBE_USED)
  expect(counts.mcpTools['mcp__claude_ai_vidIQ__vidiq_balance']).toBeUndefined()

  const item = (id: string, tab: 'skills' | 'tools' | 'files' | 'other', tokens: number, extra = {}) => ({
    id, tab, label: id.replace(/^[a-z]+:/, ''), description: '', tokens, ...extra,
  })
  const catalog = applyEngineCounts([
    item('skill:agent-run-audit', 'skills', 50),
    item('skill:dataviz', 'skills', 300),
    item('tool:Bash', 'tools', 100, { eager: true }),
    item('tool:Read', 'tools', 300, { eager: true }),
    item('tool:mcp__claude_ai_Claude_Docs__batch', 'tools', 5, { eager: true, server: 'claude_ai_Claude_Docs' }),
    item('tool:mcp__claude_ai_vidIQ__vidiq_balance', 'tools', 900, { eager: false, server: 'claude_ai_vidIQ' }),
    item('file:/home/test/.claude/CLAUDE.md', 'files', 900),
    item('mcpdoc:claude.ai Claude Docs', 'other', 100),
    item('attachment:agent_listing_delta', 'other', 400),
  ], counts)
  const tokensOf = (id: string) => catalog.find(entry => entry.id === id)?.tokens

  expect(tokensOf('skill:dataviz')).toBe(9772)
  expect(tokensOf('file:/home/test/.claude/CLAUDE.md')).toBe(1061)
  expect(tokensOf('tool:mcp__claude_ai_Claude_Docs__batch')).toBe(198)
  expect((tokensOf('tool:Bash') ?? 0) + (tokensOf('tool:Read') ?? 0)).toBe(19276)
  expect(catalog.find(entry => entry.id === 'tool:Bash')?.approximate).toBe(true)
  expect(tokensOf('tool:mcp__claude_ai_vidIQ__vidiq_balance'))
    .toBe(deferredNameTokens('mcp__claude_ai_vidIQ__vidiq_balance'))
  expect(tokensOf('mcpdoc:claude.ai Claude Docs')).toBe(2780)
  expect(tokensOf('attachment:agent_listing_delta')).toBe(2711)

  const open = contextSummary(catalog, [], counts)
  expect(open.fromEngine).toBe(true)
  expect(open.total).toBe(PROBE_USED)
  expect(open.fixed).toBe(PROBE_USED - open.tabsSent)

  const hiding = contextSummary(catalog, ['skill:dataviz', 'file:/home/test/.claude/CLAUDE.md'], counts)
  expect(hiding.saved).toBe(9772 + 1061)
  expect(hiding.total).toBe(PROBE_USED - 9772 - 1061)
  expect(hiding.fixed).toBe(open.fixed)

  const estimated = contextSummary(catalog, [], undefined)
  expect(estimated).toMatchObject({ fromEngine: false, fixed: 0 })
  expect(estimated.total).toBe(estimated.tabsSent)
})

test('apportioned parts and bar cells always add up', () => {
  expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3])
  expect(apportion(19276, [100, 300]).reduce((sum, part) => sum + part, 0)).toBe(19276)
  expect(apportion(7, [0, 0])).toEqual([4, 3])

  const totals = {
    skills: { count: 2, sentTokens: 9961, savedTokens: 0 },
    tools: { count: 2, sentTokens: 19474, savedTokens: 0 },
    files: { count: 1, sentTokens: 1061, savedTokens: 0 },
    other: { count: 1, sentTokens: 5491, savedTokens: 0 },
  }
  for (const width of [5, 40, 96]) {
    const cells = budgetCells(totals, width, 5432)
    const sum = Object.values(cells.sent).reduce((total, value) => total + value, 0) +
      cells.fixed + cells.hidden
    expect(sum).toBe(width)
    expect(cells.fixed >= (width >= 5 ? 1 : 0)).toBe(true)
  }
})

function mockPaneSession(
  on: On,
  cwd: string,
  store: Record<string, unknown> = {},
  tools: readonly ToolInfo[] = [
    { name: 'Bash', description: 'Runs commands.', mcp: false },
    { name: 'Read', description: 'Reads files.', mcp: false },
  ],
): void {
  mock.store(on, { 'skills:known': ['agent-run-audit', 'dataviz'], ...store })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on, [
    { name: 'agent-run-audit', description: 'Measure agent runs.', source: 'user' },
    { name: 'dataviz', description: 'Charts.', source: 'builtin' },
  ], tools)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  void cwd
}

const DESKTOP_PROPS = {
  title: 'Context',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

test('the pane adds a Fixed segment from Claude Code and explains hidden items', async ($, on) => {
  mockPaneSession(on, '/fixed')
  on('session.usage', () => ({ value: usageWith(PROBE_BREAKDOWN) }))
  await $.session.start({ cwd: '/fixed', surface: null, isInteractive: false })

  const mount = () => $.ui.mount({
    plugin: 'ctx-control',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'ctx-control',
    viewport: { columns: 140, rows: 70, isFullscreen: true },
    props: DESKTOP_PROPS,
  })
  // Skills 9,961, the two built-ins sharing System tools 19,276 and the memory file 1,061
  // (listed under Files before any message); the rest is fixed.
  const fixed = PROBE_USED - 9961 - 19276 - 1061
  let ui = await mount()
  expect((await ui.find({ key: 'tab:files' }))?.text).toContain(`Files ${formatTokens(1061)}`)
  expect((await ui.find({ key: 'headline' }))?.text).toContain(`${formatTokens(PROBE_USED)} tokens`)
  expect((await ui.find({ key: 'legend:fixed' }))?.text).toContain(`Fixed ${formatTokens(fixed)}`)
  expect(await ui.find({ key: 'panel-note' })).toBeUndefined()
  expect((await ui.find({ key: 'budget-bar' }))?.text.length).toBe(96)
  await ui.unmount()

  await $.command.run({
    command: 'ctx',
    args: 'hide skill:dataviz',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  ui = await mount()
  expect((await ui.find({ key: 'headline' }))?.text).toContain(`${formatTokens(PROBE_USED - 9772)} tokens`)
  expect((await ui.find({ key: 'panel-note' }))?.text).toContain("Claude Code's Context panel still counts hidden items")
  await ui.unmount()
})

test('without Claude Code counts the pane falls back to estimates', async ($, on) => {
  mockPaneSession(on, '/estimates')
  on('session.usage', () => { throw new Error('no session bound') })
  await $.session.start({ cwd: '/estimates', surface: null, isInteractive: false })
  const ui = await $.ui.mount({
    plugin: 'ctx-control',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'ctx-control',
    viewport: { columns: 140, rows: 70, isFullscreen: true },
    props: DESKTOP_PROPS,
  })
  expect((await ui.find({ key: 'headline' }))?.text).toContain('tokens')
  expect(await ui.find({ key: 'legend:fixed' })).toBeUndefined()
  await ui.unmount()
})

test('Other items from an earlier session show but are not counted', async ($, on) => {
  mockPaneSession(on, '/stale', {
    'other:items': [
      { id: 'mcpdoc:Notion', tab: 'other', label: 'Notion', description: 'Notion docs', tokens: 60 },
      { id: 'mcpdoc:rea', tab: 'other', label: 'rea', description: 'REA docs', tokens: 40 },
    ],
  }, [{ name: 'mcp__rea__open', description: 'Open.', mcp: true }])
  await $.session.start({ cwd: '/stale', surface: null, isInteractive: false })
  const ui = await $.ui.mount({
    plugin: 'ctx-control',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'ctx-control',
    viewport: { columns: 140, rows: 70, isFullscreen: true },
    props: DESKTOP_PROPS,
  })
  expect((await ui.find({ key: 'tab:other' }))?.text).toContain('Other 40')
  await ui.press({ key: 'tab:other' })
  expect((await ui.find({ key: 'item:mcpdoc:Notion' }))?.text).toContain('Seen in an earlier session')
  expect((await ui.find({ key: 'item:mcpdoc:rea' }))?.text).toContain('REA docs')
  await ui.unmount()
})

test('long names get a hover card with the full name; short ones do not', async ($, on) => {
  const longName = 'superpowers:a-skill-whose-name-is-far-too-long-to-fit-in-a-narrow-context-pane-even-at-one-hundred-columns'
  mock.store(on, { 'skills:known': [longName, 'tiny'] })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on, [
    { name: longName, description: 'Does a long thing.', source: 'plugin', plugin: 'superpowers' },
    { name: 'tiny', description: 'Short.', source: 'user' },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/hover', surface: null, isInteractive: false })

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [40, 100] as const) {
      const ui = await $.ui.mount({
        plugin: 'ctx-control',
        surface,
        component: 'Pane',
        requestId: 'ctx-control',
        viewport: { columns: 160, rows: 80, isFullscreen: true },
        props: { ...DESKTOP_PROPS, bodyColumns },
      })
      expect(await ui.find({ key: `hover:item:skill:${longName}` })).toBeDefined()
      expect((await ui.find({ key: `item:skill:${longName}` }))?.text.includes(longName)).toBe(false)
      const cards = (await ui.findAll({ type: 'Box' })).filter(box =>
        box.props.position === 'absolute' && box.props.display === 'none')
      expect(cards.some(card => card.text.includes(longName))).toBe(true)
      // Cards are drawn after every row, so no row paints over an open card.
      const rows = (await ui.find({ key: 'rows' }))?.text ?? ''
      expect(rows.lastIndexOf(longName)).toBeGreaterThan(rows.indexOf('Previous'))
      for (const card of cards) {
        // `hover` travels beside `props` in the render tree, so the kit's props don't show it.
        expect(card.props.width as number).toBeLessThanOrEqual(bodyColumns)
        expect(card.key).toBeUndefined()
        // A theme-matched surface with a border, not an inverted block.
        expect(card.props.backgroundColor).toBe('inverseText')
        expect(card.props.borderStyle).toBe('round')
      }
      if (bodyColumns === 100 && surface === 'desktop') {
        expect(await ui.find({ key: 'hover:item:skill:tiny' })).toBeUndefined()
      }
      await ui.unmount()
    }
  }
})

test('a long file path gets a card that stays inside the list', async ($, on) => {
  const mountFiles = async (paths: readonly string[]) => {
    const breakdown = { ...PROBE_BREAKDOWN, memoryFiles: paths.map(path => ({ path, tokens: 500 })) }
    on('session.usage', () => ({ value: usageWith(breakdown as typeof PROBE_BREAKDOWN) }))
    await $.session.start({ cwd: '/files-hover', surface: null, isInteractive: false })
    const ui = await $.ui.mount({
      plugin: 'ctx-control', surface: 'desktop', component: 'Pane', requestId: 'ctx-control',
      viewport: { columns: 140, rows: 70, isFullscreen: true },
      props: { ...DESKTOP_PROPS, bodyColumns: 45 },
    })
    await ui.press({ key: 'tab:files' })
    return ui
  }
  mockPaneSession(on, '/files-hover')
  const memory = '/home/test/.claude/projects/-Users-someone/memory/MEMORY.md'

  // One long path: too short a list for its card below or above, so blank room holds it.
  const one = await mountFiles([memory])
  expect(await one.find({ key: `hover:item:file:${memory}` })).toBeDefined()
  const cards = (await one.findAll({ type: 'Box' })).filter(box => box.props.position === 'absolute')
  expect(cards.some(card => card.text.includes('~/.claude/projects/-Users-someone/memory/MEMORY.md'))).toBe(true)
  expect(await one.find({ key: 'card-room' })).toBeDefined()
  await one.unmount()
})

test('stored profiles are parsed defensively and found by name in any case', () => {
  const profiles = parseProfiles({
    Coding: ['block:mcp__vidiq__*', 'mcptools:old', 'skill:a'],
    Broken: 'not a list',
    save: ['skill:b'],
    '': ['skill:c'],
  })
  expect(profiles).toEqual({ Coding: ['block:mcp__vidiq__*', 'skill:a'] })
  expect(parseProfiles(['Coding'])).toEqual({})
  expect(findProfile(profiles, 'coding')).toBe('Coding')
  expect(findProfile(profiles, 'Editing')).toBeUndefined()
  expect(profileNameError('Video editing')).toBeUndefined()
  expect(profileNameError(' ')).toBe('Give the profile a name.')
  expect(profileNameError('Delete')).toContain('/ctx profile command')
  expect(profileNameError('x'.repeat(33))).toContain('32 characters')
  expect(presetDiffers(['b', 'a'], ['a', 'b'])).toBe(false)
  expect(presetDiffers(['a'], ['a', 'b'])).toBe(true)
})

// Answers $.store from a map the test can read; a deleted key is gone from it.
function memoryStore(on: On, entries: Readonly<Record<string, unknown>> = {}): Map<string, unknown> {
  const stored = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    stored.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...stored.keys()] }))
  return stored
}

async function runCtx($: Engine, args: string): Promise<void> {
  await $.command.run({
    command: 'ctx', args, origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

test('/ctx profile saves, switches, reports changes, renames, and deletes profiles', async ($, on) => {
  const logs: string[] = []
  const stored = memoryStore(on, { 'preset:/profiles': ['block:mcp__vidiq__*'] })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on, logs)
  mockCatalogApis(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/profiles', surface: null, isInteractive: false })

  await runCtx($, 'profile')
  expect(logs.at(-1)).toContain('No profiles yet')

  await runCtx($, 'profile save Coding')
  expect(logs.at(-1)).toBe('Saved profile Coding (1 rule(s)); this folder uses it.')
  expect(stored.get('profiles')).toEqual({ Coding: ['block:mcp__vidiq__*'] })
  expect(stored.get('profile:/profiles')).toBe('Coding')

  await runCtx($, 'block mcp__tella__*')
  await runCtx($, 'profile')
  expect(logs.at(-1)).toContain('Coding, 1 rule(s) (in use, changed)')
  await runCtx($, 'profile save "Video editing"')
  expect(stored.get('profiles')).toEqual({
    Coding: ['block:mcp__vidiq__*'],
    'Video editing': ['block:mcp__tella__*', 'block:mcp__vidiq__*'],
  })

  await runCtx($, 'profile coding')
  expect(logs.at(-1)).toBe('Using profile Coding in this folder; applies from the next message.')
  expect(stored.get('preset:/profiles')).toEqual(['block:mcp__vidiq__*'])
  expect(stored.get('profile:/profiles')).toBe('Coding')

  await runCtx($, 'profile rename coding "Deep work"')
  expect(Object.keys(stored.get('profiles') as object).sort()).toEqual(['Deep work', 'Video editing'])
  expect(stored.get('profile:/profiles')).toBe('Deep work')

  await runCtx($, 'profile delete "deep work"')
  expect(logs.at(-1)).toBe('Deleted profile Deep work. This folder keeps its current settings.')
  expect(stored.get('profile:/profiles')).toBeUndefined()
  expect(stored.get('preset:/profiles')).toEqual(['block:mcp__vidiq__*'])

  await runCtx($, 'profile "Video editing"')
  await runCtx($, 'profile none')
  expect(stored.get('preset:/profiles')).toBeUndefined()
  expect(stored.get('profile:/profiles')).toBeUndefined()
})

test('a folder\'s profile is applied again at session start, so saved changes reach every folder', async ($, on) => {
  const stored = memoryStore(on, {
    profiles: { Coding: ['block:mcp__vidiq__*', 'block:mcp__tella__*'] },
    'profile:/coding-folder': 'Coding',
    'preset:/coding-folder': ['block:mcp__vidiq__*'],
    'profile:/gone-folder': 'Deleted profile',
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.check', () => ({ decision: 'allow' }))

  await $.session.start({ cwd: '/coding-folder', surface: null, isInteractive: false })
  expect(stored.get('preset:/coding-folder')).toEqual(['block:mcp__tella__*', 'block:mcp__vidiq__*'])
  expect(await $.tool.check({ tool: 'mcp__tella__list_videos', input: {} })).toMatchObject({ decision: 'deny' })

  await $.session.start({ cwd: '/gone-folder', surface: null, isInteractive: false })
  expect(stored.get('profile:/gone-folder')).toBeUndefined()
})

test('the pane picks, creates, saves, reverts, and deletes profiles', async ($, on) => {
  const stored = memoryStore(on, {
    profiles: { Coding: ['block:mcp__vidiq__*'], Editing: ['block:mcp__rea__*'] },
  })
  mock.env(on, { HOME: '/home/test' })
  mockUiApis(on)
  mockCatalogApis(on, [], [
    { name: 'mcp__vidiq__search', description: 'Search vidIQ.', mcp: true },
    { name: 'mcp__rea__open', description: 'Open a binary.', mcp: true },
  ])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  for (const surface of ['terminal', 'desktop'] as const) {
    stored.clear()
    stored.set('profiles', { Coding: ['block:mcp__vidiq__*'], Editing: ['block:mcp__rea__*'] })
    await $.session.start({ cwd: '/pane-profiles', surface: null, isInteractive: false })
    const ui = await $.ui.mount({
      plugin: 'ctx-control',
      surface,
      component: 'Pane',
      requestId: 'ctx-control',
      viewport: { columns: 140, rows: 100, isFullscreen: true },
      props: {
        title: 'Context',
        isFocused: false,
        bodyColumns: 100,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 80 },
        view: {},
      },
    })
    // Profile changes redraw through $.ui.invalidate, which a mounted test tree doesn't follow.
    const redraw = async () => {
      await ui.press({ key: 'tab:skills' })
      await ui.press({ key: 'tab:tools' })
    }
    await redraw()

    expect((await ui.find({ key: 'profiles' }))?.text).toContain('Coding')
    await ui.press({ key: 'profile:use:Editing' })
    expect(stored.get('preset:/pane-profiles')).toEqual(['block:mcp__rea__*'])
    await redraw()
    expect((await ui.find({ key: 'profile:delete' }))?.text).toContain('Delete')

    await ui.press({ key: 'group:tool:deferred:vidiq:all' })
    await redraw()
    expect((await ui.find({ key: 'profile-actions' }))?.text).toContain('Changed since you picked Editing')
    await ui.press({ key: 'profile:revert' })
    expect(stored.get('preset:/pane-profiles')).toEqual(['block:mcp__rea__*'])
    await redraw()

    await ui.press({ key: 'group:tool:deferred:vidiq:all' })
    await redraw()
    await ui.press({ key: 'profile:save' })
    expect((stored.get('profiles') as Record<string, unknown>).Editing).toEqual([
      'block:mcp__rea__*', 'block:mcp__vidiq__*',
    ])

    await ui.press({ key: 'profile:new' })
    await ui.input({ key: 'profile-name', text: `Writing ${surface}` })
    expect((stored.get('profiles') as Record<string, unknown>)[`Writing ${surface}`]).toEqual([
      'block:mcp__rea__*', 'block:mcp__vidiq__*',
    ])
    expect(stored.get('profile:/pane-profiles')).toBe(`Writing ${surface}`)
    expect(await ui.find({ key: 'profile-name' })).toBeUndefined()

    await redraw()
    await ui.press({ key: 'profile:delete' })
    expect((await ui.find({ key: 'profile:delete' }))?.text).toContain('Press again')
    await ui.press({ key: 'profile:delete' })
    expect(Object.keys(stored.get('profiles') as object)).not.toContain(`Writing ${surface}`)
    expect(stored.get('profile:/pane-profiles')).toBeUndefined()

    await ui.press({ key: 'profile:use:Coding' })
    await redraw()
    await ui.press({ key: 'profile:none' })
    expect(stored.get('preset:/pane-profiles')).toBeUndefined()
    await ui.unmount()
  }
})
