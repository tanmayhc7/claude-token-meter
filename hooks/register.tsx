import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Budget, Usage } from '../types'
import { PRICES, cost, findModel, fmt, parseAmount, usd } from './pricing'

const PANE = 'token-meter'
const EMPTY: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, streaming: 0 }
const usage = atom({ plugin: 'token-meter', key: 'usage' } as const, EMPTY, { shape: 'usage-1' })
const budget = atom({ plugin: 'token-meter', key: 'budget' } as const, {} as Budget, { shape: 'budget-1' })
const warned = atom({ plugin: 'token-meter', key: 'warned' } as const, [] as string[], { shape: 'warned-1' })
const STORE_BUDGET = 'budget'
const LEVELS = [80, 100] as const

/** Everything the session's requests processed: input, both cache kinds and output. */
const totalTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite + u.output

const showStatus = async ($: EngineInterface) => {
  const u = await read($, usage)
  const b = await read($, budget)
  const live = u.streaming > 0 ? ` +~${fmt(u.streaming)}` : ''
  const tok = b.tokens ? `${fmt(totalTokens(u))}/${fmt(b.tokens)}` : fmt(totalTokens(u))
  const ctx = u.contextPercent !== undefined ? ` · ctx ${u.contextPercent}%` : ''
  const money = u.costUsd !== undefined ? ` · ${usd(u.costUsd)}${b.usd ? `/${usd(b.usd)}` : ''}` : ''
  $.ui.status(`in ${fmt(u.input + u.cacheRead + u.cacheWrite)} · out ${fmt(u.output)}${live} · Σ ${tok}${ctx}${money}`)
}

/** Raises each budget warning (80%, then 100%) once per session. */
const checkBudgets = async ($: EngineInterface) => {
  const u = await read($, usage)
  const b = await read($, budget)
  const done = await read($, warned)
  const checks: { key: 'tokens' | 'usd'; used: number; limit?: number; show: (n: number) => string }[] = [
    { key: 'tokens', used: totalTokens(u), limit: b.tokens, show: n => `${fmt(n)} tokens` },
    { key: 'usd', used: u.costUsd ?? 0, limit: b.usd, show: usd },
  ]
  const fresh: string[] = []
  for (const c of checks) {
    if (!c.limit) continue
    const pct = (c.used / c.limit) * 100
    // Only the highest level crossed speaks; lower ones are marked as said.
    const crossed = LEVELS.filter(l => pct >= l && !done.includes(`${c.key}-${l}`))
    if (crossed.length === 0) continue
    const top = crossed[crossed.length - 1] ?? 80
    fresh.push(...crossed.map(l => `${c.key}-${l}`))
    const text =
      top >= 100
        ? `Token meter: over your session budget of ${c.show(c.limit)} (${c.show(c.used)} used)`
        : `Token meter: ${Math.floor(pct)}% of your ${c.show(c.limit)} session budget used`
    $.ui.toast(text, { timeoutMs: top >= 100 ? 10000 : 6000 })
    void $.ui.notify(text, { title: 'Token budget' })
  }
  if (fresh.length) await update($, warned, w => [...w, ...fresh])
}

