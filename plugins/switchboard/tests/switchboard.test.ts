import { expect, test } from 'claude-code/testing'

import {
  addTouch,
  ago,
  branchFromHead,
  codexHandle,
  codexToShow,
  collisionsFor,
  findCodex,
  groupPeers,
  parseDm,
  resolveDm,
  parseEnvelope,
  parseListing,
  readConfig,
  shouldHold,
} from '../hooks/register'
import type { CodexThread, Presence } from '../types'

const PANE_PROPS = {
  title: 'Switchboard',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('the session listing yields this session and its peers', async () => {
  const { me, peers } = parseListing({
    listing: 'This session is out-1d [983b12] — the name other sessions use to message it.\n\nPeer sessions (2):\n…',
    sections: [{ kind: 'sessions', rows: [{ name: 'out-1f', ref: 'ec1b42', type: 'interactive', status: 'idle' }, { name: 'run-c1', ref: 'cca7d4', type: 'interactive', status: 'busy' }] }],
  })
  expect(me).toBe('out-1d')
  expect(peers.map(p => p.name)).toEqual(['out-1f', 'run-c1'])
  expect(parseListing(undefined)).toEqual({ me: '', peers: [] })
})

test("another session's message is recognised by its envelope", async () => {
  const text = '<cross-session-message from="uds:/tmp/cc-socks/27018.sock" from-name="out-1f" from-mode="bypass">\nPONG-B\n</cross-session-message>'
  expect(parseEnvelope(text)).toEqual({ from: 'out-1f', body: 'PONG-B' })
  expect(parseEnvelope('just a prompt')).toBeUndefined()
})

test('the inbox policy holds by repository', async () => {
  expect(shouldHold('deliver', undefined, '/repo')).toBe(false)
  expect(shouldHold('hold', '/repo', '/repo')).toBe(true)
  expect(shouldHold('hold-other-repos', '/repo', '/repo')).toBe(false)
  expect(shouldHold('hold-other-repos', '/other', '/repo')).toBe(true)
  expect(shouldHold('hold-other-repos', undefined, '/repo')).toBe(true)
})

test("collisions are other sessions' recent edits to the same file", async () => {
  const now = 10_000_000
  const others: Presence[] = [
    { name: 'run-c1', root: '/repo', state: 'busy', updatedAt: now, touched: [{ path: '/repo/a.ts', at: now - 120_000 }] },
    { name: 'run-0f', root: '/repo', state: 'idle', updatedAt: now, touched: [{ path: '/repo/a.ts', at: now - 3_600_000 }, { path: '/repo/b.ts', at: now - 1_000 }] },
  ]
  expect(collisionsFor('/repo/a.ts', others, now, 30 * 60_000)).toEqual([{ name: 'run-c1', at: now - 120_000 }])
  expect(collisionsFor('/repo/b.ts', others, now, 30 * 60_000)).toEqual([{ name: 'run-0f', at: now - 1_000 }])
  expect(collisionsFor('/repo/c.ts', others, now, 30 * 60_000)).toEqual([])
})

test('touches keep the newest per file and forget old ones', async () => {
  const now = 100_000_000
  const touched = addTouch([{ path: '/r/a', at: now - 5_000 }, { path: '/r/old', at: now - 3 * 3_600_000 }], '/r/a', now)
  expect(touched).toEqual([{ path: '/r/a', at: now }])
})

test('helpers: /dm parsing, branch from HEAD, relative times, settings', async () => {
  expect(parseDm('@run-c1 pause before you push')).toEqual({ peer: 'run-c1', text: 'pause before you push' })
  expect('error' in parseDm('run-c1')).toBe(true)
  expect(branchFromHead('ref: refs/heads/feat/switchboard\n')).toBe('feat/switchboard')
  expect(branchFromHead('3f2a9c1d0e')).toBe('3f2a9c1d')
  expect(ago(45_000)).toBe('45s ago')
  expect(ago(5 * 60_000)).toBe('5m ago')
  expect(readConfig({})).toEqual({ incoming: 'hold-other-repos', collisions: 'warn', collisionMinutes: 30 })
  expect(readConfig({ incoming: 'hold', collisions: 'nope', collisionMinutes: -3 }).collisions).toBe('warn')
})

test('sessions group into this repo, other live ones, and a count of offline ones', async () => {
  const peers = [
    { name: 'b', ref: '1', type: 'interactive', status: 'idle' },
    { name: 'c', ref: '2', type: 'interactive', status: 'busy' },
    { name: 'old', ref: '3', type: 'remote_control', status: 'offline' },
    { name: 'd', ref: '4', type: 'bg', status: 'idle' },
  ]
  const presence: Presence[] = [
    { name: 'b', root: '/repo', state: 'idle', touched: [], updatedAt: 0 },
    { name: 'c', root: '/other', state: 'busy', touched: [], updatedAt: 0 },
  ]
  const g = groupPeers(peers, presence, '/repo')
  expect(g.here.map(p => p.name)).toEqual(['b'])
  expect(g.elsewhere.map(p => p.name)).toEqual(['c', 'd'])
  expect(g.offline).toBe(1)
})

test('the pane renders with nobody else around', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'switchboard', surface, component: 'Pane', requestId: 'switchboard', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /incoming: hold-other-repos/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No other session is working here/ })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    await ui.unmount()
  }
})

