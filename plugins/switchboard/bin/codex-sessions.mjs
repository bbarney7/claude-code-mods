#!/usr/bin/env node
// Lists Codex sessions for Switchboard, read from Codex's local app-server daemon.
//
//   node codex-sessions.mjs [limit]
//
// Prints one JSON object: { threads: [{ id, name, cwd, status, updatedAt }] }, newest first, or
// { error } when Codex or its daemon isn't there. The daemon speaks JSON-RPC over a WebSocket on
// a Unix socket (~/.codex/app-server-control/app-server-control.sock); messages to a session go
// through `codex queue`, not through here.
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const limit = Math.max(1, Math.min(50, Number(process.argv[2]) || 15))
const done = out => {
  process.stdout.write(`${JSON.stringify(out)}\n`)
  process.exit(0)
}
setTimeout(() => done({ error: 'the Codex daemon did not answer in time' }), 8000).unref()

let path
try {
  path = realpathSync(join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock'))
} catch {
  done({ error: 'the Codex daemon is not running (start it with `codex app-server daemon start`)' })
}

const socket = connect(path)
socket.on('error', error => done({ error: `could not reach the Codex daemon: ${error.message}` }))

let buffer = Buffer.alloc(0)
let upgraded = false
let nextId = 0
const waiting = new Map()

function sendFrame(obj) {
  const data = Buffer.from(JSON.stringify(obj))
  const mask = randomBytes(4)
  const length = data.length
  const header =
    length < 126
      ? Buffer.from([0x81, 0x80 | length])
      : length < 65536
        ? Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([length >> 8, length & 255])])
        : (() => {
            const b = Buffer.alloc(10)
            b[0] = 0x81
            b[1] = 0x80 | 127
            b.writeBigUInt64BE(BigInt(length), 2)
            return b
          })()
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i++) masked[i] = data[i] ^ mask[i % 4]
  socket.write(Buffer.concat([header, mask, masked]))
}

function call(method, params) {
  const id = ++nextId
  sendFrame({ jsonrpc: '2.0', id, method, params })
  return new Promise(resolve => waiting.set(id, resolve))
}

function readFrames() {
  for (;;) {
    if (buffer.length < 2) return
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return
      length = Number(buffer.readBigUInt64BE(2))
      offset = 10
    }
    if (buffer.length < offset + length) return
    const payload = buffer.subarray(offset, offset + length)
    buffer = buffer.subarray(offset + length)
    try {
      const message = JSON.parse(payload.toString())
      if (message.id !== undefined && waiting.has(message.id)) {
        waiting.get(message.id)(message)
        waiting.delete(message.id)
      }
    } catch {
      // a frame that isn't JSON (a ping) is skipped
    }
  }
}

socket.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  if (!upgraded) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const head = buffer.subarray(0, end).toString()
    if (!head.startsWith('HTTP/1.1 101')) done({ error: `the Codex daemon refused the connection: ${head.split('\r\n')[0]}` })
    upgraded = true
    buffer = buffer.subarray(end + 4)
    void run()
  }
  readFrames()
})

socket.on('connect', () => {
  socket.write(
    `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )
})

async function run() {
  const init = await call('initialize', { clientInfo: { name: 'switchboard', version: '0.2.0' } })
  if (init.error) done({ error: `Codex daemon: ${init.error.message ?? 'initialize failed'}` })
  sendFrame({ jsonrpc: '2.0', method: 'initialized' })
  const listed = await call('thread/list', { limit: limit * 2 })
  if (listed.error) done({ error: `Codex daemon: ${listed.error.message ?? 'thread/list failed'}` })
  const threads = (listed.result?.data ?? [])
    // The agent room's own Codex threads open with its system frame; they aren't yours to message.
    .filter(t => !String(t.preview ?? '').startsWith('<system>'))
    .slice(0, limit)
    .map(t => ({
      id: t.id,
      name: t.name || String(t.preview ?? '').split('\n')[0].slice(0, 60) || t.id,
      cwd: t.cwd ?? '',
      status: t.status?.type ?? 'notLoaded',
      updatedAt: Number(t.updatedAt ?? 0) * 1000,
    }))
  done({ threads })
}
