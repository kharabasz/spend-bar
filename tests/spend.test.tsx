import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { buildPrompt, buildWeeklyPrompt, scoreLines, usdByDay } from '../hooks/optimize'
import { firstWord } from '../hooks/stats'

const BAND = {
  plugin: 'spend-bar',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const ROOT = 'C:\\Users\\me\\AppData\\Local'
const EVENTS = `${ROOT}\\claude-toolkit\\spend-bar\\events`
const NOW = new Date(2026, 10, 2, 12).getTime()
const TODAY = '2026-11-02'

function usageAt(percent: number) {
  return {
    value: {
      startedAt: 0,
      context: { tokens: percent * 2000, window: 200000, percent },
      rateLimits: [],
    },
  }
}

function machine(on: Parameters<TestBody>[1], percent = 47) {
  // The engine resolves C:\\... against the working directory off Windows: key files from the root.
  const own = (path: string) => {
    const at = path.indexOf(ROOT)
    return at > 0 ? path.slice(at) : path
  }
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const prompts: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  on('env.get', (_, e) => ({ value: e.name === 'LOCALAPPDATA' ? ROOT : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => usageAt(percent))
  on('tool.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: files.has(own(e.path)) || [...files.keys()].some(k => k.startsWith(`${own(e.path)}\\`)) }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: files.get(own(e.path))?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => ({ value: files.get(own(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(own(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const entries = new Map<string, 'file' | 'dir'>()
    const dir = own(e.path)
    for (const key of files.keys()) {
      if (!key.startsWith(`${dir}\\`)) continue
      const rest = key.slice(dir.length + 1).split('\\')
      entries.set(rest[0]!, rest.length > 1 ? 'dir' : 'file')
    }
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    contexts.push(e.context)
    return { text: e.text }
  })
  on('classic.PostToolBatch', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { files, store, toasts, prompts, contexts, own }
}

function stepAnswer(cacheWrite = 40) {
  return async function* (_: unknown, e: { turnId: string; index: number }) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use' as const,
      usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: cacheWrite },
    }
  }
}

async function start($: Parameters<TestBody>[0]) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test('Compact turns amber from 40% context, on every surface', async ($, on) => {
  mock.clock(on, { now: NOW })
  machine(on, 47)
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const button = await ui.find({ type: 'Button', key: 'compact' })
    expect(button?.props.label).toBe('↓')
    expect((await ui.find({ type: 'Text', text: /^↓$/ }))?.props.color).toBe('warning')
    await ui.unmount()
  }
})

test('Compact stays plain under the configured threshold', { options: { compactWarnPercent: 50 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  machine(on, 47)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^↓$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.dimColor).toBe(false)
  await ui.unmount()
})

test('a toast appears once when one main-thread turn reaches the request warning', { options: { turnRequestWarning: 3 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const { toasts } = machine(on)
  on('turn.step', stepAnswer())
  await start($)

  for (let index = 0; index < 5; index++) {
    for await (const _ of $.turn.step({ turnId: 'turn-1', index, model: 'claude-opus-5-5', messageCount: 1 })) {
    }
  }
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 9, model: 'claude-opus-5-5', messageCount: 1, agentId: 'sub' })) {
  }

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('3 model requests')
})

test('long Bash output is cut to head and tail, the full text saved where the note says', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, own } = machine(on)
  const stdout = `HEAD${'x'.repeat(30_000)}TAIL`
  on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false } }))
  await start($)

  const answer = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const result = answer.result as { stdout: string }
  expect(result.stdout.length).toBeLessThan(10_500)
  expect(result.stdout.startsWith('HEAD')).toBe(true)
  expect(result.stdout.endsWith('TAIL')).toBe(true)
  const path = /Full output: (\S+\.txt)/.exec(result.stdout)?.[1]
  expect(own(path!).startsWith(`${EVENTS}\\output\\${TODAY}\\`)).toBe(true)
  expect(files.get(own(path!))).toBe(stdout)
})

test('browser_batch text blocks are trimmed and other blocks kept', { options: { trimLimit: 1000 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  machine(on)
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  on('tool.call', () => ({ result: [{ type: 'text', text: 'y'.repeat(5000) }, image] }))
  await start($)

  const answer = await $.tool.call({ tool: 'mcp__Claude_Browser__browser_batch', actions: [] } as never)
  const blocks = answer.result as { type: string; text?: string }[]
  expect(blocks[0]!.text!.length).toBeLessThan(1500)
  expect(blocks[0]!.text).toContain('spend-bar trimmed')
  expect(blocks[1]).toEqual(image)
})

test('short output, other tools and a zero limit are left alone', { options: { trimLimit: 0 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  machine(on)
  const stdout = 'z'.repeat(30_000)
  on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false } }))
  await start($)

  const answer = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((answer.result as { stdout: string }).stdout).toBe(stdout)
})

