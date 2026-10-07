export type PeerRow = { name: string; ref: string; type: string; status: string }
export type Touch = { path: string; at: number }
// What each session running Switchboard publishes in the shared store, under `presence:<name>`.
export type Presence = {
  name: string
  root: string
  branch?: string
  ticket?: string
  state: 'busy' | 'idle'
  touched: Touch[]
  updatedAt: number
}
export type Note = {
  id: string
  at: number
  direction: 'in' | 'out'
  peer: string
  text: string
  held?: boolean
  passed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    switchboard: { me: string; peers: PeerRow[]; presence: Presence[]; notes: Note[] }
  }
}
