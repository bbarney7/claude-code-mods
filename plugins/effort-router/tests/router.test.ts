import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, model: 'claude-test' }

const jevAnswer = (trivial: number, standard: number, hard: number) => ({
  value: {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({ answers: { effort: { probabilities: { trivial, standard, hard } } } }),
  },
})

// Stands for the engine around the router: records the effort each request went out at
function engine(on: any, seen: unknown[], store: Record<string, unknown> = {}) {
  mock.clock(on)
  mock.store(on, store)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'effort-router' } }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Want me to build it?', toolUses: [] }] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', ($: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; effort?: unknown }) {
    seen.push(e.effort)
    yield { kind: 'text' as const, index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
}

// One main turn: its start, then one request per step
async function turn($: any, turnId: string, text: string, stepCount = 1, extra: Record<string, unknown> = {}) {
  await $.turn.start({ turnId, text, ...extra })
  for (let index = 0; index < stepCount; index++) {
    const stream = $.turn.step({ turnId, index, model: 'claude-test', messageCount: 1, effort: 'xhigh', ...extra })
    let s = await stream.next()
    while (s.done !== true) s = await stream.next()
  }
}

test('Jev rates each turn and every request of the turn goes out at that effort', async ($, on) => {
  const seen: unknown[] = []
  engine(on, seen)
  mock.env(on, { OPENROUTER_API_KEY: 'test-key' })
  const answers = [jevAnswer(0.05, 0.85, 0.1), jevAnswer(0.05, 0.3, 0.65)]
  const bodies: string[] = []
  on('http.fetch', ($: unknown, e: { init?: { body?: string } }) => {
    bodies.push(e.init?.body ?? '')
    return answers.shift()!
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, 't1', 'rename this variable', 2)
  await turn($, 't2', 'redesign the auth flow')
  // A subagent's request is left alone
  await turn($, 't3', 'look around', 1, { agentId: 'sub-1' })

  expect(seen).toEqual(['medium', 'medium', 'xhigh', 'xhigh'])
  // Jev sees the end of the last reply beside the prompt
  expect(bodies[0]).toContain('Want me to build it?')
})

test('Haiku rates the turn when Jev fails, and a continuation keeps the effort', async ($, on) => {
  const seen: unknown[] = []
  engine(on, seen)
  mock.env(on, { OPENROUTER_API_KEY: 'test-key' })
  on('http.fetch', () => ({ deny: 'network refused' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'hard', usage } }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, 't1', 'debug the race in the scheduler')
  await turn($, 't2', '')

  expect(seen).toEqual(['xhigh', 'xhigh'])
})

test('/effort-router off sends the session effort', async ($, on) => {
  const seen: unknown[] = []
  engine(on, seen)
  mock.env(on, { OPENROUTER_API_KEY: 'test-key' })
  on('http.fetch', () => jevAnswer(0.9, 0.05, 0.05))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const typed = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
  await $.command.run({ command: 'effort-router', args: 'off', ...typed })
  await turn($, 't1', 'ok thanks')

  expect(seen).toEqual(['xhigh'])
})

test('a turn Jev is unsure about goes out at the unsure setting', { options: { unsure_effort: 'high' } }, async ($, on) => {
  const seen: unknown[] = []
  engine(on, seen)
  mock.env(on, { OPENROUTER_API_KEY: 'test-key' })
  on('http.fetch', () => jevAnswer(0.6, 0.3, 0.1))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, 't1', 'maybe tidy this up')

  expect(seen).toEqual(['high'])
})

test('a choice saved from the pane applies in a new session over the plugin settings', { options: { unsure_effort: 'high' } }, async ($, on) => {
  const seen: unknown[] = []
  engine(on, seen, { settings: { unsure_effort: 'low', hard_effort: 'max' } })
  mock.env(on, { OPENROUTER_API_KEY: 'test-key' })
  let answer = jevAnswer(0.6, 0.3, 0.1)
  on('http.fetch', () => answer)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, 't1', 'maybe tidy this up')
  answer = jevAnswer(0, 0.2, 0.8)
  await turn($, 't2', 'redesign the scheduler')

  expect(seen).toEqual(['low', 'max'])
})
