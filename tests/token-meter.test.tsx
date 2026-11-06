import { expect, test } from 'claude-code/testing'

const HOME = '/home/test'
const SESSIONS = `${HOME}/.claude/token-meter/sessions`
const NOW = 1_800_000_000_000

/** Stands in for the engine: an in-memory store and file system, a fixed clock. */
const start = async ($: any, on: any, files = new Map<string, string>()) => {
  const store = new Map<string, unknown>()
  const statuses: string[] = []
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${HOME}\n`, stderr: '', isStdoutTruncated: false } }))
  on('session.id', () => ({ value: 'me' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: [...files.keys()]
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: NOW, isLink: false })),
  }))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_: unknown, e: { text?: string }) => (e.text && statuses.push(e.text), { value: undefined }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({}))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return { files, statuses }
}

test('the calculator prices input and output on one model', async ($, on) => {
  await start($, on)
  const r = await $.command.run({ command: 'token-cost', args: '1M 100k opus' })
  // Opus 5.5: 1M x $4 + 100k x $20 = $6.00; all input cached: 1M x $0.20 + $2 = $2.20
  expect(r.text).toContain('claude-opus-5-5')
  expect(r.text).toContain('$6.00')
  expect(r.text).toContain('$2.20')
})

test('a cost budget warns at 80% and again at 100%, once each', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await start($, on)
  const set = await $.command.run({ command: 'token-budget', args: '$1' })
  expect(set.text).toContain('$1.00')

  const measure = (usd: number) =>
    $.session.measure({ context: { window: 1_000_000, tokens: 10_000, percent: 1 }, rateLimits: [], cost: { usd }, changed: ['cost'] })
  await measure(0.5)
  expect(toasts.length).toBe(0)
  await measure(0.85)
  await measure(0.9)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('85%')
  await measure(1.2)
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toContain('over your session budget')
})

test('the all-sessions budget totals every session inside its window and shows what is left', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: { text: string }) => (toasts.push(e.text), { value: undefined }))
  const files = new Map<string, string>()
  const hour = 3600_000
  // Another session: 700k tokens two hours ago, 100k a day ago (outside 5h), and streaming ~50k now.
  files.set(
    `${SESSIONS}/other.json`,
    JSON.stringify({
      id: 'other',
      cwd: '/x',
      updatedAt: NOW - 1000,
      streaming: 50_000,
      reqs: [
        [NOW - 2 * hour, 600_000, 100_000, 0, 0, 3],
        [NOW - 24 * hour, 100_000, 0, 0, 0, 0.4],
      ],
    }),
  )
  const { statuses } = await start($, on, files)
  const r = await $.command.run({ command: 'token-budget', args: 'all 1M 5h' })
  expect(r.text).toContain('1.00M tokens')

  // 700k + 50k streaming = 750k of 1M; the day-old request is outside the window.
  expect(statuses[statuses.length - 1]).toContain('all 750.0k/1.00M · 250.0k left')
  expect(toasts.length).toBe(0)

  // The budget is shared: it is written where every other session reads it.
  expect(JSON.parse(files.get(`${HOME}/.claude/token-meter/budget.json`) ?? '{}')).toEqual({ tokens: 1_000_000, windowHours: 5 })

  // This session's own file exists for the others to read.
  expect(files.has(`${SESSIONS}/me.json`)).toBe(true)

  // A third session brings finished requests to 800k: 80% (streaming estimates don't trigger warnings).
  files.set(
    `${SESSIONS}/third.json`,
    JSON.stringify({ id: 'third', cwd: '/y', updatedAt: NOW, streaming: 0, reqs: [[NOW - hour, 100_000, 0, 0, 0, 0.4]] }),
  )
  await $.command.run({ command: 'token-budget', args: 'all 1M' })
  expect(toasts.some(t => t.includes('80%') && t.includes('all-sessions'))).toBe(true)
})

test('the budget command reads the hint as typed: [500k] and $5 | 500k', async ($, on) => {
  await start($, on)
  expect((await $.command.run({ command: 'token-budget', args: '[500k]' })).text).toContain('500.0k tokens')
  const both = await $.command.run({ command: 'token-budget', args: '[$5 | 500k]' })
  expect(both.text).toContain('500.0k tokens and $5.00')
})

test('cache reads count toward the all-sessions budget at their price weight', async ($, on) => {
  const files = new Map<string, string>()
  // One Opus 5.5 request that re-read 275k from cache: 2 fresh + 300 out + 200 written + 275k x 0.05 = 14,252.
  // One record from 0.2.0 without a counted figure: its 100k cache reads weigh 0.1, so 10k + 1k out = 11k.
  files.set(
    `${SESSIONS}/other.json`,
    JSON.stringify({
      id: 'other',
      cwd: '/x',
      updatedAt: NOW,
      streaming: 0,
      reqs: [
        [NOW - 1000, 2, 300, 275_000, 200, 0.06, 14_252],
        [NOW - 2000, 0, 1_000, 100_000, 0, 0.02],
      ],
    }),
  )
  const { statuses } = await start($, on, files)
  await $.command.run({ command: 'token-budget', args: 'all 100k' })
  // 14,252 + 11,000 = 25,252 counted, though 376.5k tokens were processed.
  expect(statuses[statuses.length - 1]).toContain('all 25.3k/100.0k · 74.7k left')
})
