export type Limit = { percent: number; resetsAt?: string }

export type Usage = {
  session: Limit | null
  weekly: Limit | null
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number
  // A gateway's spend limit, percent used.
  spendLimit: Limit | null
}

// The month's extra-usage spend on a usage-billed seat (Enterprise, Team), from the desktop app.
export type Monthly = {
  spent: number
  limit: number
  percent: number
  currency: string
  plan: string | null
  readAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'spend-bar': {
      usage: Usage | null
      lastResponseAt: number | null
      now: number
      isCompacting: boolean
      isOptimizing: boolean
      monthly: Monthly | null
      sessionUsd: number | null
    }
  }
}
