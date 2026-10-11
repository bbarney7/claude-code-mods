#!/usr/bin/env node
// ACP bridge for the second-opinion mod: the mod cannot hold a child's stdin open, so this
// process does. It keeps one long-lived ACP adapter per agent (codex-acp, cursor-agent acp),
// takes commands over HTTP on a Unix socket, and reports everything as ndjson on stdout,
// which the mod reads through $.process.spawn. Same shape as Syntaur's chat broker, minus
// persistence: the bridge lives and dies with the Claude Code session.
//
//   node acp-bridge.mjs --socket /tmp/x.sock --cwd /path/to/repo
//
// stdout events: {type:'listening'} {type:'status',agent,state,detail?}
//   {type:'chunk',agent,turn,segment,text} {type:'tool',agent,turn,id,title,status}
//   {type:'turn_end',agent,turn,stopReason} {type:'turn_error',agent,turn,message}
//   {type:'permission',agent,id,title,detail?,options:[{optionId,name,kind}]} {type:'permission_closed',id}
//   {type:'permission_auto',agent,turn,id,title,option} {type:'options',agent,mode,options:[{id,category,current,values}]}
//   {type:'config_error',agent,message} {type:'log',message}
// HTTP (POST, JSON body): /prompt {agent,turn,text,settings?}  /configure {agent,settings,start?}
//   /permission {id,optionId|null}  /cancel {agent}  /reset {agent}  /wait {turn,timeoutMs}  GET /health
// settings: {mode?, model?, effort?, autoApprove?}: the ACP mode id, the model and effort config
// values, and whether to answer the agent's permission requests itself (the main session bypasses).
//
// A turn's reply arrives as segments: the agent's narration between tool calls ("I'll check the
// tests…") and its final answer are separate messages. A new message id, or a tool call after some
// text, starts the next segment, so the room can show the answer and fold the narration away.

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
)
const SOCKET = args.socket
const CWD = args.cwd || process.cwd()
if (!SOCKET) {
  console.error('usage: acp-bridge.mjs --socket <path> [--cwd <dir>]')
  process.exit(2)
}

// Measured adapter facts from Syntaur's ACP spike: codex and claude inherit the user's effort
// (xhigh: 25 s to the first token), so the room asks for medium unless the person picks one;
// cursor has no effort option. The mode comes from the mod with each prompt. The room's Claude
// is a full Claude Code session that loads the user's plugins, this mod included:
// SECOND_OPINION_IN_ROOM tells the mod there to stay out of the way (no room inside the room).
const HARNESSES = {
  codex: {
    argv: ['codex-acp'],
    effort: 'medium',
    install: 'npm i -g @agentclientprotocol/codex-acp (2.x for the gpt-6 models), then sign in with `codex login`',
  },
  cursor: {
    argv: ['cursor-agent', 'acp'],
    install: 'curl https://cursor.com/install -fsS | bash, then sign in with `cursor-agent login`',
  },
  claude: {
    argv: ['claude-agent-acp'],
    effort: 'medium',
    env: { SECOND_OPINION_IN_ROOM: '1' },
    install: 'npm i -g @agentclientprotocol/claude-agent-acp',
  },
}
// The config options the room lets the person pick, by their ACP category.
const PICKED = { model: 'model', effort: 'thought_level' }
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000

// Every turn's reply is also kept here, so /wait can hand it back (the mod's tool hook waits on
// that long-poll: its own clock stops during a $ call, not a bare promise). The answer is the
// last segment; the ones before it are narration.
const turns = new Map()
const turnOf = turn => {
  if (!turns.has(turn)) turns.set(turn, { segments: [], done: false, waiters: [] })
  return turns.get(turn)
}
const settleTurn = (turn, fields) => {
  const one = turnOf(turn)
  Object.assign(one, fields, { done: true })
  for (const wake of one.waiters.splice(0)) wake()
}

const emit = event => {
  if (event.type === 'chunk') {
    const { segments } = turnOf(event.turn)
    segments[event.segment] = (segments[event.segment] ?? '') + event.text
  }
  if (event.type === 'turn_end') settleTurn(event.turn, { stopReason: event.stopReason })
  if (event.type === 'turn_error') settleTurn(event.turn, { error: event.message })
  process.stdout.write(`${JSON.stringify(event)}\n`)
}
const log = message => emit({ type: 'log', message })

// ---------- one adapter: JSON-RPC 2.0 over ndjson stdio ----------

