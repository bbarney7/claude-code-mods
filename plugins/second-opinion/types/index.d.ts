// One-shot reviews and delegation run the outside CLIs; the room also holds its own Claude.
export type External = 'codex' | 'cursor'
export type Agent = External | 'claude'
export type Mode = 'review' | 'implement'
export type Run = {
  id: string
  agent: External
  mode: Mode
  task: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  tail: string
  result?: string
  isSent?: boolean
}

// 'main' is the Claude Code session the room was opened from; 'claude' is the room's own Claude.
export type Speaker = 'you' | 'main' | 'system' | Agent
export type RoomTool = { id: string; title: string; status: string }
export type RoomMessage = {
  id: string
  from: Speaker
  text: string
  to?: Speaker[]
  hop?: number
  isStreaming?: boolean
  isError?: boolean
  tools?: RoomTool[]
}
export type PermissionOption = { optionId: string; name: string; kind: string }
export type PermissionCard = { id: string; agent: Agent; title: string; options: PermissionOption[] }
export type AgentState = 'idle' | 'starting' | 'ready' | 'busy' | 'error'
export type Room = {
  messages: RoomMessage[]
  status: Record<Agent, AgentState>
  detail: string
  permissions: PermissionCard[]
  defaultAgent: Agent
}

declare module 'claude-code' {
  interface PluginState {
    'second-opinion': { runs: Run[]; now: number; room: Room }
  }
}