test('shell calls log their first word and the start of their error text', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, store } = machine(on)
  on('tool.call', (_, e) =>
    'command' in e && String(e.command).startsWith('gh')
      ? { result: { stdout: '', stderr: `HTTP 404: Not Found ${'.'.repeat(200)}`, interrupted: false }, isError: true }
      : { result: { stdout: 'ok', stderr: '', interrupted: false } },
  )
  await start($)

  await $.tool.call({ tool: 'Bash', command: 'cd /repo && git status' })
  await $.tool.call({ tool: 'Bash', command: 'gh run view 123 --log' })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  await clock.settle()

  const tools = files
    .get(`${EVENTS}\\${TODAY}\\sess-1.jsonl`)!
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
    .filter(line => line.kind === 'tool')
  expect(tools.map(line => line.cmd)).toEqual(['git', 'gh'])
  expect(tools[0].err).toBeUndefined()
  expect(tools[1].err.startsWith('HTTP 404: Not Found')).toBe(true)
  expect(tools[1].err.length).toBe(100)
  const totals = store.get(`day:${TODAY}`) as Record<string, any>
  expect(totals.commands.gh).toEqual({ calls: 1, errors: 1 })
})

test('the first word skips cd, env assignments and paths', () => {
  expect(firstWord('git push origin main')).toBe('git')
  expect(firstWord('cd C:/repo && dotnet test')).toBe('dotnet')
  expect(firstWord('FOO=1 npm run build')).toBe('npm')
  expect(firstWord('"C:/Program Files/x/claude.exe" plugin test .')).toBe('claude')
  expect(firstWord('& "C:\\tools\\Gh.EXE" pr list')).toBe('gh')
  expect(firstWord('')).toBe('?')
})

test('the score counts each spend pattern', () => {
  const step = (turn: string, ctx: number | null, cacheWrite = 0, agent: string | null = null) => ({
    t: 0,
    kind: 'step',
    sid: 's',
    turn,
    agent,
    ctx,
    in: 10,
    out: 5,
    cacheRead: 90,
    cacheWrite,
  })
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({ t: 0, kind: 'tool', sid: 's', tool: name, bytes: 10, ...extra })
  const lines = [
    ...Array.from({ length: 51 }, () => step('long', 50)),
    step('short', 20, 150_000),
    step('short', null, 0, 'sub'),
    tool('Bash', { cmd: 'git' }),
    tool('PowerShell', { cmd: 'gh', isError: true, err: 'boom' }),
    tool('Read', { path: 'a' }),
    tool('Read', { path: 'a' }),
    tool('Read', { path: 'b', bytes: 50_000 }),
  ]

  const score = scoreLines(lines)
  expect(score.requests).toBe(53)
  expect(score.sentAboveContext).toBe(51 * 100)
  expect(score.sentAtKnownContext).toBe(51 * 100 + 150_100)
  expect(score.turns).toBe(2)
  expect(score.longTurns).toBe(1)
  expect(score.longTurnRequests).toBe(51)
  expect(score.shellCalls).toBe(2)
  expect(score.reads).toBe(3)
  expect(score.repeatedReads).toBe(1)
  expect(score.largeResultsByTool).toEqual({ Read: 1 })
  expect(score.bigRewrites).toBe(1)
  expect(score.commandErrors).toEqual({ gh: 1 })
  expect(score.errors).toEqual({ 'gh: boom': 1 })

  const prompt = buildPrompt(score, score, [{ idleCacheRewrites: { count: 2, tokens: 300_000 }, compactions: { manual: 1 } }])
  expect(prompt.startsWith('/')).toBe(false)
  expect(prompt).toContain('1 of 2 turns over 50 requests')
  expect(prompt).toContain('2 cache rewrites after the cache expired (300k tokens')
})