class Adapter {
  constructor(agent) {
    this.agent = agent
    this.spec = HARNESSES[agent]
    this.nextId = 1
    this.pending = new Map()
    this.sessionId = null
    this.queue = []
    this.running = null
    this.ready = null
    this.stderr = ''
    // What the mod asked for, what the agent last confirmed, and its pickable config options.
    this.want = { effort: this.spec.effort }
    this.mode = null
    this.options = []
    this.autoApprove = false
    this.segment = { index: 0, hasText: false, messageId: null }
    // Tool titles by call id: codex asks to "Run command" and names the command only on the call.
    this.toolTitles = new Map()
  }

  start() {
    if (this.ready) return this.ready
    emit({ type: 'status', agent: this.agent, state: 'starting' })
    const [cmd, ...rest] = this.spec.argv
    // detached: its own process group, so teardown can kill the adapter's children too.
    this.child = spawn(cmd, rest, {
      cwd: CWD,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.child.on('error', error =>
      this.fail(
        error.code === 'ENOENT'
          ? `${cmd} is not installed or not on PATH. Install it: ${this.spec.install}`
          : `could not start ${cmd}: ${error.message}`,
      ),
    )
    this.child.on('exit', (code, signal) => this.fail(`${cmd} exited (${signal ?? code})`))
    this.child.stderr.on('data', data => {
      this.stderr = (this.stderr + data.toString()).slice(-4000)
    })
    createInterface({ input: this.child.stdout }).on('line', line => this.onLine(line))

    this.ready = (async () => {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'second-opinion', version: '0.2.0' },
      })
      const made = await this.request('session/new', { cwd: CWD, mcpServers: [] })
      this.sessionId = made.sessionId
      this.mode = made.modes?.currentModeId ?? null
      this.options = made.configOptions ?? []
      await this.apply()
      emit({ type: 'status', agent: this.agent, state: 'ready' })
    })()
    this.ready.catch(error => this.fail(error.message))
    return this.ready
  }

  // Merges what the mod wants; applied now when the session is idle, else before the next prompt.
  configure(settings = {}) {
    for (const key of ['mode', 'model', 'effort']) if (typeof settings[key] === 'string' && settings[key]) this.want[key] = settings[key]
    if (typeof settings.autoApprove === 'boolean') this.autoApprove = settings.autoApprove
    if (this.sessionId && !this.running) void this.apply()
  }

  // One pass at a time; a call during a pass runs another after it, for what changed meanwhile.
  async apply() {
    if (this.applying) return this.applying.then(() => this.apply())
    this.applying = (async () => {
      let changed = false
      if (this.want.mode && this.want.mode !== this.mode) {
        await this.request('session/set_mode', { sessionId: this.sessionId, modeId: this.want.mode })
          .then(() => {
            this.mode = this.want.mode
            changed = true
          })
          .catch(error => {
            this.refused(`mode ${this.want.mode}`, error)
            delete this.want.mode
          })
      }
      // The model first: another model can offer other effort levels.
      for (const key of ['model', 'effort']) {
        const option = this.options.find(o => o.category === PICKED[key])
        const value = this.want[key]
        if (!option || !value || option.currentValue === value) continue
        if (!optionValues(option).some(v => v.value === value)) {
          this.refused(`${key} ${value}`, new Error(`not offered (${optionValues(option).map(v => v.value).join(', ')})`))
          delete this.want[key]
          continue
        }
        await this.request('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value })
          .then(result => {
            if (Array.isArray(result?.configOptions)) this.options = result.configOptions
            else option.currentValue = value
            changed = true
          })
          .catch(error => {
            this.refused(`${key} ${value}`, error)
            delete this.want[key]
          })
      }
      if (changed || !this.reported) this.report()
    })().finally(() => (this.applying = null))
    return this.applying
  }

  refused(what, error) {
    log(`${this.agent}: ${what} refused: ${error.message}`)
    emit({ type: 'config_error', agent: this.agent, message: `${what}: ${error.message}` })
  }

  report() {
    this.reported = true
    const options = this.options
      .filter(o => Object.values(PICKED).includes(o.category))
      .map(o => ({ id: o.id, category: o.category, current: o.currentValue, values: optionValues(o) }))
    emit({ type: 'options', agent: this.agent, mode: this.mode, options })
  }

  fail(message) {
    if (this.dead) return
    this.dead = true
    const detail = this.stderr.trim().split('\n').slice(-3).join(' | ')
    emit({ type: 'status', agent: this.agent, state: 'error', detail: detail ? `${message}: ${detail}` : message })
    for (const { reject } of this.pending.values()) reject(new Error(message))
    this.pending.clear()
    if (this.running) emit({ type: 'turn_error', agent: this.agent, turn: this.running.turn, message })
    for (const queued of this.queue) emit({ type: 'turn_error', agent: this.agent, turn: queued.turn, message })
    this.queue = []
    this.running = null
    adapters.delete(this.agent)
  }

  send(message) {
    if (!this.child?.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) {
        // Adapters put the useful part (a usage limit, an auth failure) in error.data.
        const { message: text, data } = message.error
        const detail = data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data)
        waiter.reject(new Error([text, detail].filter(Boolean).join(': ').slice(0, 600) || 'unknown error'))
      }
      else waiter.resolve(message.result ?? {})
      return
    }
    if (message.method === 'session/update') return this.onUpdate(message.params?.update ?? {})
    if (message.id !== undefined) return this.onRequest(message)
  }

  onUpdate(update) {
    const turn = this.running?.turn
    if (!turn) return
    const seg = this.segment
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        // codex's startup notice arrives without a messageId; real chunks carry one.
        if (this.agent === 'codex' && !update.messageId) return
        if (update.messageId && seg.messageId && update.messageId !== seg.messageId && seg.hasText) this.nextSegment()
        if (update.messageId) seg.messageId = update.messageId
        if (update.content?.type === 'text' && update.content.text) {
          seg.hasText = true
          emit({ type: 'chunk', agent: this.agent, turn, segment: seg.index, text: update.content.text })
        }
        return
      }
      case 'tool_call':
      case 'tool_call_update':
        // Text before a tool call was narration: what follows starts a new segment.
        if (update.sessionUpdate === 'tool_call' && seg.hasText) this.nextSegment()
        if (update.title && update.toolCallId) this.toolTitles.set(update.toolCallId, update.title)
        if (update.title || update.status) {
          emit({
            type: 'tool',
            agent: this.agent,
            turn,
            id: update.toolCallId,
            title: update.title,
            status: update.status,
          })
        }
        return
    }
  }

  nextSegment() {
    this.segment = { index: this.segment.index + 1, hasText: false, messageId: null }
  }

  async onRequest(message) {
    const { id, method, params } = message
    if (method === 'session/request_permission') {
      const permissionId = `${this.agent}-${this.sessionId?.slice(-6) ?? 's'}-${id}`
      const call = params?.toolCall ?? {}
      const command = Array.isArray(call.rawInput?.command) ? call.rawInput.command.join(' ') : call.rawInput?.command
      const named = this.toolTitles.get(call.toolCallId) ?? command
      const detail = named && named !== call.title ? String(named).slice(0, 400) : undefined
      const answer = this.autoApprove ? autoAnswer(this.agent, params, this.running?.turn, detail) : await askPermission(permissionId, this.agent, params, detail)
      const outcome = answer ? { outcome: 'selected', optionId: answer } : { outcome: 'cancelled' }
      return this.send({ id, result: { outcome } })
    }
    if (method === 'cursor/create_plan') return this.send({ id, result: { outcome: { outcome: 'accepted' } } })
    this.send({ id, error: { code: -32601, message: `second-opinion bridge does not handle ${method}` } })
  }

  prompt(turn, text) {
    this.queue.push({ turn, text })
    void this.pump()
  }

  async pump() {
    if (this.running || this.queue.length === 0) return
    this.running = this.queue.shift()
    const { turn, text } = this.running
    this.segment = { index: 0, hasText: false, messageId: null }
    try {
      await this.start()
      await this.apply()
      emit({ type: 'status', agent: this.agent, state: 'busy' })
      const result = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
      emit({ type: 'turn_end', agent: this.agent, turn, stopReason: result.stopReason ?? 'end_turn' })
    } catch (error) {
      emit({ type: 'turn_error', agent: this.agent, turn, message: error.message })
    } finally {
      // A question still open when its turn ended can no longer be answered.
      closePermissions(this.agent)
      if (this.running?.turn === turn) this.running = null
      if (!this.dead) emit({ type: 'status', agent: this.agent, state: this.queue.length ? 'busy' : 'ready' })
      void this.pump()
    }
  }

  cancel() {
    this.queue = []
    closePermissions(this.agent)
    if (this.running && this.sessionId) this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } })
  }

  close() {
    this.dead = true
    try {
      this.child?.stdin.end()
    } catch {}
    killGroup(this.child?.pid)
  }
}