test('Codex sessions: open ones first, addressed by the end of their id', async () => {
  const threads: CodexThread[] = [
    { id: '01a1-0000-aaaa1111', name: 'old closed', cwd: '/x', status: 'notLoaded', updatedAt: 1 },
    { id: '01a1-0000-bbbb2222', name: 'recent closed', cwd: '/x', status: 'notLoaded', updatedAt: 5 },
    { id: '01a1-0000-cccc3333', name: 'open one', cwd: '/x', status: 'idle', updatedAt: 2 },
  ]
  expect(codexToShow(threads).map(t => t.name)).toEqual(['open one', 'recent closed', 'old closed'])
  expect(codexToShow(threads, 1).map(t => t.name)).toEqual(['open one'])
  expect(codexHandle('01a1-0000-cccc3333')).toBe('codex:cccc3333')
  expect(findCodex('codex:cccc3333', threads)?.name).toBe('open one')
  expect(findCodex('codex:nope', threads)).toBeUndefined()
  expect(findCodex('B — Builder', threads)).toBeUndefined()
  expect(parseDm('codex:cccc3333 pick up the search work')).toEqual({ peer: 'codex:cccc3333', text: 'pick up the search work' })
})

test('/dm finds sessions whose names have spaces, and tells apart two with the same name', async () => {
  const peers = [
    { name: 'A — Planner', ref: 'aa11', type: 'interactive', status: 'idle' },
    { name: 'A', ref: 'aa22', type: 'interactive', status: 'idle' },
    { name: 'Room command', ref: 'rc01', type: 'interactive', status: 'idle' },
    { name: 'Room command', ref: 'rc02', type: 'interactive', status: 'idle' },
    { name: 'brennen-74', ref: 'b74x', type: 'interactive', status: 'idle' },
  ]
  expect(resolveDm('A — Planner search first', peers)).toEqual({ peer: 'A — Planner', text: 'search first' })
  expect(resolveDm('A hi', peers)).toEqual({ peer: 'A', text: 'hi' })
  expect(resolveDm('@brennen-74 pause', peers)).toEqual({ peer: 'brennen-74', text: 'pause' })
  expect(resolveDm('Room command [rc02] take this', peers)).toEqual({ peer: 'Room command [rc02]', text: 'take this' })
  expect(resolveDm('rc01 take this', peers)).toEqual({ peer: 'Room command [rc01]', text: 'take this' })
  expect(resolveDm('codex:cccc3333 go', peers)).toEqual({ peer: 'codex:cccc3333', text: 'go' })
  expect('error' in resolveDm('A — Planner', peers)).toBe(true)
})
