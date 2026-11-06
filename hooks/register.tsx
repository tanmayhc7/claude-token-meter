import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Budget, Burn, GlobalBudget, GlobalUsage, Usage } from '../types'
import {
  DEFAULT_WINDOW_HOURS,
  globalTotal,
  readGlobalBudget,
  totalAll,
  writeGlobalBudget,
  writeOwn,
} from './ledger'
import { DEFAULT_RATE_LIMIT, RATE_WARN_EVERY_MS, burnMessage, perMinute, prune } from './burn'
import { PRICES, cacheReadWeight, cost, countTokens, findModel, fmt, parseAmount, usd } from './pricing'

const PANE = 'token-meter'
const EMPTY: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, streaming: 0 }
const usage = atom({ plugin: 'token-meter', key: 'usage' } as const, EMPTY, { shape: 'usage-1' })
const budget = atom({ plugin: 'token-meter', key: 'budget' } as const, {} as Budget, { shape: 'budget-1' })
const global = atom({ plugin: 'token-meter', key: 'global' } as const, null as GlobalUsage | null, { shape: 'global-1' })
const globalBudget = atom({ plugin: 'token-meter', key: 'globalBudget' } as const, { windowHours: DEFAULT_WINDOW_HOURS } as GlobalBudget, {
  shape: 'gbudget-1',
})
const warned = atom({ plugin: 'token-meter', key: 'warned' } as const, [] as string[], { shape: 'warned-1' })
const burn = atom({ plugin: 'token-meter', key: 'burn' } as const, { recent: [], perMin: 0 } as Burn, { shape: 'burn-1' })
const rateLimit = atom({ plugin: 'token-meter', key: 'rateLimit' } as const, DEFAULT_RATE_LIMIT, { shape: 'rate-1' })
const STORE_BUDGET = 'budget'
const STORE_RATE = 'rateLimit'
const LEVELS = [80, 100] as const
const POLL_MS = 2000
const STREAM_WRITE_MS = 1500

// Module variables start over on a reload; nothing here needs to survive one.
let poll: { cancel: () => void } | undefined
let lastStreamWrite = 0

/** Everything the session's requests processed: input, both cache kinds and output. */
const totalTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite + u.output

/**
 * What the session counts toward a budget: cache reads at their price weight.
 * A value stored before 0.3.0 has no `counted` and is weighed at 0.1.
 */
const countedOf = (u: Usage) => u.counted ?? countTokens(u, 0.1)

/** Above this, the pane suggests shrinking the context: each request re-reads all of it. */
const BIG_CONTEXT = 100_000

const showStatus = async ($: EngineInterface) => {
  const u = await read($, usage)
  const b = await read($, budget)
  const g = await read($, global)
  const gb = await read($, globalBudget)
  const live = u.streaming > 0 ? ` +~${fmt(u.streaming)}` : ''
  const tok = b.tokens ? `${fmt(countedOf(u))}/${fmt(b.tokens)}` : fmt(countedOf(u))
  const ctx = u.contextPercent !== undefined ? ` · ctx ${u.contextPercent}%` : ''
  const money = u.costUsd !== undefined ? ` · ${usd(u.costUsd)}${b.usd ? `/${usd(b.usd)}` : ''}` : ''
  let all = ''
  if (g) {
    const used = g.counted + g.streaming
    all = gb.tokens
      ? ` │ all ${fmt(used)}/${fmt(gb.tokens)} · ${fmt(Math.max(0, gb.tokens - used))} left`
      : gb.usd
        ? ` │ all ~${usd(g.usd)}/${usd(gb.usd)} · ${usd(Math.max(0, gb.usd - g.usd))} left`
        : ` │ all ${fmt(used)} (${gb.windowHours}h)`
  }
  const br = await read($, burn)
  const lim = await read($, rateLimit)
  const hot = lim > 0 && br.perMin >= lim ? ` · ⚡ ${fmt(br.perMin)}/min` : ''
  $.ui.status(`in ${fmt(u.input + u.cacheRead + u.cacheWrite)} · out ${fmt(u.output)}${live} · Σ ${tok}${hot}${ctx}${money}${all}`)
}

