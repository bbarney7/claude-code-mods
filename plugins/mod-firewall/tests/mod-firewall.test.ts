import { expect, test } from 'claude-code/testing'

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
  expect(findSecrets('hello world', known)).toEqual([])
})

test('each kind of call gets the right severity', async () => {
  const known = new Map([['API_KEY', 'supersecretvalue123']])
  expect(checkFetch('https://webhook.site/abc', { method: 'POST', body: 'supersecretvalue123' }, known)).toEqual({
    category: 'network',
    severity: 'critical',
    target: 'POST webhook.site',
    reason: 'the request contains API_KEY from .env',
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
  expect(decide('ask', 'critical', true, false, true)).toBe('ask')
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
    expect(await ui.find({ type: 'Text', text: /mode: strict · 0 mods seen · 0 calls blocked/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No other mods have done anything yet/ })).toBeDefined()
    await ui.unmount()
  }
})
