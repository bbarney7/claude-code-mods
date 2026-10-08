import { expect, mock, test } from 'claude-code/testing'

import {
  argvFor,
  framePrompt,
  handoffTargets,
  historyFor,
  isBareAck,
  normalizeAsk,
  parseDelegate,
  parseMentions,
  parseReview,
  readConfig,
  reviewPrompt,
  roomTranscript,
  sessionExcerpt,
  targetsOf,
} from '../hooks/register'
import type { RoomMessage } from '../types'

const PANE_PROPS = {
  title: 'Pane',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('/second-opinion picks agents and keeps the focus text', async () => {
  expect(parseReview('')).toEqual({ agents: ['codex', 'cursor'], focus: '' })
  expect(parseReview('codex')).toEqual({ agents: ['codex'], focus: '' })
  expect(parseReview('Cursor check the auth path')).toEqual({ agents: ['cursor'], focus: 'check the auth path' })
  expect(parseReview('both race conditions')).toEqual({ agents: ['codex', 'cursor'], focus: 'race conditions' })
  expect(parseReview('look at error handling')).toEqual({ agents: ['codex', 'cursor'], focus: 'look at error handling' })
})

test('/delegate needs an agent and a task', async () => {
  expect(parseDelegate('codex add a --verbose flag')).toEqual({ agent: 'codex', task: 'add a --verbose flag' })
  expect('error' in parseDelegate('codex')).toBe(true)
  expect('error' in parseDelegate('gemini do it')).toBe(true)
})

test('reviews run read-only and implementations can write', async () => {
  expect(argvFor('codex', 'review', 'p')).toEqual(['codex', 'exec', 'p', '-s', 'read-only', '--skip-git-repo-check'])
  expect(argvFor('codex', 'implement', 'p')).toEqual(['codex', 'exec', 'p', '-s', 'workspace-write', '--skip-git-repo-check'])
  expect(argvFor('cursor', 'review', 'p')).toEqual(['cursor-agent', '-p', 'p', '--mode', 'ask', '--trust', '--output-format', 'text'])
  expect(argvFor('cursor', 'implement', 'p')).toEqual(['cursor-agent', '-p', 'p', '--force', '--trust', '--output-format', 'text'])
})

test('the review prompt carries the diff and caps huge ones', async () => {
  expect(reviewPrompt('-a\n+b', 'auth')).toContain('-a\n+b')
  expect(reviewPrompt('-a\n+b', 'auth')).toContain('Extra focus from the developer: auth')
  expect(reviewPrompt('x'.repeat(200_000), '')).toContain('[diff cut at 150000 characters]')
})

test('mentions are read from prose, never from code', async () => {
  expect(parseMentions('@codex can you check this? cc @Cursor')).toEqual(['codex', 'cursor'])
  expect(parseMentions('ask @claude, then @claude again')).toEqual(['claude'])
  expect(parseMentions('@main can you weigh in, @claude too')).toEqual(['main', 'claude'])
  expect(parseMentions('quoting `@codex` is not a mention')).toEqual([])
  expect(parseMentions('```\n@cursor in a fence\n```\nnobody here')).toEqual([])
  expect(parseMentions('email me at me@codex.dev')).toEqual([])
})

test('a message goes to whoever it mentions, else the default agent', async () => {
  expect(targetsOf('@cursor look at m.py', 'codex')).toEqual({ agents: ['cursor'], toMain: false })
  expect(targetsOf('what does m.py do?', 'codex')).toEqual({ agents: ['codex'], toMain: false })
  expect(targetsOf('@codex @cursor compare notes', 'codex')).toEqual({ agents: ['codex', 'cursor'], toMain: false })
  expect(targetsOf('@claude what do you think?', 'codex')).toEqual({ agents: ['claude'], toMain: false })
  expect(targetsOf('@main what do you think?', 'codex')).toEqual({ agents: [], toMain: true })
  expect(normalizeAsk('claude hi')).toBe('@claude hi')
  expect(normalizeAsk('codex hi there')).toBe('@codex hi there')
  expect(normalizeAsk('hi there')).toBe('hi there')
})

test('history is what the others said since the agent last spoke', async () => {
  const messages: RoomMessage[] = [
    { id: '1', from: 'you', text: 'old question' },
    { id: '2', from: 'codex', text: 'old answer' },
    { id: '3', from: 'cursor', text: 'cursor chimed in' },
    { id: '4', from: 'system', text: 'handoff row' },
    { id: '5', from: 'you', text: 'the new question' },
  ]
  const history = historyFor(messages, 'codex', '5')
  expect(history).toContain('<chat-event author="agent:cursor">cursor chimed in</chat-event>')
  expect(history).not.toContain('old question')
  expect(history).not.toContain('handoff row')
  expect(history).not.toContain('the new question')
  expect(historyFor(messages.slice(0, 2), 'codex', '9')).toBe('')
  const fresh = historyFor(messages, 'codex', '5', true)
  expect(fresh).toContain('old question')
  expect(fresh).toContain('<chat-event author="agent:codex">old answer</chat-event>')
  expect(fresh).not.toContain('the new question')
})

test('the first prompt of a session introduces the room; later ones do not', async () => {
  const trigger: RoomMessage = { id: 't', from: 'you', text: 'hello' }
  const first = framePrompt('cursor', true, '', trigger, 0, '/repo')
  expect(first).toContain('You are @cursor (Cursor)')
  expect(first).toContain('/repo')
  expect(first).toContain('<chat-event author="human">hello</chat-event>')
  const later = framePrompt('cursor', false, '', { id: 'r', from: 'codex', text: '@cursor your turn' }, 1, '/repo')
  expect(later).not.toContain('<system>')
  expect(later).toContain('hop 1 of 3')
  expect(isBareAck('Thanks @codex!')).toBe(true)
  expect(isBareAck('Thanks — I found the bug in m.py line 2, it subtracts.')).toBe(false)
})

test('the review pane starts empty with a hint', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'second-opinion', surface, component: 'Pane', requestId: 'second-opinion', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /No runs yet/ })).toBeDefined()
    expect(await ui.find({ key: 'send-reviews' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the agent room shows who is there and a composer, or a hint on mobile', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'second-opinion', surface, component: 'Pane', requestId: 'agent-room', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /Codex idle/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude idle/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /@main reaches your main session/ })).toBeDefined()
    expect(await ui.find({ key: 'room-0' })).toBeDefined()
    expect(await ui.find({ key: 'to-codex' })).toBeDefined()
    // Picking a chip changes who the next message goes to.
    await ui.press({ key: 'to-cursor' })
    expect(await ui.find({ type: 'Text', text: /default @cursor/ })).toBeDefined()
    await ui.press({ key: 'to-codex' })
    await ui.unmount()
  }
  const phone = await $.ui.mount({ plugin: 'second-opinion', surface: 'mobile', component: 'Pane', requestId: 'agent-room', props: PANE_PROPS })
  expect(await phone.find({ type: 'Text', text: /Send with \/ask @codex/ })).toBeDefined()
  await phone.unmount()
})

