// A ledger shared by every Claude Code session on this machine: each session
// writes only its own file under ~/.claude/token-meter/sessions/, and reads all
// of them to total what every session used inside the budget's window.
import type { EngineInterface } from 'claude-code'

import type { GlobalBudget, GlobalUsage } from '../types'

/**
 * One model request: when, its four token counts, its estimated cost, and the
 * tokens it counts toward a budget (absent in records from version 0.2.0).
 */
export type Req = [ts: number, input: number, output: number, cacheRead: number, cacheWrite: number, usd: number, counted?: number]

/** An old record without `counted` weighs its cache reads at the common 0.1. */
const OLD_WEIGHT = 0.1

export type SessionFile = {
  id: string
  cwd: string
  updatedAt: number
  /** Estimated output tokens streaming in this session right now. */
  streaming: number
  reqs: Req[]
}

const KEEP_MS = 8 * 24 * 3600_000
/** A session that hasn't written for this long isn't streaming any more (it crashed or closed). */
const STALE_MS = 60_000
export const DEFAULT_WINDOW_HOURS = 5

let dirCache: string | undefined

/** ~/.claude/token-meter, found from the plugin's own path, else from $HOME. */
export async function ledgerDir($: EngineInterface): Promise<string> {
  if (dirCache) return dirCache
  const root = $.plugin.root
  const i = root.indexOf('/.claude/')
  let base: string
  if (i >= 0) base = root.slice(0, i + '/.claude'.length)
  else {
    const r = await $.process.run(['printenv', 'HOME'])
    base = `${r.stdout.trim()}/.claude`
  }
  dirCache = `${base}/token-meter`
  return dirCache
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

// Writes from one session go one at a time, so parallel subagents don't lose requests.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

export function writeOwn($: EngineInterface, change: (f: SessionFile) => SessionFile): Promise<void> {
  return serial(async () => {
    const dir = await ledgerDir($)
    const id = await $.session.id()
    const path = `${dir}/sessions/${id}.json`
    const now = await $.clock.now()
    const old = (await readJson<SessionFile>($, path)) ?? { id, cwd: '', updatedAt: now, streaming: 0, reqs: [] }
    const next = change(old)
    next.updatedAt = now
    next.reqs = next.reqs.filter(r => now - r[0] < KEEP_MS)
    await $.fs.write(path, JSON.stringify(next))
  })
}

export async function readGlobalBudget($: EngineInterface): Promise<GlobalBudget> {
  return (await readJson<GlobalBudget>($, `${await ledgerDir($)}/budget.json`)) ?? { windowHours: DEFAULT_WINDOW_HOURS }
}

export async function writeGlobalBudget($: EngineInterface, b: GlobalBudget): Promise<void> {
  await $.fs.write(`${await ledgerDir($)}/budget.json`, JSON.stringify(b))
}

/** Totals every session's requests inside the last `windowHours`. */
export async function totalAll($: EngineInterface, windowHours: number): Promise<GlobalUsage> {
  const dir = `${await ledgerDir($)}/sessions`
  const now = await $.clock.now()
  const from = now - windowHours * 3600_000
  const g: GlobalUsage = {
    windowHours,
    sessions: 0,
    streamingSessions: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    counted: 0,
    usd: 0,
    streaming: 0,
  }
  let entries: { name: string; kind: string; mtimeMs: number }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return g
  }
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json') || e.mtimeMs < from) continue
    const f = await readJson<SessionFile>($, `${dir}/${e.name}`)
    if (!f) continue
    let counted = false
    for (const [ts, i, o, cr, cw, usd, c] of f.reqs) {
      if (ts < from) continue
      counted = true
      g.input += i
      g.output += o
      g.cacheRead += cr
      g.cacheWrite += cw
      g.counted += c ?? i + o + cw + cr * OLD_WEIGHT
      g.usd += usd
    }
    if (f.streaming > 0 && now - f.updatedAt < STALE_MS) {
      g.streaming += f.streaming
      g.streamingSessions += 1
      counted = true
    }
    if (counted) g.sessions += 1
  }
  return g
}

/** Every token processed, cache reads in full: what the pane lists. */
export const globalTotal = (g: GlobalUsage) => g.input + g.output + g.cacheRead + g.cacheWrite
