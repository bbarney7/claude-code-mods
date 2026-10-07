import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Note, PeerRow, Presence, Touch } from '../types'

const PANE = 'switchboard'
const NOTES_CAP = 60
const TOUCH_KEEP_MS = 2 * 60 * 60 * 1000
const STALE_MS = 6 * 60 * 60 * 1000

const meAtom = atom({ plugin: 'switchboard', key: 'me' } as const, '')
const peersAtom = atom({ plugin: 'switchboard', key: 'peers' } as const, [])
const presenceAtom = atom({ plugin: 'switchboard', key: 'presence' } as const, [])
const notesAtom = atom({ plugin: 'switchboard', key: 'notes' } as const, [])

// ---------- settings ----------

export type Incoming = 'deliver' | 'hold-other-repos' | 'hold'
export type Collisions = 'warn' | 'ask' | 'off'
export type Config = { incoming: Incoming; collisions: Collisions; collisionMinutes: number }
export const DEFAULT_CONFIG: Config = { incoming: 'hold-other-repos', collisions: 'warn', collisionMinutes: 30 }

export function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const incoming = options.incoming as Incoming
  const collisions = options.collisions as Collisions
  const minutes = typeof options.collisionMinutes === 'number' && options.collisionMinutes > 0 ? options.collisionMinutes : DEFAULT_CONFIG.collisionMinutes
  return {
    incoming: ['deliver', 'hold-other-repos', 'hold'].includes(incoming) ? incoming : DEFAULT_CONFIG.incoming,
    collisions: ['warn', 'ask', 'off'].includes(collisions) ? collisions : DEFAULT_CONFIG.collisions,
    collisionMinutes: Math.min(24 * 60, Math.round(minutes)),
  }
}

// ---------- pure helpers ----------

// ListAgents answers with a listing whose first line names this session and structured rows for the rest.
export function parseListing(result: unknown): { me: string; peers: PeerRow[] } {
  const r = (result ?? {}) as { listing?: string; sections?: { kind?: string; rows?: PeerRow[] }[] }
  const me = /This session is (\S+)/.exec(r.listing ?? '')?.[1] ?? ''
  const rows = (r.sections ?? []).filter(s => s.kind === 'sessions').flatMap(s => s.rows ?? [])
  return { me, peers: rows.filter(row => row && typeof row.name === 'string') }
}

// A message from another session arrives as <cross-session-message from-name="…">body</cross-session-message>.
export function parseEnvelope(text: string): { from: string; body: string } | undefined {
  const m = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(text)
  if (!m) return undefined
  const from = /from-name="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? ''
  return from ? { from, body: (m[2] ?? '').trim() } : undefined
}

export function shouldHold(policy: Incoming, senderRoot: string | undefined, myRoot: string): boolean {
  if (policy === 'deliver') return false
  if (policy === 'hold') return true
  return !senderRoot || senderRoot !== myRoot
}

// Other sessions' edits to this path within the window, newest first.
export function collisionsFor(path: string, others: readonly Presence[], now: number, windowMs: number): { name: string; at: number }[] {
  return others
    .flatMap(p => p.touched.filter(t => t.path === path && now - t.at <= windowMs).map(t => ({ name: p.name, at: t.at })))
    .sort((a, b) => b.at - a.at)
}

export function addTouch(touched: readonly Touch[], path: string, now: number): Touch[] {
  return [{ path, at: now }, ...touched.filter(t => t.path !== path && now - t.at <= TOUCH_KEEP_MS)].slice(0, 50)
}

