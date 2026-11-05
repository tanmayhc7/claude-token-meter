import { expect, test } from 'claude-code/testing'

const start = async ($: any, on: any) => {
  const store = new Map<string, unknown>()
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
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
