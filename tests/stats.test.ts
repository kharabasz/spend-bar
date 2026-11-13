import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const USAGE = {
  value: {
    startedAt: 0,
    context: { tokens: 94000, window: 200000, percent: 47 },
    rateLimits: [],
  },
}

// Where each platform's event log lives, and the path separator it is written with.
type Place = { env: Record<string, string>; root: string; events: string; sep: string }

const WINDOWS: Place = {
  env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
  root: 'C:\\Users\\me',
  events: 'C:\\Users\\me\\AppData\\Local\\claude-toolkit\\spend-bar\\events',
  sep: '\\',
}
const MAC: Place = {
  env: { HOME: '/Users/me' },
  root: '/Users/me',
  events: '/Users/me/Library/Application Support/claude-toolkit/spend-bar/events',
  sep: '/',
}
const EVENTS = WINDOWS.events
const NOW = new Date(2026, 9, 25, 12).getTime()
const TODAY = '2026-10-25'

function near(actual: unknown, expected: number) {
  expect(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9).toBe(true)
}

type UsageAnswer = { value: (typeof USAGE)['value'] & { cost?: { usd: number } } }

function machine(on: Parameters<TestBody>[1], place: Place = WINDOWS, usage: UsageAnswer = USAGE) {
  const { sep } = place
  // The engine resolves a path that is not absolute on the host against the working directory, so
  // C:\\... arrives under the cwd off Windows: key every file from the fixture's root.
  const own = (path: string) => {
    const fixturePath = path.replace(/[\\/]/g, sep)
    const at = fixturePath.indexOf(place.root)
    return at > 0 ? fixturePath.slice(at) : fixturePath
  }
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const removed: string[] = []
  const logs: string[] = []
  on('env.get', (_, e) => ({ value: place.env[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => usage)
  on('tool.list', () => ({
    value: [
      { name: 'Read', description: '', mcp: false },
      { name: 'mcp__github__search', description: '', mcp: true },
    ],
  }))
  on('fs.exists', (_, e) => ({ value: files.has(own(e.path)) || [...files.keys()].some(k => k.startsWith(`${own(e.path)}${sep}`)) }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: files.get(own(e.path))?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => ({ value: files.get(own(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(own(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = own(e.path)
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${dir}${sep}`)).map(k => k.slice(dir.length + 1).split(sep)[0]!))
    return { value: [...names].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => {
    const folder = own(e.argv[e.argv.length - 1]!)
    removed.push(e.argv.join(' '))
    for (const key of [...files.keys()]) if (key.startsWith(`${folder}${sep}`)) files.delete(key)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  on('command.register', () => ({ value: undefined }))
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
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()

  const log = files.get(`${EVENTS}\\${TODAY}\\sess-1.jsonl`)
  expect(log).toBeTruthy()
  const kinds = log!.trim().split('\n').map(line => JSON.parse(line).kind)
  expect(kinds).toEqual(['session', 'step', 'tool', 'tool'])
  expect(log!.includes('a.ts')).toBe(false)

  const totals = store.get(`day:${TODAY}`) as Record<string, any>
  expect(totals.sessions).toBe(1)
  const { usd, ...tokens } = totals.models['claude-opus-5-5']
  expect(tokens).toEqual({ requests: 1, input: 10, output: 20, cacheRead: 300, cacheWrite: 40 })
  // Opus 5.5 at list prices, the cache write at the hour's rate: (10x4 + 20x20 + 300x0.2 + 40x8) / 1M.
  near(usd, 0.00082)
  near(totals.estimatedUsd, 0.00082)
  near(JSON.parse(log!.trim().split('\n')[1]!).usd, 0.00082)
  expect(totals.tools.Read.calls).toBe(2)
  expect(totals.repeatedReads).toBe(1)
})

test('tool lines record what the model read and why a read repeats', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, store } = machine(on)
  const whole = 'x'.repeat(250_000)
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      return {
        result: { filePath: 'C:\\repo\\a.ts', oldString: 'a', newString: 'b', originalFile: whole, structuredPatch: [], userModified: false, replaceAll: false },
        text: 'The file C:\\repo\\a.ts has been updated successfully.',
      }
    }
    const input = e as { file_path?: string; limit?: number }
    if (input.file_path?.endsWith('b.ts') && input.limit === undefined) return { deny: 'b.ts is too big; read a range' }
    return { result: { type: 'text', file: { content: 'line' } }, text: '1\tline' }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.ts' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.ts', offset: 10, limit: 100 })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.ts', offset: 2500, limit: 100 })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\repo\\a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.ts', offset: 10, limit: 100 })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.ts', agentId: 'sub-1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\b.ts' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\b.ts', limit: 50 })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()

  const tools = files
    .get(`${EVENTS}\\${TODAY}\\sess-1.jsonl`)!
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
    .filter(line => line.kind === 'tool')
  expect(tools.map(line => line.repeat ?? null)).toEqual([null, 'exact', 'new-range', null, 'after-change', 'cross-agent', null, null])
  const edit = tools[3]
  expect(edit.bytes).toBeGreaterThan(250_000)
  expect(edit.seenBytes).toBe('The file C:\\repo\\a.ts has been updated successfully.'.length)
  expect(tools[0].seenBytes).toBe('1\tline'.length)
  expect(tools[6].isDenied).toBe(true)
  expect(tools[6].seenBytes).toBe('b.ts is too big; read a range'.length)

  const totals = store.get(`day:${TODAY}`) as Record<string, any>
  // The old count is kept as it was: any Read of a path read before, the denied one included.
  expect(totals.repeatedReads).toBe(5)
  expect(totals.repeatedReadsByKind).toEqual({ exact: 1, 'new-range': 1, 'after-change': 1, 'cross-agent': 1 })
  expect(totals.tools.Edit.seenBytes).toBe(edit.seenBytes)
})

test('day folders and totals older than 30 days are removed at session start', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, store, removed, logs } = machine(on)
  files.set(`${EVENTS}\\2000-01-01\\old.jsonl`, '{}\n')
  store.set('day:2000-01-01', { sessions: 1 })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(logs).toEqual([])
  expect(removed).toEqual([`cmd /c rmdir /s /q ${EVENTS}\\2000-01-01`])
  expect(store.has('day:2000-01-01')).toBe(false)
})

test('nothing is written when stats collection is off', { options: { collectStats: false } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, store } = machine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(files.size).toBe(0)
  expect(store.size).toBe(0)
})

test('on macOS the log goes under Library/Application Support and old days are removed with rm', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, removed, logs } = machine(on, MAC)
  files.set(`${MAC.events}/2000-01-01/old.jsonl`, '{}\n')
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })) {
  }
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()

  expect(logs).toEqual([])
  expect(removed).toEqual([`rm -rf ${MAC.events}/2000-01-01`])
  const log = files.get(`${MAC.events}/${TODAY}/sess-1.jsonl`)
  expect(log?.trim().split('\n').map(line => JSON.parse(line).kind)).toEqual(['session', 'step'])
})

test('the billed total is kept per day as it grows past the session start', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { store } = machine(on, MAC, { value: { ...USAGE.value, cost: { usd: 10 } } })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const usd of [12.5, 12.5, 14]) {
    await $.session.measure({ context: USAGE.value.context, rateLimits: [], cost: { usd }, changed: ['cost'] })
  }
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()

  near((store.get(`day:${TODAY}`) as Record<string, number>).billedUsd, 4)
})

const COMMANDS = {
  value: [
    { name: 'compact', description: '', source: 'builtin' },
    { name: 'commit', description: '', source: 'user' },
    { name: 'spend-review', description: '', source: 'plugin', plugin: 'spend-bar' },
  ],
}

// The built-in security guard sends skill.prompt and session.compact past every installed plugin, so
// these two tests never raise them: the Skill tool, the slash command and the PostCompact hook's note
// (scripts/record-compact.sh) are all spend-bar sees.
const PENDING = `${EVENTS}\\pending\\sess-1.jsonl`
const NOTE = (trigger: string) => `{"t":${NOW},"trigger":"${trigger}","agent":null}\n`

test('skills and compactions are still counted when skill.prompt and session.compact are passed over', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, store } = machine(on)
  files.set(PENDING, NOTE('manual'))
  on('command.list', () => COMMANDS)
  on('tool.call', () => ({ result: { type: 'text', file: { content: 'ok' } } }))
  on('command.run', () => ({ text: '' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Skill', skill: 'ministack-devkit:ms-handoff' })
  await $.command.run({ command: 'commit', args: '' })
  await $.command.run({ command: 'compact', args: '' })
  await $.command.run({ command: 'spend-review', args: '' })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()

  const totals = store.get(`day:${TODAY}`) as Record<string, any>
  expect(totals.skills).toEqual({ 'ministack-devkit:ms-handoff': 1, commit: 1 })
  expect(totals.compactions).toEqual({ manual: 1 })
  expect(files.get(PENDING)).toBe('')
  const log = files.get(`${EVENTS}\\${TODAY}\\sess-1.jsonl`)!
  const kinds = log.trim().split('\n').map(line => JSON.parse(line))
  expect(kinds.filter(line => line.kind === 'skill').map(line => line.via)).toEqual(['tool', 'command'])
  expect(kinds.filter(line => line.kind === 'compact').length).toBe(1)
})

test('one skill run or compaction seen by several hooks is counted once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { store, files } = machine(on)
  on('command.list', () => COMMANDS)
  on('tool.call', () => ({ result: { type: 'text', file: { content: 'ok' } } }))
  on('command.run', () => ({ text: '' }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 900, tokensAfter: 100 }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'commit', args: '' })
  await $.skill.prompt({ skill: 'commit', text: 'x', frontmatter: {} } as never)
  await $.tool.call({ tool: 'Skill', skill: 'commit' })
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  // The PostCompact hook runs after the compaction, so its note arrives once session.compact was counted.
  files.set(PENDING, NOTE('auto'))
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()

  const totals = store.get(`day:${TODAY}`) as Record<string, any>
  expect(totals.skills).toEqual({ commit: 1 })
  expect(totals.compactions).toEqual({ auto: 1 })
})
