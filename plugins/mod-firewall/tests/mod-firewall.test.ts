import { expect, mock, test } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'

import {
  badgesFor,
  checkEnv,
  checkFetch,
  checkProcess,
  checkRead,
  checkWrite,
  decide,
  findSecrets,
  isPoliced,
  isSecretPath,
  parseDotenv,
  readConfig,
} from '../hooks/register'

const PANE_PROPS = {
  title: 'Mod firewall',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('secret files are recognised; ordinary ones are not', async () => {
  for (const path of ['/repo/.env', '/repo/.env.local', '/Users/me/.ssh/id_ed25519', '/Users/me/.aws/credentials', '/repo/certs/server.pem', '/Users/me/.npmrc', '/Users/me/.claude.json']) {
    expect(isSecretPath(path)).toBe(true)
  }
  for (const path of ['/repo/src/env.ts', '/repo/README.md', '/repo/.envrc.example.md', '/repo/package.json']) {
    expect(isSecretPath(path)).toBe(false)
  }
})

test('.env values and well-known token shapes are found in outgoing data', async () => {
  const known = parseDotenv('# comment\nOPENAI_API_KEY="sk-test-1234567890abcdef"\nPORT=3000\nexport DB_PASSWORD=hunter2hunter2\n')
  expect([...known.keys()]).toEqual(['OPENAI_API_KEY', 'DB_PASSWORD'])
  expect(findSecrets('{"k":"sk-test-1234567890abcdef"}', known)).toEqual(['OPENAI_API_KEY from .env'])
  expect(findSecrets(`?p=${encodeURIComponent('hunter2hunter2')}`, known)).toEqual(['DB_PASSWORD from .env'])
  expect(findSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123456789', new Map())).toEqual(['a GitHub token'])
  expect(findSecrets('-----BEGIN OPENSSH PRIVATE KEY-----', new Map())).toEqual(['a private key'])
  expect(findSecrets(`Bearer sk-or-v1-${'a1'.repeat(32)}`, new Map())).toEqual(['an OpenRouter API key'])
  expect(findSecrets(`x-api-key: sk-ant-api03-${'b2'.repeat(20)}`, new Map())).toEqual(['an Anthropic API key'])
  expect(findSecrets(`Bearer sk-proj-${'c3'.repeat(20)}`, new Map())).toEqual(['an OpenAI API key'])
  expect(findSecrets('hello world', known)).toEqual([])
})

test('each kind of call gets the right severity', async () => {
  const known = new Map([['API_KEY', 'supersecretvalue123']])
  expect(checkFetch('https://webhook.site/abc', { method: 'POST', body: 'supersecretvalue123' }, known)).toEqual({
    category: 'network',
    severity: 'critical',
    target: 'POST webhook.site',
    reason: 'send API_KEY from .env to webhook.site',
    grant: 'API_KEY from .env to webhook.site',
  })
  expect(checkFetch('https://api.example.com/x', undefined, known).severity).toBe('sensitive')
  expect(checkRead('/repo/.env').severity).toBe('sensitive')
  expect(checkRead('/repo/src/a.ts').severity).toBe('info')
  expect(checkWrite('/repo/src/a.ts', '/repo', '/Users/me').severity).toBe('info')
  expect(checkWrite('/Users/me/.zshrc', '/repo', '/Users/me').severity).toBe('sensitive')
  expect(checkWrite('/repo/.git/hooks/pre-commit', '/repo', '/Users/me').severity).toBe('sensitive')
  expect(checkWrite('/tmp/scratch.txt', '/repo', '/Users/me').severity).toBe('info')
  expect(checkEnv('GITHUB_TOKEN').severity).toBe('sensitive')
  expect(checkEnv('HOME').severity).toBe('info')
  expect(checkProcess(['curl', 'https://x']).severity).toBe('sensitive')
})

test('decisions follow the mode, trust and blocks', async () => {
  expect(decide('ask', 'info', false, false, false)).toBe('allow')
  expect(decide('ask', 'sensitive', false, false, false)).toBe('ask')
  expect(decide('ask', 'sensitive', true, false, false)).toBe('allow')
  expect(decide('ask', 'sensitive', false, false, true)).toBe('allow')
  expect(decide('ask', 'critical', true, false, false)).toBe('ask')
  expect(decide('ask', 'critical', false, false, true)).toBe('allow')
  expect(decide('strict', 'critical', false, false, true)).toBe('allow')
  expect(decide('ask', 'critical', false, true, true)).toBe('block')
  expect(decide('strict', 'sensitive', false, false, false)).toBe('block')
  expect(decide('strict', 'sensitive', true, false, false)).toBe('allow')
  expect(decide('strict', 'critical', true, false, false)).toBe('block')
  expect(decide('audit', 'critical', false, false, false)).toBe('flag')
  expect(decide('audit', 'sensitive', true, true, false)).toBe('block')
})

test('only user-installed mods are policed, never Claude Code itself', async () => {
  expect(isPoliced({ plugin: 'evil-pet', tier: 'user' })).toBe(true)
  expect(isPoliced({ plugin: 'cc-plugin-telemetry', tier: 'builtin' })).toBe(false)
  expect(isPoliced({ plugin: 'engine', tier: 'core' })).toBe(false)
  expect(isPoliced({ plugin: 'corp-guard', tier: 'prepend' })).toBe(false)
  expect(isPoliced({ plugin: 'mod-firewall', tier: 'user' })).toBe(false)
})

test('a mod that pairs the network with reach into your machine is high risk', async () => {
  expect(badgesFor({ events: ['session.start'], calls: ['http.fetch', 'fs.read'], env: { reads: ['OPENAI_API_KEY'], writes: [] } })).toEqual({
    badges: ['network', 'reads files', 'secret env: OPENAI_API_KEY'],
    risk: 'high',
  })
  expect(badgesFor({ events: ['ui.render'], calls: ['ui.resolve'] })).toEqual({ badges: [], risk: 'low' })
  expect(badgesFor({ events: ['tool.call'], calls: ['process.run'] }).risk).toBe('medium')
})

test('settings are read with safe fallbacks', async () => {
  expect(readConfig({})).toEqual({ mode: 'ask', trusted: [], refuseRiskyAtLoad: false })
  expect(readConfig({ mode: 'strict', trusted: ' second-opinion, foo ,', refuseRiskyAtLoad: true })).toEqual({
    mode: 'strict',
    trusted: ['second-opinion', 'foo'],
    refuseRiskyAtLoad: true,
  })
  expect(readConfig({ mode: 'yolo' }).mode).toBe('ask')
})

test('the pane starts empty and shows the mode', { options: { mode: 'strict' } }, async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-firewall', surface, component: 'Pane', requestId: 'mod-firewall', props: PANE_PROPS })
    // The desktop draws the body in the pane's module.
    const scope = surface === 'desktop' ? { in: 'firewall-pane' } : {}
    expect(await ui.find({ type: 'Text', text: /mode: strict · 0 mods seen · 0 calls blocked/, ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No other mods have done anything yet/, ...scope })).toBeDefined()
    await ui.unmount()
  }
})

