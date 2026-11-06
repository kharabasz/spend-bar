import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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

const USAGE = {
  value: {
    startedAt: 0,
    context: { tokens: 94000, window: 200000, percent: 47 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 75 },
      { kind: 'seven_day', percentUsed: 95 },
    ],
  },
}

test('the band draws its pills and the compact button, on every surface', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => USAGE)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find(surface === 'terminal' ? { type: 'Text', text: /ctx 47%/ } : { type: 'Svg' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeTruthy()
    await ui.unmount()
  }
})

function usageAt(percent: number) {
  return { value: { ...USAGE.value, context: { tokens: percent * 2000, window: 200000, percent } } }
}

test('pressing Compact runs /compact and shows Compacting… until it ends', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[] = []
  let release = () => {}
  on('session.usage', () => USAGE)
  on('command.run', async (_, e) => {
    commands.push(e.command)
    await new Promise<void>(resolve => {
      release = resolve
    })
    return { text: '' }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.dimColor).toBe(false)
  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(commands).toEqual(['compact'])

  const button = await ui.find({ type: 'Button', key: 'compact' })
  expect(button?.props.label).toBe('↓…')
  expect(button?.props.dimColor).toBe(true)

  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(commands).toEqual(['compact'])

  release()
  await clock.settle()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.label).toBe('↓')
  expect(toasts).toEqual([])
  await ui.unmount()
})

test('Compact is dimmed and does nothing below 30% context', async ($, on) => {
  const clock = mock.clock(on)
  let submits = 0
  on('session.usage', () => usageAt(20))
  on('prompt.submit', (_, e) => {
    submits += 1
    return { text: e.text }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const button = await ui.find({ type: 'Button', key: 'compact' })
  expect(button?.props.label).toBe('↓')
  expect(button?.props.dimColor).toBe(true)
  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(submits).toBe(0)
  await ui.unmount()
})

test('an automatic compaction also shows Compacting…', async ($, on) => {
  mock.clock(on)
  let release = () => {}
  on('session.usage', () => USAGE)
  on('session.compact', async () => {
    await new Promise<void>(resolve => {
      release = resolve
    })
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const compaction = $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.label).toBe('↓…')
  release()
  await compaction
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.label).toBe('↓')
  await ui.unmount()
})

// An Enterprise seat on usage-based billing: no 5-hour or weekly windows, the month's extra usage
// from the desktop app's get_usage tool, and the session's cost from the engine's ledger.
const ENTERPRISE_USAGE = {
  value: {
    startedAt: 0,
    context: { tokens: 40000, window: 1000000, percent: 4 },
    rateLimits: [],
    cost: { usd: 3.2 },
  },
}

function getUsage(spent: string, planName = 'Enterprise') {
  const plan = {
    status: 'ok',
    plan: planName,
    windows: [],
    extraUsage: { enabled: true, percentUsed: 0, spent, monthlyLimit: '1800.00', currency: 'USD' },
  }
  return { value: { content: [{ type: 'text', text: JSON.stringify({ plan }) }], isError: false } }
}

function toastsOf(on: Parameters<TestBody>[1]) {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  return toasts
}

test('an Enterprise seat shows the month and the session cost instead of empty limits', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ENTERPRISE_USAGE)
  on('mcp.call', (_, e) => (e.server === 'ccd_session_mgmt' && e.tool === 'get_usage' ? getUsage('7.02') : { value: { content: [], isError: true } }))
  const toasts = toastsOf(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /month \$7\.02\/\$1800/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /session \$3\.20/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /limits —/ })).toBeFalsy()
  expect(toasts).toEqual([])
  await ui.unmount()
})

for (const planName of ['Free', 'Pro', 'Max', 'Max 5x', 'pro']) {
  test(`a ${planName} plan with extra usage on shows no month and no month toast`, async ($, on) => {
    mock.clock(on)
    on('session.usage', () => ENTERPRISE_USAGE)
    on('mcp.call', () => getUsage('1700.00', planName))
    const toasts = toastsOf(on)
    on('command.register', () => ({ value: undefined }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /month / })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /session \$3\.20/ })).toBeTruthy()
    expect(toasts).toEqual([])
    await ui.unmount()
  })
}