test('Optimize spend scores the session and the week, then asks Claude', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, store, prompts } = machine(on)
  files.set(
    `${EVENTS}\\2026-10-30\\old.jsonl`,
    `${JSON.stringify({ sid: 'old', t: 0, kind: 'step', turn: 't', agent: null, ctx: 70, in: 1, out: 1, cacheRead: 999, cacheWrite: 0 })}\nnot json\n`,
  )
  files.set(`${EVENTS}\\2026-10-01\\ancient.jsonl`, JSON.stringify({ sid: 'x', t: 0, kind: 'step', in: 5 }))
  store.set('day:2026-10-30', { idleCacheRewrites: { count: 4, tokens: 500_000 } })
  on('turn.step', stepAnswer())
  await start($)
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'optimize' })
  await clock.settle()

  expect(prompts).toHaveLength(1)
  const [prompt] = prompts
  expect(prompt!.startsWith('/')).toBe(false)
  expect(prompt).toContain('This session: 1 requests')
  expect(prompt).toContain('Past 7 days: 2 requests costing about')
  expect(prompt).toContain('4 cache rewrites after the cache expired (500k tokens')
  expect((await ui.find({ type: 'Button', key: 'optimize' }))?.props.label).toBe('$')
  await ui.unmount()
})

test('Optimize spend asks for stats when collection is off', { options: { collectStats: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { prompts, toasts } = machine(on)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'optimize' })
  await clock.settle()

  expect(prompts).toEqual([])
  expect(toasts[0]).toContain('Collect usage stats')
  await ui.unmount()
})

test('the context gate adds a model-only note to the first turn at or above the limit, once per crossing', { options: { contextGatePercent: 40 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const { contexts } = machine(on, 47)
  await start($)
  await $.prompt.submit({ text: 'refactor it' })
  await $.prompt.submit({ text: 'and again' })
  await $.prompt.submit({ text: '/compact' })
  expect(contexts[0]).toHaveLength(1)
  expect(contexts[0]![0]).toContain('47%')
  expect(contexts[0]![0]).toContain('/compact')
  expect(contexts[1]).toBeUndefined()
  expect(contexts[2]).toBeUndefined()
})

test('the context gate is off by default and below its limit', async ($, on) => {
  mock.clock(on, { now: NOW })
  machine(on, 47)
  await start($)
  expect((await $.prompt.submit({ text: 'go' })).text).toBe('go')
})

test('the long-turn brake leaves its note for the PostToolBatch command hook, once, without aborting', { options: { turnRequestBrake: 3 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, toasts } = machine(on)
  const aborted: string[] = []
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('turn.step', stepAnswer())
  await start($)
  const NOTE = `${EVENTS}\\pending\\sess-1.brake.json`
  const step = async (turnId: string, index: number) => {
    for await (const _ of $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 })) {
    }
  }

  await step('turn-1', 0)
  await step('turn-1', 1)
  expect(files.get(NOTE) ?? '').toBe('')
  await step('turn-1', 2)
  const output = JSON.parse(files.get(NOTE)!)
  expect(output.hookSpecificOutput.hookEventName).toBe('PostToolBatch')
  expect(output.hookSpecificOutput.additionalContext).toContain('ask the user')
  // The hook empties the file once it prints the note; later requests in the turn leave it empty.
  files.set(NOTE, '')
  await step('turn-1', 3)
  expect(files.get(NOTE)).toBe('')
  expect(aborted).toEqual([])
  expect(toasts.filter(t => t.includes('Long-turn brake'))).toHaveLength(1)
})

test('a new turn clears a long-turn brake note that never reached a tool batch', { options: { turnRequestBrake: 2 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files } = machine(on)
  on('turn.step', stepAnswer())
  await start($)
  const NOTE = `${EVENTS}\\pending\\sess-1.brake.json`
  for (const index of [0, 1]) {
    for await (const _ of $.turn.step({ turnId: 'turn-1', index, model: 'claude-opus-5-5', messageCount: 1 })) {
    }
  }
  expect(files.get(NOTE)).toContain('additionalContext')
  for await (const _ of $.turn.step({ turnId: 'turn-2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
  }
  expect(files.get(NOTE)).toBe('')
})

test('the weekly review compares this week with the one before', () => {
  const day = (d: number) => new Date(2026, 10, d, 12).getTime()
  const step = (d: number, usd: number) => ({ t: day(d), kind: 'step', sid: 's', turn: 't', in: 10, out: 5, cacheRead: 100, cacheWrite: 0, usd })
  const byDay = usdByDay([step(6, 2), step(6, 3), step(1, 1)])
  expect(byDay['2026-11-06']).toBe(5)
  const prompt = buildWeeklyPrompt(
    scoreLines([step(6, 5)]),
    scoreLines([step(1, 2)]),
    ['2026-11-06', '2026-11-05'],
    byDay,
    [],
  )
  expect(prompt).toContain('Weekly spend review')
  expect(prompt).toContain('+150%')
  expect(prompt).toContain('11-06 $5')
})
