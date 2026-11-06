// Burn rate: counted tokens per minute over the last few minutes, and which
// lighter model to suggest when it runs high. Pure functions, no engine calls.

export const RATE_WINDOW_MS = 5 * 60_000
export const DEFAULT_RATE_LIMIT = 40_000
/** At most one burn-rate suggestion this often. */
export const RATE_WARN_EVERY_MS = 15 * 60_000

/** [when, counted tokens] for each request inside the window. */
export type Recent = [ts: number, counted: number][]

/** Requests still inside the window, oldest first. */
export const prune = (recent: Recent, now: number): Recent => recent.filter(([ts]) => now - ts < RATE_WINDOW_MS)

/**
 * Counted tokens per minute. Divides by the full window, not by the time since
 * the first request, so one large request on its own can't look like a burn.
 */
export const perMinute = (recent: Recent, now: number): number =>
  Math.round(prune(recent, now).reduce((s, [, c]) => s + c, 0) / (RATE_WINDOW_MS / 60_000))

/** A readable name from a model id: `claude-opus-5-5` → `Opus 5.5`. */
export const modelName = (model: string): string => {
  const m = model.toLowerCase().match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/)
  if (!m || !m[1]) return model
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** One step lighter: Fable/Mythos/Opus → Sonnet, Sonnet → Haiku, Haiku → none. */
export const lighterModel = (model: string): { alias: string; name: string } | undefined => {
  const m = model.toLowerCase()
  if (/fable|mythos|opus/.test(m)) return { alias: 'sonnet', name: 'Sonnet' }
  if (/sonnet/.test(m)) return { alias: 'haiku', name: 'Haiku' }
  return undefined
}

/** The pop-up's text: suggests a lighter model where there is one, else a smaller context. */
export const burnMessage = (model: string | undefined, rate: number, fmt: (n: number) => string): string => {
  const on = model ? ` on ${modelName(model)}` : ''
  const lighter = model ? lighterModel(model) : undefined
  return lighter
    ? `Token meter: burning ~${fmt(rate)} tokens/min${on}. For work that doesn't need it, ${lighter.name} costs much less: /model ${lighter.alias}`
    : `Token meter: burning ~${fmt(rate)} tokens/min${on}. /compact, or a new session for the next task, would slow it down.`
}
