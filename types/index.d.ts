export type Usage = {
  /** Uncached input tokens, summed over every model request this session. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
  /** Estimated output tokens of the responses streaming right now (chars / 4). */
  streaming: number
  model?: string
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
  /** The engine's own cost ledger for the session, in US dollars. */
  costUsd?: number
}

/** Limits for one session; either may be absent. Kept in $.store too. */
export type Budget = { tokens?: number; usd?: number }

/** A limit shared by every session on this machine, over a rolling window of hours. */
export type GlobalBudget = { tokens?: number; usd?: number; windowHours: number }

/** Every session's usage inside the global window. */
export type GlobalUsage = {
  windowHours: number
  /** Sessions with a request inside the window, or streaming now. */
  sessions: number
  streamingSessions: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Estimated from list prices, per request. */
  usd: number
  /** Estimated output tokens streaming right now, in every session. */
  streaming: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      usage: Shaped<Usage>
      budget: Shaped<Budget>
      global: Shaped<GlobalUsage | null>
      globalBudget: Shaped<GlobalBudget>
      /** Warnings already raised this session, as `tokens-80`, `all-usd-100`, ... */
      warned: Shaped<string[]>
    }
  }
}
