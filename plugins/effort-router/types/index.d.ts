declare module 'claude-code' {
  interface PluginState {
    'effort-router': {
      // Whether the settings pane should be open, so a reload can put it back
      paneOpen: boolean
      // The last lines the pane's test button, try field and saves produced
      testResult: string
      notice: string
      // Whether the pane shows the field to paste a new key
      keyEditing: boolean
      // Whether the Classifier row is expanded
      classifierOpen: boolean
    }
  }
}
