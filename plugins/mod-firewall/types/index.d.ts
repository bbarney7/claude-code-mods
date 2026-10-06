export type Category = 'network' | 'process' | 'secret-file' | 'file-read' | 'file-write' | 'secret-env' | 'env' | 'transcript'
export type Severity = 'info' | 'sensitive' | 'critical'
export type Verdict = 'allowed' | 'asked-allowed' | 'blocked' | 'flagged' | 'info'
export type Risk = 'low' | 'medium' | 'high'

export type ModRecord = {
  name: string
  provenance: string
  badges: string[]
  risk: Risk
  seenAt: 'load' | 'runtime'
  allowed: number
  blocked: number
  refused?: string
}

export type Activity = {
  id: string
  at: number
  mod: string
  category: Category
  target: string
  verdict: Verdict
  reason?: string
}

declare module 'claude-code' {
  interface PluginState {
    'mod-firewall': { mods: ModRecord[]; activity: Activity[]; blockedCount: number }
  }
}