for (const planName of ['Team', 'Enterprise', 'Professional Services']) {
  test(`a ${planName} plan keeps the month`, async ($, on) => {
    mock.clock(on)
    on('session.usage', () => ENTERPRISE_USAGE)
    on('mcp.call', () => getUsage('7.02', planName))
    toastsOf(on)
    on('command.register', () => ({ value: undefined }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /month \$7\.02\/\$1800/ })).toBeTruthy()
    await ui.unmount()
  })
}

test('the month warns once at 75% and the pill turns amber', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ENTERPRISE_USAGE)
  on('mcp.call', () => getUsage('1400.00'))
  const toasts = toastsOf(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(toasts).toEqual(["Extra usage is at 77.8% of this month's limit: $1400 of $1800."])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: / month \$1400\/\$1800 / }))?.props.backgroundColor).toBe('warning')
  await ui.unmount()
})

test('without the desktop app the month is skipped and the bar still draws', async ($, on) => {
  mock.clock(on)
  let calls = 0
  on('session.usage', () => ENTERPRISE_USAGE)
  on('mcp.call', () => {
    calls++
    throw new Error('no server named ccd_session_mgmt')
  })
  on('turn.complete', () => ({ text: '' }))
  toastsOf(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })

  expect(calls).toBe(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /session \$3\.20/ })).toBeTruthy()
  await ui.unmount()
})

test('in the desktop app a get_usage failure at session start is retried after the next turn', async ($, on) => {
  mock.clock(on)
  let calls = 0
  on('session.usage', () => ENTERPRISE_USAGE)
  on('mcp.call', (_, e) => {
    calls++
    // The app's own MCP servers can still be connecting when the session starts.
    if (calls === 1) throw new Error('MCP server ccd_session_mgmt is still connecting')
    return e.server === 'ccd_session_mgmt' && e.tool === 'get_usage' ? getUsage('721.33') : { value: { content: [], isError: true } }
  })
  on('turn.complete', () => ({ text: '' }))
  toastsOf(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })

  expect(calls).toBe(2)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /month \$721\/\$1800/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /session \$3\.20/ })).toBeTruthy()
  await ui.unmount()
})

test('the session cost warns at each multiple of the warning', { options: { sessionCostWarning: 10 } }, async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ENTERPRISE_USAGE)
  on('mcp.call', () => getUsage('7.02'))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const toasts = toastsOf(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const usd of [9, 10.5, 12, 21]) {
    await $.session.measure({ context: ENTERPRISE_USAGE.value.context, rateLimits: [], cost: { usd }, changed: ['cost'] })
  }
  expect(toasts.map(t => t.split('.')[0])).toEqual(['This session has cost $10', 'This session has cost $21'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: / session \$21\.00 / }))?.props.backgroundColor).toBe('error')
  await ui.unmount()
})

test('a large cache rewrite after the cache expired raises a toast with its cost', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ENTERPRISE_USAGE)
  on('mcp.call', () => getUsage('7.02'))
  const toasts = toastsOf(on)
  let write = 0
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: write },
    }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  write = 50_000
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
  }
  await clock.advance(2 * 60 * 60_000)
  write = 500_000
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 3 })) {
  }

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('idle 2h00m')
  expect(toasts[0]).toContain('rewrote 500k tokens, about $4.00')
})

test('an unavailable plan reading at session start is retried in a minute and the month appears', async ($, on) => {
  const clock = mock.clock(on)
  on('session.usage', () => ENTERPRISE_USAGE)
  let calls = 0
  on('mcp.call', () => {
    calls++
    if (calls > 1) return getUsage('721.33')
    const plan = { status: 'unavailable', note: 'Try again in a minute' }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ plan }) }], isError: false } }
  })
  toastsOf(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(calls).toBe(1)
  await clock.advance(61_000)

  expect(calls).toBe(2)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /month \$721\/\$1800/ })).toBeTruthy()
  await ui.unmount()
})
