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
//   {type:'chunk',agent,turn,text} {type:'tool',agent,turn,id,title,status}
//   {type:'turn_end',agent,turn,stopReason} {type:'turn_error',agent,turn,message}
//   {type:'permission',agent,id,title,options:[{optionId,name,kind}]} {type:'log',message}
// HTTP (POST, JSON body): /prompt {agent,turn,text}  /permission {id,optionId|null}
//   /cancel {agent}  /reset {agent}  /wait {turn,timeoutMs}  GET /health

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

// Measured adapter facts from Syntaur's ACP spike: codex and claude inherit xhigh effort (25 s
// to the first token), cursor has no effort option, all three take a chat-safe mode. The room's
// Claude is a full Claude Code session that loads the user's plugins, this mod included:
// SECOND_OPINION_IN_ROOM tells the mod there to stay out of the way (no room inside the room).
const HARNESSES = {
  codex: {
    argv: ['codex-acp'],
    mode: 'read-only',
    config: { reasoning_effort: 'medium' },
    install: 'npm i -g @agentclientprotocol/codex-acp, then sign in with `codex login`',
  },
  cursor: {
    argv: ['cursor-agent', 'acp'],
    mode: 'ask',
    config: {},
    install: 'curl https://cursor.com/install -fsS | bash, then sign in with `cursor-agent login`',
  },
  claude: {
    argv: ['claude-agent-acp'],
    mode: 'default',
    config: { effort: 'medium' },
    env: { SECOND_OPINION_IN_ROOM: '1' },
    install: 'npm i -g @agentclientprotocol/claude-agent-acp',
  },
}
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000

// Every turn's reply is also kept here, so /wait can hand it back whole (the mod's tool
// hook waits on that long-poll: its own clock stops during a $ call, not a bare promise).
const turns = new Map()
const turnOf = turn => {
  if (!turns.has(turn)) turns.set(turn, { text: '', done: false, waiters: [] })
  return turns.get(turn)
}
const settleTurn = (turn, fields) => {
  const one = turnOf(turn)
  Object.assign(one, fields, { done: true })
  for (const wake of one.waiters.splice(0)) wake()
}

const emit = event => {
  if (event.type === 'chunk') turnOf(event.turn).text += event.text
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
      if (this.spec.mode) {
        await this.request('session/set_mode', { sessionId: this.sessionId, modeId: this.spec.mode }).catch(error =>
          log(`${this.agent}: set_mode ${this.spec.mode} refused: ${error.message}`),
        )
      }
      for (const [configId, value] of Object.entries(this.spec.config)) {
        await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value }).catch(error =>
          log(`${this.agent}: ${configId}=${value} refused: ${error.message}`),
        )
      }
      emit({ type: 'status', agent: this.agent, state: 'ready' })
    })()
    this.ready.catch(error => this.fail(error.message))
    return this.ready
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
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        // codex's startup notice arrives without a messageId; real chunks carry one.
        if (this.agent === 'codex' && !update.messageId) return
        if (update.content?.type === 'text' && update.content.text) {
          emit({ type: 'chunk', agent: this.agent, turn, text: update.content.text })
        }
        return
      case 'tool_call':
      case 'tool_call_update':
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

  async onRequest(message) {
    const { id, method, params } = message
    if (method === 'session/request_permission') {
      const permissionId = `${this.agent}-${id}`
      const answer = await askPermission(permissionId, this.agent, params)
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
    try {
      await this.start()
      emit({ type: 'status', agent: this.agent, state: 'busy' })
      const result = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
      emit({ type: 'turn_end', agent: this.agent, turn, stopReason: result.stopReason ?? 'end_turn' })
    } catch (error) {
      emit({ type: 'turn_error', agent: this.agent, turn, message: error.message })
    } finally {
      if (this.running?.turn === turn) this.running = null
      if (!this.dead) emit({ type: 'status', agent: this.agent, state: this.queue.length ? 'busy' : 'ready' })
      void this.pump()
    }
  }

  cancel() {
    this.queue = []
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

function askPermission(id, agent, params) {
  return new Promise(resolve => {
    const timer = setTimeout(() => settle(null), PERMISSION_TIMEOUT_MS)
    const settle = optionId => {
      clearTimeout(timer)
      permissions.delete(id)
      resolve(optionId)
    }
    permissions.set(id, settle)
    emit({
      type: 'permission',
      agent,
      id,
      title: params?.toolCall?.title ?? 'Permission requested',
      options: (params?.options ?? []).map(({ optionId, name, kind }) => ({ optionId, name, kind })),
    })
  })
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
      case '/prompt':
        adapterFor(body.agent).prompt(body.turn, body.text)
        return reply(202, { ok: true })
      case '/wait': {
        // Long-poll: answer when the turn ends, or after timeoutMs with done:false.
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
        const { text, done, stopReason, error } = one
        return reply(200, { ok: true, done, text, stopReason, error })
      }
      case '/permission':
        permissions.get(body.id)?.(body.optionId ?? null)
        return reply(200, { ok: true })
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