test('answering whoever asked is not a handoff; bringing in someone else is', async () => {
  const reply = (text: string): RoomMessage => ({ id: 'r', from: 'cursor', text })
  expect(handoffTargets(reply('@main it subtracts'), 'main')).toEqual([])
  expect(handoffTargets(reply('@main it subtracts; @codex can you double-check?'), 'main')).toEqual(['codex'])
  expect(handoffTargets(reply('@cursor note to self, @you see above'), 'you')).toEqual([])
  expect(handoffTargets(reply('@main please run the tests'), 'you')).toEqual(['main'])
  expect(handoffTargets(reply('@claude can you sanity-check this?'), 'you')).toEqual(['claude'])
})

test('a fresh agent gets the tail of the Claude session, without tool noise or room relays', async () => {
  const excerpt = sessionExcerpt([
    { role: 'user', text: 'very old message', toolUses: [] },
    { role: 'user', text: 'fix the add() bug in m.py', toolUses: [] },
    { role: 'assistant', text: 'Looking at m.py.', toolUses: [{ tool: 'Read' }, { tool: 'Read' }, { tool: 'Edit' }] },
    { role: 'user', text: '', toolUses: [] },
    { role: 'user', text: '@cursor said in the agent room (the Agent room pane):\n\nhi', toolUses: [] },
    { role: 'user', text: 'thanks<system-reminder>secret stuff</system-reminder>', toolUses: [] },
  ])
  expect(excerpt).toContain('Human: fix the add() bug in m.py')
  expect(excerpt).toContain('Claude: Looking at m.py.\n[tools used: Read, Edit]')
  expect(excerpt).toContain('Human: thanks')
  expect(excerpt).not.toContain('secret stuff')
  expect(excerpt).not.toContain('said in the agent room')
  expect(sessionExcerpt([])).toBe('')
  const framed = framePrompt('codex', true, '', { id: 't', from: 'you', text: 'hi' }, 0, '/repo', excerpt)
  expect(framed).toContain('<claude-session>')
  expect(framePrompt('codex', false, '', { id: 't', from: 'you', text: 'hi' }, 0, '/repo', excerpt)).not.toContain('<claude-session>')
})