const describeBudget = (b: Budget) =>
  [b.tokens && `${fmt(b.tokens)} tokens`, b.usd && usd(b.usd)].filter(Boolean).join(' and ') || 'none'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tokens', description: 'Open the live token usage pane' })
    await $.command.register({
      name: 'token-budget',
      description: 'Set a session budget that warns at 80% and 100%',
      argumentHint: '[500k | $5 | 500k $5 | off]',
    })
    await $.command.register({
      name: 'token-cost',
      description: 'Work out what input and output tokens cost on each model',
      argumentHint: '<input> <output> [model]',
      immediate: true,
    })
    // A budget set in an earlier session carries over.
    const saved = (await $.store.get(STORE_BUDGET)) as Budget | undefined
    if (saved && (saved.tokens || saved.usd)) await update($, budget, () => saved)
    void $.ui.open({ id: PANE, title: 'Token usage' })
    void showStatus($)
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Token usage' })
    return { text: 'Token usage pane opened.' }
  })

  on('command.run', { command: 'token-budget' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      const b = await read($, budget)
      return { text: `Session budget: ${describeBudget(b)}.\nSet one with /token-budget 500k, /token-budget $5, or both; /token-budget off clears it.` }
    }
    if (words[0]?.toLowerCase() === 'off') {
      await update($, budget, () => ({}))
      await update($, warned, () => [])
      await $.store.delete(STORE_BUDGET)
      await showStatus($)
      return { text: 'Session budget cleared.' }
    }
    const next: Budget = {}
    for (const w of words) {
      const n = parseAmount(w)
      if (!Number.isFinite(n) || n <= 0) return { text: `Couldn't read "${w}". Try 500k, 2M, or $5.` }
      if (w.includes('$')) next.usd = n
      else next.tokens = n
    }
    await update($, budget, () => next)
    await update($, warned, () => [])
    await $.store.set(STORE_BUDGET, next)
    await checkBudgets($)
    await showStatus($)
    return { text: `Session budget set: ${describeBudget(next)}. You'll get a warning at 80% and at 100%. It applies to later sessions too, until /token-budget off.` }
  })

  on('command.run', { command: 'token-cost' }, async (_$, e) => {
    const [a, b, m] = e.args.trim().split(/\s+/)
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
    try {
      for (;;) {
        const r = await stream.next()
        if (r.done) {
          const u = r.value.usage
          await update($, usage, s => ({
            ...s,
            streaming: Math.max(0, s.streaming - shown / 4),
            ...(u && {
              input: s.input + u.input_tokens,
              output: s.output + u.output_tokens,
              cacheRead: s.cacheRead + u.cache_read_input_tokens,
              cacheWrite: s.cacheWrite + u.cache_creation_input_tokens,
              requests: s.requests + 1,
              model: u.model,
            }),
          }))
          shown = 0
          await checkBudgets($)
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
    await checkBudgets($)
    await showStatus($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const u = await read($, usage)
    const b = await read($, budget)
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
            {show(used)} of {show(limit)}
          </Text>
        </Box>
      )
    }
    const ctxPct = u.contextPercent ?? 0

    return (
      <Box flexDirection="column">
        <Text bold>Input</Text>
        {row('  total', fmt(u.input + u.cacheRead + u.cacheWrite))}
        {row('  uncached', fmt(u.input), true)}
        {row('  cache read', fmt(u.cacheRead), true)}
        {row('  cache write', fmt(u.cacheWrite), true)}
        <Text bold>Output</Text>
        {row('  total', fmt(u.output))}
        {u.streaming > 0 && row('  streaming', `~${fmt(u.streaming)} (estimate)`, true)}
        <Text> </Text>
        {row('All tokens', fmt(totalTokens(u)))}
        {row('Requests', String(u.requests))}
        {u.costUsd !== undefined && row('Cost', usd(u.costUsd))}
        <Text> </Text>
        <Text dimColor>Context window</Text>
        <Text color={ctxPct >= 85 ? 'red' : ctxPct >= 60 ? 'yellow' : 'green'}>
          {bar(ctxPct)} {ctxPct}%
        </Text>
        {u.contextWindow !== undefined && (
          <Text dimColor>
            {fmt(u.contextTokens ?? 0)} of {fmt(u.contextWindow)}
          </Text>
        )}
        {(b.tokens || b.usd) && <Text> </Text>}
        {b.tokens && meter('Token budget', totalTokens(u), b.tokens, n => fmt(n))}
        {b.usd && meter('Cost budget', u.costUsd ?? 0, b.usd, usd)}
        {!b.tokens && !b.usd && <Text dimColor>No budget set: /token-budget 500k or $5</Text>}
        {u.model && <Text dimColor>{u.model}</Text>}
      </Box>
    )
  })
}
