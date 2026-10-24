export type CtxControlTab = 'skills' | 'tools' | 'files' | 'other'

declare module 'claude-code' {
  interface PluginState {
    'ctx-control': {
      activeTab: CtxControlTab
      filter: string
      page: number
      expandedToolGroups: string[]
      profileNaming: boolean
      profileDraft: string
      profileDeleting: string
    }
  }
}
