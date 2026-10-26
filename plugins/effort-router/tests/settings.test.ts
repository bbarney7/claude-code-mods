import { expect, mock, test } from 'claude-code/testing'

// What Claude Code passes to the ui.render hook for the settings pane, apart from the app
const PANE = {
  plugin: 'effort-router',
  component: 'Pane',
  requestId: 'effort-router-settings',
  viewport: { columns: 120, rows: 40 },
  props: {
    title: 'Effort router',
    isFocused: true,
    bodyColumns: 90,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 28 },
    view: {},
  },
} as const

test('the pane saves settings and flips the router on terminal and desktop', async ($, on) => {
  // The mod's store in memory, so the test can read what the pane saved
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  mock.clock(on)
  mock.env(on, { OPENROUTER_API_KEY: 'test-key' })
  on('http.fetch', () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ answers: { effort: { probabilities: { trivial: 0.95, standard: 0.05, hard: 0 } } } }),
    },
  }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'effort-router' } }))

  // The key is looked up when the session starts
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The Classifier row opens to show the key
    expect(await ui.find({ type: 'Text', text: '● OpenRouter' })).toBeDefined()
    if (surface === 'terminal') await ui.press({ key: 'classifier' })
    expect(await ui.find({ type: 'Text', text: '● OpenRouter key found' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'key from OPENROUTER_API_KEY' })).toBeDefined()

    await ui.select({ key: 'effort-hard', value: 'max' })
    await ui.select({ key: 'effort-unsure', value: 'high' })
    expect(await ui.find({ type: 'Text', text: 'Saved when unsure.' })).toBeDefined()

    await ui.press({ key: 'toggle' })
    expect((await ui.find({ key: 'toggle' }))?.text).toContain('Disabled')
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ key: 'toggle' }))?.text).toContain('Enabled')

    expect(await ui.find({ key: 'try' })).toBeUndefined()
    await ui.unmount()
  }

  // Saved in the mod's store, which outlasts the session
  expect(store.settings).toEqual({ hard_effort: 'max', unsure_effort: 'high' })
})

test('the pane draws with no key and saved stats, as the desktop app runs it', async ($, on) => {
  const decisions = [
    { at: 1, source: 'haiku', want: 'hard', effort: 'xhigh', ms: 609, error: 'no OPENROUTER_API_KEY' },
    { at: 2, source: 'haiku', want: 'standard', effort: 'xhigh', ms: 5082, error: 'no OPENROUTER_API_KEY' },
  ]
  // The mod's store in memory, so the test can read what the pane saved
  const store: Record<string, unknown> = { decisions, steps: [] }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  mock.clock(on)
  mock.env(on, {})
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'effort-router' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The Keychain has nothing until a key is pasted; the login shell has none either
  const saved: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[1] === 'add-generic-password') saved.push(String(e.argv.at(-1)))
    return { value: { exitCode: e.argv[1] === 'add-generic-password' ? 0 : 44, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const urls: string[] = []
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { effort: { probabilities: { trivial: 1, standard: 0, hard: 0 } } } }) },
    }
  })

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'desktop') await ui.press({ key: 'classifier' })
    expect(await ui.find({ type: 'Text', text: '○ No key · Haiku rates every turn' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 turns rated' })).toBeDefined()
    await ui.unmount()
  }

  // Pasting a key saves it in the Keychain and checks it with Jev
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'key', text: '  sk-or-v1-0123456789abcdef0123456789  ' })
  expect(saved).toEqual(['sk-or-v1-0123456789abcdef0123456789'])
  expect(await ui.find({ type: 'Text', text: /^● Connected · OpenRouter · \d+ ms$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'key saved in your Keychain' })).toBeDefined()
  // With a key in place the field hides behind Change key
  expect(await ui.find({ key: 'key' })).toBeUndefined()

  // A TypeSafe key is recognised by its prefix, preferred, and goes to TypeSafe
  await ui.press({ key: 'change-key' })
  await ui.input({ key: 'key', text: 'apik_0123456789abcdef0123456789abcdef' })
  expect(saved.at(-1)).toBe('apik_0123456789abcdef0123456789abcdef')
  expect(await ui.find({ type: 'Text', text: /^● Connected · TypeSafe · \d+ ms$/ })).toBeDefined()
  expect(urls.at(-1)).toBe('https://api.typesafe.ai/v1/systemone')
  expect(store.settings).toEqual({ jev_service: 'typesafe' })
  // Both keys exist now: the pane offers a choice of service, and a press switches at once
  await ui.press({ key: 'service-openrouter' })
  expect(store.settings).toEqual({ jev_service: 'openrouter' })
  expect(await ui.find({ type: 'Text', text: /^● Connected · OpenRouter · \d+ ms$/ })).toBeDefined()
  expect(urls.at(-1)).toBe('https://openrouter.ai/api/alpha/decisions')
  await ui.unmount()
})

test('/effort-router with no argument opens the settings pane', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  mock.clock(on)
  mock.env(on, {})
  on('http.fetch', () => ({ value: { status: 401, ok: false, headers: {}, text: '' } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'effort-router' } }))
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const typed = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
  const result = await $.command.run({ command: 'effort-router', args: '', ...typed })
  expect(opened).toEqual(['effort-router-settings'])
  expect(result.text).toBeUndefined()
})