// ---------- trust remembered across sessions ----------

// A mod with a command that reads a secret-looking environment variable, a call the firewall asks about.
const POKER: Plugin = {
  name: 'skins',
  register(on) {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'poke', description: 'read a token' })
      return next(e)
    })
    on('command.run', { command: 'poke' }, async $ => {
      const token = await $.env.get('GITHUB_TOKEN').catch(() => 'refused')
      return { text: token === 'refused' ? 'refused' : 'read' }
    })
  },
}

// The firewall's store as a file every session shares, and the questions it asks (each dismissed,
// or given `answer`).
function firewallSession(on: Parameters<TestBody>[1], trusted: string[], answer?: string) {
  const disk: Record<string, unknown> = { trusted }
  on('store.get', async ($, e) => ({ value: disk[e.key] }))
  on('store.set', async ($, e) => {
    disk[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/Users/me', GITHUB_TOKEN: 'ghp_x' })
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.read', async () => {
    throw new Error('ENOENT')
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async () => ({ cwd: '/repo' }))
  const asked: string[] = []
  const questions: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    asked.push(JSON.stringify(e).slice(0, 160))
    if (answer === undefined) return { deny: 'dismissed' }
    const question = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0]
    questions.push(`${question?.question} [${question?.options.map(o => o.label).join(' / ')}]`)
    return { result: { questions: [question], answers: { [question?.question ?? '']: answer } } } as never
  })
  return { disk, asked, questions }
}