/**
 * Adds a finished request (if any) to the rolling window, recomputes the rate,
 * and suggests a lighter model when it stays at or over the limit.
 */
const updateBurn = async ($: EngineInterface, add?: number, model?: string) => {
  const now = await $.clock.now()
  const old = await read($, burn)
  const recent = prune(add !== undefined ? [...old.recent, [now, add]] : old.recent, now)
  const perMin = perMinute(recent, now)
  const lim = await read($, rateLimit)
  const due = lim > 0 && perMin >= lim && now - (old.warnedAt ?? 0) >= RATE_WARN_EVERY_MS
  if (due) $.ui.toast(burnMessage(model ?? (await read($, usage)).model, perMin, fmt), { timeoutMs: 12000 })
  if (add !== undefined || perMin !== old.perMin || due) {
    await update($, burn, b => ({ recent, perMin, warnedAt: due ? now : b.warnedAt }))
    return true
  }
  return false
}

type Check = { key: string; used: number; limit?: number; show: (n: number) => string; scope: string }

/** Raises each warning (80%, then 100%) once; `rearm` lets a rolling window warn again after it drops back. */
const warn = async ($: EngineInterface, checks: Check[], notify: boolean, rearm: boolean) => {
  const done = await read($, warned)
  const fresh: string[] = []
  const cleared: string[] = []
  for (const c of checks) {
    if (!c.limit) continue
    const pct = (c.used / c.limit) * 100
    if (rearm) cleared.push(...LEVELS.filter(l => pct < l).map(l => `${c.key}-${l}`))
    // Only the highest level crossed speaks; lower ones are marked as said.
    const crossed = LEVELS.filter(l => pct >= l && !done.includes(`${c.key}-${l}`))
    if (crossed.length === 0) continue
    const top = crossed[crossed.length - 1] ?? 80
    fresh.push(...crossed.map(l => `${c.key}-${l}`))
    const text =
      top >= 100
        ? `Token meter: over your ${c.scope} budget of ${c.show(c.limit)} (${c.show(c.used)} used)`
        : `Token meter: ${Math.floor(pct)}% of your ${c.show(c.limit)} ${c.scope} budget used`
    $.ui.toast(text, { timeoutMs: top >= 100 ? 10000 : 6000 })
    if (notify) void $.ui.notify(text, { title: 'Token budget' })
  }
  if (fresh.length || cleared.some(k => done.includes(k))) {
    await update($, warned, w => [...w.filter(k => !cleared.includes(k)), ...fresh])
  }
}

const checkSession = async ($: EngineInterface) => {
  const u = await read($, usage)
  const b = await read($, budget)
  await warn(
    $,
    [
      { key: 'tokens', used: countedOf(u), limit: b.tokens, show: n => `${fmt(n)} tokens`, scope: 'session' },
      { key: 'usd', used: u.costUsd ?? 0, limit: b.usd, show: usd, scope: 'session' },
    ],
    true,
    false,
  )
}

/** `notify`: only the session whose own request crossed the line sends the system notification. */
const checkGlobal = async ($: EngineInterface, notify: boolean) => {
  const g = await read($, global)
  const gb = await read($, globalBudget)
  if (!g) return
  const scope = `all-sessions (${gb.windowHours}h)`
  await warn(
    $,
    [
      { key: 'all-tokens', used: g.counted, limit: gb.tokens, show: n => `${fmt(n)} tokens`, scope },
      { key: 'all-usd', used: g.usd, limit: gb.usd, show: n => `~${usd(n)}`, scope },
    ],
    notify,
    true,
  )
}