function killGroup(pid) {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
  setTimeout(() => {
    try {
      execFileSync('pgrep', ['-g', String(pid)], { stdio: 'ignore' })
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }, 3000).unref()
}

// ---------- permissions: held until the mod answers ----------

const permissions = new Map()

function askPermission(id, agent, params, detail) {
  return new Promise(resolve => {
    const timer = setTimeout(() => settle(null), PERMISSION_TIMEOUT_MS)
    const settle = optionId => {
      clearTimeout(timer)
      if (permissions.delete(id) && optionId === null) emit({ type: 'permission_closed', id })
      resolve(optionId)
    }
    permissions.set(id, { agent, settle })
    emit({
      type: 'permission',
      agent,
      id,
      title: params?.toolCall?.title ?? 'Permission requested',
      ...(detail ? { detail } : {}),
      options: (params?.options ?? []).map(({ optionId, name, kind }) => ({ optionId, name, kind })),
    })
  })
}

function closePermissions(agent) {
  for (const [id, one] of permissions) if (one.agent === agent) one.settle(null)
}

// With the main session bypassing permissions the room does too: the first allow, once if offered.
function autoAnswer(agent, params, turn, detail) {
  const options = params?.options ?? []
  const pick = options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind === 'allow_always')
  emit({ type: 'permission_auto', agent, turn, id: params?.toolCall?.toolCallId, title: detail ?? params?.toolCall?.title ?? 'a request', option: pick?.name ?? 'none offered' })
  return pick?.optionId ?? null
}