test('a mod trusted in another open session is not asked about here', { plugins: [POKER] }, async ($, on) => {
  const { disk, asked } = firewallSession(on, [])
  await $.session.start({ cwd: '/repo' } as never)
  disk.trusted = ['skins']
  expect(await $.command.run({ command: 'poke', args: '' } as never)).toMatchObject({ text: 'read' })
  expect(asked).toEqual([])
})

test("on the desktop, Trust is pressed in the pane's module and saved beside what other sessions trusted", { plugins: [POKER] }, async ($, on) => {
  const { disk } = firewallSession(on, ['room'])
  await $.session.start({ cwd: '/repo' } as never)
  await $.command.run({ command: 'poke', args: '' } as never)
  // Another open session trusts filetree after this one started.
  disk.trusted = ['room', 'filetree']
  const ui = await $.ui.mount({ plugin: 'mod-firewall', surface: 'desktop', component: 'Pane', requestId: 'mod-firewall', props: PANE_PROPS })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ key: 'trust-skins', in: 'firewall-pane' })).toBeDefined()
  await ui.press({ key: 'trust-skins' })
  expect(disk.trusted).toEqual(['room', 'filetree', 'skins'])
  expect(await ui.find({ key: 'untrust-skins', in: 'firewall-pane' })).toBeDefined()
  await ui.unmount()
})

// ---------- a mod that sends its own API key on every turn ----------

// Calls openrouter.ai with its key each time /route runs, and api.example.com when given that host.
const ROUTER: Plugin = {
  name: 'effort-router',
  register(on) {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'route', description: 'ask a model' })
      return next(e)
    })
    on('command.run', { command: 'route' }, async ($, e) => {
      const host = e.args || 'openrouter.ai'
      // Test plugins run on their own, so the key is spelled out here.
      const key = `sk-or-v1-${'d4'.repeat(32)}`
      const res = await $.http.fetch(`https://${host}/api/v1/chat`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: '{}' }).catch(() => undefined)
      return { text: res ? 'sent' : 'refused' }
    })
  },
}

function routerSession(on: Parameters<TestBody>[1], answer: string) {
  const session = firewallSession(on, [], answer)
  on('http.fetch', async () => ({ value: { ok: true, status: 200, headers: {}, text: '{}' } }) as never)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  return session
}

test('a key allowed for this session to one site is not asked about again there, only elsewhere', { plugins: [ROUTER] }, async ($, on) => {
  const { questions } = routerSession(on, 'Allow for this session')
  await $.session.start({ cwd: '/repo' } as never)
  expect(await $.command.run({ command: 'route', args: '' } as never)).toMatchObject({ text: 'sent' })
  expect(await $.command.run({ command: 'route', args: '' } as never)).toMatchObject({ text: 'sent' })
  expect(questions).toEqual([
    '⚠ The mod "effort-router" wants to send an OpenRouter API key to openrouter.ai. Allow it? [Allow once / Allow for this session / Always allow sending this there / Block]',
  ])
  expect(await $.command.run({ command: 'route', args: 'evil.example' } as never)).toMatchObject({ text: 'sent' })
  expect(questions).toHaveLength(2)
})

test('always allowing a key to a site is remembered for every session, and Block forgets it', { plugins: [ROUTER] }, async ($, on) => {
  const { disk, questions } = routerSession(on, 'Always allow sending this there')
  await $.session.start({ cwd: '/repo' } as never)
  await $.command.run({ command: 'route', args: '' } as never)
  expect(disk.secretGrants).toEqual(['effort-router:secret:an OpenRouter API key to openrouter.ai'])
  await $.command.run({ command: 'route', args: '' } as never)
  expect(questions).toHaveLength(1)
  const ui = await $.ui.mount({ plugin: 'mod-firewall', surface: 'terminal', component: 'Pane', requestId: 'mod-firewall', props: PANE_PROPS })
  await ui.press({ key: 'block-effort-router' })
  await ui.unmount()
  expect(disk.secretGrants).toEqual([])
})
