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
  // While streaming, the segment being written; once done, the answer (the last segment with text).
  text: string
  // The agent's narration between tool calls ("I'll check the tests…"), folded away under the answer.
  notes?: string[]
  segment?: number
  to?: Speaker[]
  hop?: number
  isStreaming?: boolean
  isError?: boolean
  isStopped?: boolean
  tools?: RoomTool[]
  startedAt?: number
  endedAt?: number
}
export type PermissionOption = { optionId: string; name: string; kind: string }
export type PermissionCard = { id: string; agent: Agent; title: string; detail?: string; options: PermissionOption[] }
export type AgentState = 'idle' | 'starting' | 'ready' | 'busy' | 'error'
// What the room's agents may do: read only (plan), ask first, edit the repository, decide with an
// automatic review, or everything (bypass). Inherited from the main session's permission mode.
export type Access = 'read' | 'ask' | 'edit' | 'auto' | 'full'
export type Choice = { value: string; name: string }
// A pickable config option an agent reported (its model, its effort), with what is set now.
export type AgentOption = { current: string; values: Choice[] }
export type AgentOptions = { model?: AgentOption; effort?: AgentOption; isLoading?: boolean }
// The person's picks, kept across sessions in $.store.
export type ModelPrefs = Partial<Record<Agent, { model?: string; effort?: string }>>
export type Room = {
  messages: RoomMessage[]
  status: Record<Agent, AgentState>
  detail: string
  permissions: PermissionCard[]
  defaultAgent: Agent
  access: Access
  models: Partial<Record<Agent, AgentOptions>>
  prefs: ModelPrefs
}

declare module 'claude-code' {
  interface PluginState {
    'room': { runs: Run[]; now: number; room: Room }
  }
}