test('settings fall back to defaults when missing or out of range', async () => {
  expect(readConfig({})).toEqual({ roomSeed: 'recent', roomSeedTurns: 10, claudeReturn: 'message', claudeReturnMessages: 8 })
  expect(readConfig({ roomSeed: 'summary', roomSeedTurns: 25, claudeReturn: 'full', claudeReturnMessages: 3 })).toEqual({
    roomSeed: 'summary',
    roomSeedTurns: 25,
    claudeReturn: 'full',
    claudeReturnMessages: 3,
  })
  expect(readConfig({ roomSeed: 'everything', roomSeedTurns: -4, claudeReturnMessages: 9999 })).toEqual({
    roomSeed: 'recent',
    roomSeedTurns: 1,
    claudeReturn: 'message',
    claudeReturnMessages: 200,
  })
})

test('the session excerpt honours its turn and size limits', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, text: `turn ${i}`, toolUses: [] }))
  const three = sessionExcerpt(rows, 3)
  expect(three).toContain('Human: turn 29')
  expect(three).toContain('Human: turn 27')
  expect(three).not.toContain('Human: turn 26')
  const all = sessionExcerpt(rows, Number.POSITIVE_INFINITY, 60_000)
  expect(all).toContain('Human: turn 0')
})

test('the room transcript for Claude skips routing rows and keeps the newest', async () => {
  const messages: RoomMessage[] = [
    { id: '1', from: 'you', text: 'first' },
    { id: '2', from: 'system', text: '@codex → @cursor · hop 1 of 3' },
    { id: '3', from: 'codex', text: 'second' },
    { id: '4', from: 'cursor', text: 'third' },
    { id: '5', from: 'cursor', text: '', isStreaming: true },
  ]
  expect(roomTranscript(messages, 10, 10_000)).toBe('You: first\n\nCodex: second\n\nCursor: third')
  expect(roomTranscript(messages, 2, 10_000)).toBe('Codex: second\n\nCursor: third')
})

test('the room header shows the context settings from /config', { options: { roomSeed: 'summary', claudeReturn: 'recent', claudeReturnMessages: 5 } }, async $ => {
  const ui = await $.ui.mount({ plugin: 'second-opinion', surface: 'terminal', component: 'Pane', requestId: 'agent-room', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /context in: summary · back to main: recent 5 msgs/ })).toBeDefined()
  await ui.unmount()
})

test('the first prompt tells a room agent who @main and @claude are', async () => {
  const framed = framePrompt('claude', true, '', { id: 't', from: 'main', text: 'hi' }, 0, '/repo')
  expect(framed).toContain('You are @claude (Claude)')
  expect(framed).toContain('@main is the main Claude Code session')
  expect(framed).toContain('<chat-event author="agent:main">hi</chat-event>')
})


for (const [label, variables, expected] of [
  ['inside the room\'s own Claude', { SECOND_OPINION_IN_ROOM: '1' }, false],
  ['in a normal session', {}, true],
] as const) {
  test(`${label} the mod ${expected ? 'registers' : 'does not register'} /room`, async ($, on) => {
    mock.env(on, variables)
    const registered: string[] = []
    on('command.register', ($, e, next) => {
      registered.push(e.name)
      return next(e)
    })
    await $.session.start({ source: 'startup' } as never).catch(() => undefined)
    expect(registered.includes('room')).toBe(expected)
  })
}
