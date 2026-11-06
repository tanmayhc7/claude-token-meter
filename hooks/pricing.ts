// US dollars per million tokens, Anthropic first-party API list prices
// (Claude API reference cached 2026-10-06). Cache writes are the 5-minute rate.
// Haiku 5.5 is its <=100K-prompt rate card. Check anthropic.com/pricing before
// budgeting on these.
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

const ALIASES: Record<string, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

/** Finds a price row from an alias, a short name (`opus-5`), or a full or dated id. */
export const findModel = (name: string): string | undefined => {
  const n = name.toLowerCase().replace(/\./g, '-').replace(/\[.*\]$/, '')
  if (ALIASES[n]) return ALIASES[n]
  const full = n.startsWith('claude-') ? n : `claude-${n}`
  if (PRICES[full]) return full
  // Longest id that prefixes the name, so `claude-opus-5-5-x` is not read as `claude-opus-5`.
  return Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find(id => full.startsWith(id))
}

/** Reads `250k`, `1.5M`, `12,000`, `$5`, `5` into a number; NaN if it isn't one. */
export const parseAmount = (s: string): number => {
  const m = s.trim().toLowerCase().replace(/[$,_\s]/g, '').match(/^(\d+(?:\.\d+)?)([km]?)$/)
  if (!m) return NaN
  return Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1)
}

/** What a cache-read token costs next to a fresh input token on this model (0.05 on Opus 5.5, 0.1 on most). */
export const cacheReadWeight = (model?: string): number => {
  const id = model ? findModel(model) : undefined
  const p = id ? PRICES[id] : undefined
  return p ? p.cacheRead / p.input : 0.1
}

/**
 * Tokens as budgets count them: fresh input, cache writes and output in full,
 * cache reads (the conversation re-read on every request) at their price weight.
 */
export const countTokens = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }, weight: number) =>
  t.input + t.output + t.cacheWrite + t.cacheRead * weight

export const cost = (p: Price, t: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) =>
  (t.input * p.input + t.output * p.output + (t.cacheRead ?? 0) * p.cacheRead + (t.cacheWrite ?? 0) * p.cacheWrite) / 1e6

export const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`

export const usd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
