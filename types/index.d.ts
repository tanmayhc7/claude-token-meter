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

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      usage: Shaped<Usage>
      budget: Shaped<Budget>
      /** Warnings already raised this session, as `tokens-80`, `usd-100`, ... */
      warned: Shaped<string[]>
    }
  }
}