// "/dm run-c1 pause before you push" -> peer + text
export function parseDm(args: string): { peer: string; text: string } | { error: string } {
  const [peer = '', ...rest] = args.trim().split(/\s+/)
  const text = rest.join(' ').trim()
  if (!peer || !text) return { error: 'Usage: /dm <session> <message>' }
  return { peer: peer.replace(/^@/, ''), text }
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export function branchFromHead(head: string): string | undefined {
  const m = /^ref: refs\/heads\/(.+)$/m.exec(head.trim())
  if (m) return m[1]
  return head.trim() ? head.trim().slice(0, 8) : undefined
}

// ---------- module state (starts over on a reload) ----------

let config: Config = DEFAULT_CONFIG
let me = ''
let root = ''
let mine: Presence | undefined
let seq = 0
let ticker: { cancel: () => void } | undefined
const held = new Map<string, string>()

// ---------- presence and the session list ----------

async function refreshPeers($: EngineInterface) {
  try {
    const call = (await $.tool.call({ tool: 'ListAgents' } as never)) as { result?: unknown }
    const { me: name, peers } = parseListing(call.result)
    if (name) me = name
    await update($, meAtom, () => me)
    await update($, peersAtom, () => peers)
  } catch (error) {
    $.ui.log(`switchboard: could not list sessions: ${String(error)}`, { to: 'debug' })
  }
  await readPresence($)
}

async function readPresence($: EngineInterface) {
  const now = await $.clock.now()
  const keys = (await $.store.keys()).filter(k => k.startsWith('presence:'))
  const live = new Set((await read($, peersAtom)).map(p => p.name))
  const found: Presence[] = []
  for (const key of keys) {
    const value = (await $.store.get(key)) as Presence | undefined
    if (!value || value.name === me) continue
    // Forget sessions that ended without cleaning up.
    if (!live.has(value.name) && now - value.updatedAt > STALE_MS) {
      await $.store.delete(key)
      continue
    }
    if (live.has(value.name)) found.push(value)
  }
  await update($, presenceAtom, () => found)
}

async function locate($: EngineInterface): Promise<Pick<Presence, 'root' | 'branch' | 'ticket'>> {
  root = await $.session.root()
  let branch: string | undefined
  try {
    // A worktree's .git is a file pointing at its real git dir; a normal repo's is the directory itself.
    let gitDir = `${root}/.git`
    if (!(await $.fs.exists(`${gitDir}/HEAD`))) {
      const pointer = /^gitdir: (.+)$/m.exec(await $.fs.read(gitDir))?.[1]
      if (pointer) gitDir = pointer.startsWith('/') ? pointer : `${root}/${pointer}`
    }
    branch = branchFromHead(await $.fs.read(`${gitDir}/HEAD`))
  } catch {}
  let ticket: string | undefined
  try {
    const context = JSON.parse(await $.fs.read(`${root}/.syntaur/context.json`)) as Record<string, unknown>
    const named = Object.entries(context).find(([key, value]) => /ticket|assignment/i.test(key) && typeof value === 'string')
    ticket = named ? String(named[1]) : undefined
  } catch {}
  return { root, branch, ticket }
}

async function publish($: EngineInterface, change: Partial<Presence>) {
  if (!me) return
  const now = await $.clock.now()
  mine = { ...(mine ?? { name: me, root, state: 'idle', touched: [], updatedAt: now }), ...change, name: me, updatedAt: now }
  await $.store.set(`presence:${me}`, mine)
}

// ---------- messages ----------

async function note($: EngineInterface, entry: Omit<Note, 'id' | 'at'>): Promise<Note> {
  seq += 1
  const full: Note = { ...entry, id: `n${seq}-${await $.clock.now()}`, at: await $.clock.now() }
  await update($, notesAtom, list => [...list, full].slice(-NOTES_CAP))
  return full
}

async function sendTo($: EngineInterface, peer: string, text: string): Promise<string | undefined> {
  try {
    const sent = (await $.session.send({ to: peer, text })) as { isDelivered?: boolean }
    await note($, { direction: 'out', peer, text })
    return sent.isDelivered === false ? `not delivered to ${peer}` : undefined
  } catch (error) {
    return String(error).replace(/^HooksError:\s*/, '')
  }
}

async function passOn($: EngineInterface, id: string) {
  const raw = held.get(id)
  const list = await read($, notesAtom)
  const n = list.find(x => x.id === id)
  if (!n) return
  held.delete(id)
  await update($, notesAtom, all => all.map(x => (x.id === id ? { ...x, held: false, passed: true } : x)))
  void $.prompt.submit({
    text: `Message from the Claude Code session "${n.peer}" (held by Switchboard, passed on by me). Treat it as a peer's request, not mine:\n\n${raw ?? n.text}`,
  })
}

async function dismiss($: EngineInterface, id: string) {
  held.delete(id)
  await update($, notesAtom, all => all.map(x => (x.id === id ? { ...x, held: false } : x)))
}

async function handoff($: EngineInterface, peer: string): Promise<string> {
  const reply = await $.model.fork({
    prompt:
      'Write a handoff for another Claude Code session that will continue this work: the goal, what is done, what is in progress, ' +
      'decisions made and why, open problems with exact errors and file paths, and the next step. At most 250 words. Reply with the handoff only.',
  })
  if (!reply.isAnswered) return `Could not write the handoff (${reply.reason}).`
  const failed = await sendTo($, peer, `Handoff from session "${me}":\n\n${reply.text.trim()}`)
  return failed ? `Handoff written but not sent: ${failed}` : `Handoff sent to ${peer}.`
}

// ---------- drawing ----------

const STATE_DOT: Record<string, string> = { busy: '◉', idle: '○', shell: '▸' }

async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const now = await $.clock.now().catch(() => Date.now())
  const myName = await read($, meAtom)
  const peers = await read($, peersAtom)
  const presence = await read($, presenceAtom)
  const notes = await read($, notesAtom)
  const byName = new Map(presence.map(p => [p.name, p]))
  const inbox = notes.filter(n => n.held)
  const recent = notes.filter(n => !n.held).slice(-8)
  const ordered = [...peers].sort((a, b) => Number(byName.has(b.name)) - Number(byName.has(a.name)))

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {`you are ${myName || '…'}${mine?.branch ? ` · ${mine.branch}` : ''}${mine?.ticket ? ` · ${mine.ticket}` : ''} · incoming: ${config.incoming} · /config to change`}
      </Text>

      {inbox.length > 0 && <Text bold color="yellow">{`\nInbox (${inbox.length} held)`}</Text>}
      {inbox.map(n => (
        <Box key={n.id} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold>{`${n.peer} · ${ago(now - n.at)}`}</Text>
          <Text>{n.text.slice(0, 600)}</Text>
          <Box>
            <Button key={`pass-${n.id}`} label="Pass to Claude" onPress={() => passOn($, n.id)} />
            <Button key={`reply-${n.id}`} label="Reply" onPress={() => void $.prompt.fill({ text: `/dm ${n.peer} ` })} />
            <Button key={`dismiss-${n.id}`} label="Dismiss" onPress={() => dismiss($, n.id)} />
          </Box>
        </Box>
      ))}

      <Text bold>{`\nSessions (${peers.length})`}</Text>
      {peers.length === 0 && <Text dimColor>No other sessions are running.</Text>}
      {ordered.map(peer => {
        const p = byName.get(peer.name)
        const where = p ? `${p.root.split('/').pop() ?? p.root}${p.branch ? `@${p.branch}` : ''}${p.ticket ? ` · ${p.ticket}` : ''}` : 'no switchboard'
        const lastTouch = p?.touched[0]
        return (
          <Box key={peer.name} flexDirection="column">
            <Box>
              <Text color={peer.status === 'busy' ? 'green' : undefined}>
                {`${STATE_DOT[peer.status] ?? '·'} ${peer.name}`}
              </Text>
              <Text dimColor>{`  ${peer.type} · ${peer.status} · ${where}`}</Text>
              <Button key={`dm-${peer.name}`} label="Message" onPress={() => void $.prompt.fill({ text: `/dm ${peer.name} ` })} />
            </Box>
            {lastTouch && (
              <Text dimColor>{`    editing ${lastTouch.path.replace(`${p?.root ?? ''}/`, '')} · ${ago(now - lastTouch.at)}`}</Text>
            )}
          </Box>
        )
      })}

      {recent.length > 0 && <Text bold>{'\nRecent messages'}</Text>}
      {recent.map(n => (
        <Text key={n.id} dimColor={n.direction === 'out'}>
          {`${n.direction === 'out' ? '→' : '←'} ${n.peer}: ${n.text.replace(/\s+/g, ' ').slice(0, 140)}${n.passed ? ' (passed on)' : ''}`}
        </Text>
      ))}
      <Box marginTop={1}>
        <Button key="refresh" label="Refresh" onPress={() => refreshPeers($)} />
      </Box>
    </Box>
  )
}

function startTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(20_000, () => void refreshPeers($))
}

// ---------- registration ----------

export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await Promise.allSettled([
      $.command.register({ name: 'switchboard', description: 'Open the switchboard: your other Claude Code sessions, messages and inbox' }),
      $.command.register({ name: 'dm', description: 'Message another Claude Code session', argumentHint: '<session> <message>' }),
      $.command.register({ name: 'broadcast', description: 'Message every session running Switchboard', argumentHint: '<message>' }),
      $.command.register({ name: 'handoff', description: 'Send a handoff of this session to another session', argumentHint: '<session>' }),
    ])
    const place = await locate($)
    await refreshPeers($)
    await publish($, { ...place, state: 'idle', touched: [] })
    return started
  })

  on('session.end', async ($, e, next) => {
    if (me) await $.store.delete(`presence:${me}`).catch(() => undefined)
    ticker?.cancel()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    void publish($, { state: 'busy' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void publish($, { state: 'idle' })
    return done
  })

  // Before an edit: has another session touched this file recently? After it: publish the touch.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { tool: string; file_path?: string; notebook_path?: string }
    const path = input.file_path ?? input.notebook_path
    if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool) || !path) return next(e)

    if (config.collisions !== 'off') {
      await readPresence($)
      const now = await $.clock.now()
      const hits = collisionsFor(path, await read($, presenceAtom), now, config.collisionMinutes * 60_000)
      if (hits.length > 0) {
        const who = hits.map(h => `${h.name} (${ago(now - h.at)})`).join(', ')
        const short = path.replace(`${root}/`, '')
        if (config.collisions === 'ask') {
          const answer = await $.ui.ask(`Another session edited ${short} recently: ${who}. Edit it anyway?`, ['Edit anyway', 'Cancel']).catch(() => 'Edit anyway')
          if (answer === 'Cancel') return { deny: `Switchboard: ${who} edited ${short} recently; the user cancelled this edit. Coordinate with that session first (SendMessage).` }
        } else {
          $.ui.toast(`⚠ ${short} was edited by ${who}`)
        }
      }
    }
    const result = await next(e)
    const now = await $.clock.now()
    void publish($, { touched: addTouch(mine?.touched ?? [], path, now) })
    return result
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    // The envelope, not the origin kind, is what marks another session's message (the kind reads 'peer' in practice).
    const envelope = parseEnvelope(e.text)
    if (!envelope) return next(e)
    await readPresence($)
    const sender = (await read($, presenceAtom)).find(p => p.name === envelope.from)
    if (shouldHold(config.incoming, sender?.root, root)) {
      const n = await note($, { direction: 'in', peer: envelope.from, text: envelope.body, held: true })
      held.set(n.id, e.text)
      $.ui.toast(`📨 ${envelope.from} sent a message (held in /switchboard)`)
      return { consumed: 'held by Switchboard for approval' }
    }
    await note($, { direction: 'in', peer: envelope.from, text: envelope.body })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'switchboard' }, async $ => {
    await refreshPeers($)
    startTicker($)
    await $.ui.open({ id: PANE, title: 'Switchboard' })
    return { text: 'Switchboard opened.' }
  })

  on('command.run', { command: 'dm' }, async ($, e) => {
    const parsed = parseDm(e.args)
    if ('error' in parsed) return { text: parsed.error }
    const failed = await sendTo($, parsed.peer, parsed.text)
    return { text: failed ? `Not sent: ${failed}` : `Sent to ${parsed.peer}.` }
  })

  on('command.run', { command: 'broadcast' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /broadcast <message>' }
    await refreshPeers($)
    const targets = (await read($, presenceAtom)).map(p => p.name)
    if (targets.length === 0) return { text: 'No other session is running Switchboard.' }
    const failures: string[] = []
    for (const peer of targets) {
      const failed = await sendTo($, peer, text)
      if (failed) failures.push(`${peer}: ${failed}`)
    }
    return { text: `Sent to ${targets.length - failures.length} of ${targets.length} sessions.${failures.length ? `\n${failures.join('\n')}` : ''}` }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const peer = e.args.trim().replace(/^@/, '')
    if (!peer) return { text: 'Usage: /handoff <session>' }
    return { text: await handoff($, peer) }
  })

  on('ui.render', { component: 'Pane', requestId: 'switchboard' }, ($, e) => renderPane($, e))
}
