export type Limit = { percent: number; resetsAt?: string }

export type Usage = {
  session: Limit | null
  weekly: Limit | null
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number
}

declare module 'claude-code' {
  interface PluginState {
    'spend-bar': {
      usage: Usage | null
      lastResponseAt: number | null
      now: number
      isCompacting: boolean
    }
  }
}
