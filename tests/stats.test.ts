import { expect, mock, test } from 'claude-code/testing'

const USAGE = {
  value: {
    startedAt: 0,
    context: { tokens: 94000, window: 200000, percent: 47 },
    rateLimits: [],
  },
}

const ROOT = 'C:\\Users\\me\\AppData\\Local'
const EVENTS = `${ROOT}\\claude-building-blocks\\spend-bar\\events`
const NOW = new Date(2026, 9, 25, 12).getTime()
const TODAY = '2026-10-25'

function machine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const removed: string[] = []
  const logs: string[] = []
  on('env.get', (_, e) => ({ value: e.name === 'LOCALAPPDATA' ? ROOT : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => USAGE)
  on('tool.list', () => ({
    value: [
      { name: 'Read', description: '', mcp: false },
      { name: 'mcp__github__search', description: '', mcp: true },
    ],
  }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}\\`)) }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: files.get(e.path)?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${e.path}\\`)).map(k => k.slice(e.path.length + 1).split('\\')[0]!))
    return { value: [...names].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => {
    const folder = e.argv[e.argv.length - 1]!
    removed.push(folder)
    for (const key of [...files.keys()]) if (key.startsWith(`${folder}\\`)) files.delete(key)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { files, store, removed, logs }
}

test('a turn is logged as JSONL lines and added to the day total', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, store } = machine(on)
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ id: 't1', name: 'Read', input: {} }],
      stopReason: 'tool_use',
      usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
    }
  })
  on('tool.call', () => ({ result: { type: 'text', file: { content: 'x'.repeat(500) } } }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
  }
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.ts' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.ts' })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 5, isAborted: false, reason: 'end_turn' })
  await clock.settle()

  const log = files.get(`${EVENTS}\\${TODAY}\\sess-1.jsonl`)
  expect(log).toBeTruthy()
  const kinds = log!.trim().split('\n').map(line => JSON.parse(line).kind)
  expect(kinds).toEqual(['session', 'step', 'tool', 'tool'])
  expect(log!.includes('a.ts')).toBe(false)

  const totals = store.get(`day:${TODAY}`) as Record<string, any>
  expect(totals.sessions).toBe(1)
  expect(totals.models['claude-opus-5-5']).toEqual({ requests: 1, input: 10, output: 20, cacheRead: 300, cacheWrite: 40 })
  expect(totals.tools.Read.calls).toBe(2)
  expect(totals.repeatedReads).toBe(1)
})

test('day folders and totals older than 30 days are removed at session start', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, store, removed, logs } = machine(on)
  files.set(`${EVENTS}\\2000-01-01\\old.jsonl`, '{}\n')
  store.set('day:2000-01-01', { sessions: 1 })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(logs).toEqual([])
  expect(removed).toEqual([`${EVENTS}\\2000-01-01`])
  expect(store.has('day:2000-01-01')).toBe(false)
})

test('nothing is written when stats collection is off', { options: { collectStats: false } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, store } = machine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(files.size).toBe(0)
  expect(store.size).toBe(0)
})