/** Re-reads every session's file and the shared budget; redraws only when something moved. */
const refreshGlobal = async ($: EngineInterface, notify = false) => {
  const gb = await readGlobalBudget($)
  const g = await totalAll($, gb.windowHours)
  const oldG = await read($, global)
  const oldB = await read($, globalBudget)
  if (JSON.stringify(oldB) !== JSON.stringify(gb)) await update($, globalBudget, () => gb)
  if (JSON.stringify(oldG) !== JSON.stringify(g)) {
    await update($, global, () => g)
    await checkGlobal($, notify)
    await showStatus($)
  }
}

const describe = (b: { tokens?: number; usd?: number }) =>
  [b.tokens && `${fmt(b.tokens)} tokens`, b.usd && usd(b.usd)].filter(Boolean).join(' and ') || 'none'

/** Reads `500k`, `$5` and, for the shared budget, a window such as `5h`, `24h` or `7d`. */
const parseLimits = (words: string[], allowWindow: boolean) => {
  const out: { tokens?: number; usd?: number; windowHours?: number } = {}
  for (const w of words) {
    const win = w.toLowerCase().match(/^(\d+(?:\.\d+)?)([hd])$/)
    if (allowWindow && win) {
      out.windowHours = Number(win[1]) * (win[2] === 'd' ? 24 : 1)
      continue
    }
    const n = parseAmount(w)
    if (!Number.isFinite(n) || n <= 0) return { error: `Couldn't read "${w}". Try 500k, 2M, $5${allowWindow ? ', or a window like 5h or 7d' : ''}.` }
    if (w.includes('$')) out.usd = n
    else out.tokens = n
  }
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tokens', description: 'Open the live token usage pane' })
    await $.command.register({
      name: 'token-budget',
      description: 'Set a budget for this session, or for all sessions with "all"',
      argumentHint: '500k, $5, off, all 5M 5h, or rate 40k',
    })
    await $.command.register({
      name: 'token-cost',
      description: 'Work out what input and output tokens cost on each model',
      argumentHint: '<input> <output> [model]',
      immediate: true,
    })
    // A session budget set in an earlier session carries over.
    const saved = (await $.store.get(STORE_BUDGET)) as Budget | undefined
    if (saved && (saved.tokens || saved.usd)) await update($, budget, () => saved)
    const savedRate = await $.store.get(STORE_RATE)
    if (typeof savedRate === 'number') await update($, rateLimit, () => savedRate)
    await writeOwn($, f => ({ ...f, cwd: e.cwd, streaming: 0 })).catch(() => undefined)
    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => {
      void refreshGlobal($).catch(() => undefined)
      // The rate falls as requests age out of the window, even with no new ones.
      void updateBurn($)
        .then(moved => (moved ? showStatus($) : undefined))
        .catch(() => undefined)
    })
    void refreshGlobal($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: 'Token usage' })
    void showStatus($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    poll?.cancel()
    poll = undefined
    await writeOwn($, f => ({ ...f, streaming: 0 })).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Token usage' })
    return { text: 'Token usage pane opened.' }
  })

  on('command.run', { command: 'token-budget' }, async ($, e) => {
    // The hint's own punctuation is ignored, so `[500k]` and `500k | $5` read as meant.
    const words = e.args.replace(/[[\](){}|,]/g, ' ').trim().split(/\s+/).filter(Boolean)
    const first = words[0]?.toLowerCase()

    if (first === 'rate') {
      const arg = words[1]?.toLowerCase().replace(/\/min$/, '')
      const lim = await read($, rateLimit)
      if (!arg) {
        const br = await read($, burn)
        return {
          text: `Burn rate: ${fmt(br.perMin)} tokens/min over the last 5 minutes. ${lim > 0 ? `You get a lighter-model suggestion at ${fmt(lim)}/min.` : 'Suggestions are off.'}\nChange it with /token-budget rate 60k, or turn it off with /token-budget rate off.`,
        }
      }
      if (arg === 'off') {
        await update($, rateLimit, () => 0)
        await $.store.set(STORE_RATE, 0)
        await showStatus($)
        return { text: 'Burn-rate suggestions are off.' }
      }
      const n = parseAmount(arg)
      if (!Number.isFinite(n) || n <= 0) return { text: `Couldn't read "${words[1]}". Try /token-budget rate 60k.` }
      await update($, rateLimit, () => n)
      await $.store.set(STORE_RATE, n)
      await showStatus($)
      return { text: `You'll get a lighter-model suggestion when this session burns ${fmt(n)}+ tokens/min (at most once every 15 minutes). It applies to later sessions too.` }
    }

    if (first === 'all') {
      const rest = words.slice(1)
      const current = await readGlobalBudget($)
      if (rest.length === 0) {
        return {
          text: `All-sessions budget: ${describe(current)} over the last ${current.windowHours}h.\nSet one with /token-budget all 5M, /token-budget all $20 24h; /token-budget all off clears it.`,
        }
      }
      if (rest[0]?.toLowerCase() === 'off') {
        await writeGlobalBudget($, { windowHours: current.windowHours })
        await update($, warned, w => w.filter(k => !k.startsWith('all-')))
        await refreshGlobal($)
        await showStatus($)
        return { text: 'All-sessions budget cleared, in every session.' }
      }
      const p = parseLimits(rest, true)
      if ('error' in p) return { text: p.error ?? '' }
      const nextB: GlobalBudget = {
        tokens: p.tokens ?? (p.usd ? undefined : current.tokens),
        usd: p.usd ?? (p.tokens ? undefined : current.usd),
        windowHours: p.windowHours ?? current.windowHours,
      }
      await writeGlobalBudget($, nextB)
      await update($, warned, w => w.filter(k => !k.startsWith('all-')))
      await update($, global, () => null)
      await refreshGlobal($)
      await showStatus($)
      return {
        text: `All-sessions budget set: ${describe(nextB)} over a rolling ${nextB.windowHours}h window. Every Claude Code session on this machine counts toward it and shows what's left.`,
      }
    }

    if (words.length === 0) {
      const b = await read($, budget)
      const gb = await read($, globalBudget)
      return {
        text: `This session's budget: ${describe(b)}.\nAll sessions: ${describe(gb)} over the last ${gb.windowHours}h.\nSet them with /token-budget 500k (or $5), and /token-budget all 5M (or $20, with a window like 24h).`,
      }
    }
    if (first === 'off') {
      await update($, budget, () => ({}))
      await update($, warned, w => w.filter(k => k.startsWith('all-')))
      await $.store.delete(STORE_BUDGET)
      await showStatus($)
      return { text: 'Session budget cleared.' }
    }
    const p = parseLimits(words, false)
    if ('error' in p) return { text: p.error ?? '' }
    const nextB: Budget = { tokens: p.tokens, usd: p.usd }
    await update($, budget, () => nextB)
    await update($, warned, w => w.filter(k => k.startsWith('all-')))
    await $.store.set(STORE_BUDGET, nextB)
    await checkSession($)
    await showStatus($)
    return {
      text: `Session budget set: ${describe(nextB)}. You'll get a warning at 80% and at 100%. It applies to later sessions too, until /token-budget off.`,
    }
  })

  on('command.run', { command: 'token-cost' }, async (_$, e) => {
    const [a, b, m] = e.args.replace(/[[\](){}|<>]/g, ' ').trim().split(/\s+/)
    const input = parseAmount(a ?? '')
    const output = parseAmount(b ?? '')
    if (!Number.isFinite(input) || !Number.isFinite(output)) {
      return { text: 'Usage: /token-cost <input> <output> [model], e.g. /token-cost 200k 20k opus' }
    }
    const ids = m ? [findModel(m)].filter((x): x is string => !!x) : Object.keys(PRICES)
    if (ids.length === 0) return { text: `Unknown model "${m}". Known: ${Object.keys(PRICES).join(', ')}` }
    const rows = ids.flatMap(id => {
      const p = PRICES[id]
      if (!p) return []
      const plain = cost(p, { input, output })
      // The same request with all its input read from the prompt cache.
      const cached = cost(p, { input: 0, output, cacheRead: input })
      return `${id.padEnd(20)} ${usd(plain).padStart(10)}   ${usd(cached).padStart(10)}`
    })
    return {
      text: [
        `${fmt(input)} input + ${fmt(output)} output tokens`,
        `${'model'.padEnd(20)} ${'uncached'.padStart(10)}   ${'input cached'.padStart(10)}`,
        ...rows,
        'API list prices per request; a Claude plan counts usage against its limits instead.',
      ].join('\n'),
    }
  })

  // Every model request, main thread and subagents: estimate output live as it
  // streams, then fold in the exact counts the API reports at the end.
  on('turn.step', async function* ($, e, next) {
    let chars = 0
    let shown = 0
    const stream = next(e)
    const shareStreaming = async () => {
      const now = await $.clock.now()
      if (now - lastStreamWrite < STREAM_WRITE_MS) return
      lastStreamWrite = now
      const s = await read($, usage)
      void writeOwn($, f => ({ ...f, streaming: s.streaming })).catch(() => undefined)
    }
    try {
      for (;;) {
        const r = await stream.next()
        if (r.done) {
          const u = r.value.usage
          const counts = u && {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens,
            cacheWrite: u.cache_creation_input_tokens,
          }
          const counted = u && counts ? countTokens(counts, cacheReadWeight(u.model)) : 0
          await update($, usage, s => ({
            ...s,
            streaming: Math.max(0, s.streaming - shown / 4),
            ...(u && {
              input: s.input + u.input_tokens,
              output: s.output + u.output_tokens,
              cacheRead: s.cacheRead + u.cache_read_input_tokens,
              cacheWrite: s.cacheWrite + u.cache_creation_input_tokens,
              counted: countedOf(s) + counted,
              requests: s.requests + 1,
              model: u.model,
            }),
          }))
          shown = 0
          if (u && counts) {
            const id = findModel(u.model)
            const price = id ? PRICES[id] : undefined
            const est = price ? cost(price, counts) : 0
            const now = await $.clock.now()
            const s = await read($, usage)
            await writeOwn($, f => ({
              ...f,
              streaming: s.streaming,
              reqs: [...f.reqs, [now, counts.input, counts.output, counts.cacheRead, counts.cacheWrite, est, counted]],
            })).catch(() => undefined)
            await refreshGlobal($, true).catch(() => undefined)
            await updateBurn($, counted, u.model)
          }
          await checkSession($)
          await showStatus($)
          return r.value
        }
        const c = r.value
        if (c.kind === 'text' || c.kind === 'thinking') chars += c.text.length
        else if (c.kind === 'input') chars += c.json.length
        if (chars - shown >= 160) {
          const add = (chars - shown) / 4
          shown = chars
          await update($, usage, s => ({ ...s, streaming: s.streaming + add }))
          await shareStreaming()
          await showStatus($)
        }
        yield c
      }
    } finally {
      // An interrupted response takes its estimate back out.
      if (shown > 0) await update($, usage, s => ({ ...s, streaming: Math.max(0, s.streaming - shown / 4) }))
    }
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, s => ({
      ...s,
      contextTokens: e.context.tokens,
      contextWindow: e.context.window,
      contextPercent: e.context.percent,
      costUsd: e.cost?.usd ?? s.costUsd,
    }))
    await checkSession($)
    await showStatus($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const u = await read($, usage)
    const b = await read($, budget)
    const g = await read($, global)
    const gb = await read($, globalBudget)
    const barW = 20
    const bar = (pct: number) => {
      const f = Math.min(barW, Math.round((Math.min(pct, 100) / 100) * barW))
      return '█'.repeat(f) + '░'.repeat(barW - f)
    }
    const tone = (pct: number) => (pct >= 100 ? 'red' : pct >= 80 ? 'yellow' : 'green')
    const row = (label: string, value: string, dim = false) => (
      <Text>
        <Text dimColor>{label.padEnd(14)}</Text>
        <Text dimColor={dim} bold={!dim}>{value}</Text>
      </Text>
    )
    const meter = (label: string, used: number, limit: number, show: (n: number) => string) => {
      const pct = (used / limit) * 100
      return (
        <Box flexDirection="column">
          <Text dimColor>{label}</Text>
          <Text color={tone(pct)}>
            {bar(pct)} {Math.floor(pct)}%
          </Text>
          <Text dimColor>
            {show(used)} of {show(limit)} · {show(Math.max(0, limit - used))} left
          </Text>
        </Box>
      )
    }
    const ctxPct = u.contextPercent ?? 0
    const gCounted = g ? g.counted + g.streaming : 0
    const ctx = u.contextTokens ?? 0
    const br = await read($, burn)
    const lim = await read($, rateLimit)
    const hot = lim > 0 && br.perMin >= lim

    return (
      <Box flexDirection="column">
        <Text bold>This session</Text>
        {row('Input', fmt(u.input + u.cacheRead + u.cacheWrite))}
        {row('  uncached', fmt(u.input), true)}
        {row('  cache read', fmt(u.cacheRead), true)}
        {row('  cache write', fmt(u.cacheWrite), true)}
        {row('Output', fmt(u.output))}
        {u.streaming > 0 && row('  streaming', `~${fmt(u.streaming)} (estimate)`, true)}
        {row('All tokens', fmt(totalTokens(u)))}
        {row('Counted', `${fmt(countedOf(u))} (cache reads weighted)`)}
        <Text>
          <Text dimColor>{'Burn rate'.padEnd(14)}</Text>
          <Text bold color={hot ? 'yellow' : undefined}>
            {fmt(br.perMin)}/min
          </Text>
          <Text dimColor>{lim > 0 ? ` (suggests a lighter model at ${fmt(lim)})` : ' (last 5 min)'}</Text>
        </Text>
        {row('Requests', String(u.requests))}
        {u.costUsd !== undefined && row('Cost', usd(u.costUsd))}
        <Text dimColor>Context window</Text>
        <Text color={ctxPct >= 85 ? 'red' : ctxPct >= 60 ? 'yellow' : 'green'}>
          {bar(ctxPct)} {ctxPct}%
        </Text>
        {u.contextWindow !== undefined && (
          <Text dimColor>
            {fmt(ctx)} of {fmt(u.contextWindow)}
          </Text>
        )}
        {ctx >= BIG_CONTEXT && (
          <Text color="yellow">
            Each request re-reads ~{fmt(ctx)} from cache. /compact, or /clear before a new task, shrinks it.
          </Text>
        )}
        {b.tokens && meter('Session token budget', countedOf(u), b.tokens, n => fmt(n))}
        {b.usd && meter('Session cost budget', u.costUsd ?? 0, b.usd, usd)}
        <Text> </Text>
        <Text bold>All sessions · last {gb.windowHours}h</Text>
        {!g && <Text dimColor>Reading…</Text>}
        {g && row('Sessions', `${g.sessions}${g.streamingSessions ? ` (${g.streamingSessions} responding now)` : ''}`)}
        {g && row('Input', fmt(g.input + g.cacheRead + g.cacheWrite))}
        {g && row('Output', fmt(g.output))}
        {g && g.streaming > 0 && row('  streaming', `~${fmt(g.streaming)} (estimate)`, true)}
        {g && row('All tokens', fmt(globalTotal(g) + g.streaming))}
        {g && row('Counted', fmt(gCounted))}
        {g && row('Cost', `~${usd(g.usd)} (list prices)`)}
        {g && gb.tokens && meter('All-sessions token budget', gCounted, gb.tokens, n => fmt(n))}
        {g && gb.usd && meter('All-sessions cost budget', g.usd, gb.usd, n => `~${usd(n)}`)}
        {!b.tokens && !b.usd && !gb.tokens && !gb.usd && (
          <Text dimColor>No budget set: /token-budget 500k, or /token-budget all 5M</Text>
        )}
        {u.model && <Text dimColor>{u.model}</Text>}
      </Box>
    )
  })
}