// A select option's values, flattened from groups when the agent groups them.
function optionValues(option) {
  return (option.options ?? []).flatMap(v => (Array.isArray(v.options) ? v.options : [v])).map(v => ({ value: v.value, name: v.name ?? v.value }))
}

// ---------- adapters by agent, the HTTP surface, and teardown ----------

const adapters = new Map()
const adapterFor = agent => {
  if (!HARNESSES[agent]) throw new Error(`unknown agent ${agent}`)
  if (!adapters.has(agent)) adapters.set(agent, new Adapter(agent))
  return adapters.get(agent)
}

const readBody = request =>
  new Promise(resolve => {
    let body = ''
    request.on('data', data => (body += data))
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        resolve({})
      }
    })
  })

const server = createServer(async (request, response) => {
  const reply = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  }
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return reply(200, { ok: true, agents: [...adapters.keys()] })
    }
    const body = await readBody(request)
    switch (request.url) {
      case '/prompt': {
        const adapter = adapterFor(body.agent)
        if (body.settings) adapter.configure(body.settings)
        adapter.prompt(body.turn, body.text)
        return reply(202, { ok: true })
      }
      case '/configure': {
        // start: bring the agent up just to learn its models, for the room's model picker.
        const adapter = adapterFor(body.agent)
        adapter.configure(body.settings ?? {})
        if (body.start) {
          void adapter
            .start()
            .then(() => adapter.reported || adapter.report())
            .catch(() => undefined)
        }
        return reply(200, { ok: true })
      }
      case '/wait': {
        // Long-poll: answer when the turn ends, or after timeoutMs with done:false. The answer is
        // the last segment that has text; the rest was narration.
        const one = turnOf(body.turn)
        if (!one.done) {
          await new Promise(wake => {
            const timer = setTimeout(wake, Math.min(body.timeoutMs ?? 50_000, 120_000))
            one.waiters.push(() => {
              clearTimeout(timer)
              wake()
            })
          })
        }
        const said = one.segments.filter(part => part?.trim())
        const { done, stopReason, error } = one
        return reply(200, { ok: true, done, text: said.at(-1) ?? '', notes: said.length - 1, stopReason, error })
      }
      case '/permission': {
        const one = permissions.get(body.id)
        one?.settle(body.optionId ?? null)
        return reply(200, { ok: true, found: Boolean(one) })
      }
      case '/cancel':
        adapters.get(body.agent)?.cancel()
        return reply(200, { ok: true })
      case '/reset':
        adapters.get(body.agent)?.close()
        adapters.delete(body.agent)
        emit({ type: 'status', agent: body.agent, state: 'idle' })
        return reply(200, { ok: true })
      default:
        return reply(404, { ok: false, error: `no route ${request.url}` })
    }
  } catch (error) {
    reply(400, { ok: false, error: error.message })
  }
})

let closing = false
function shutdown(reason) {
  if (closing) return
  closing = true
  log(`bridge shutting down: ${reason}`)
  for (const adapter of adapters.values()) adapter.close()
  server.close()
  try {
    unlinkSync(SOCKET)
  } catch {}
  setTimeout(() => process.exit(0), 3500).unref()
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(signal))
process.stdout.on('error', () => shutdown('stdout closed'))
// If Claude Code dies without killing us, our parent becomes launchd (ppid 1): leave too.
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) shutdown('parent exited')
}, 5000).unref()

if (existsSync(SOCKET)) unlinkSync(SOCKET)
server.listen(SOCKET, () => emit({ type: 'listening', socket: SOCKET, cwd: CWD }))
