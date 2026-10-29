import { expect, mock, test } from 'claude-code/testing'

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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.dimColor).toBe(false)
  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(commands).toEqual(['compact'])

  const button = await ui.find({ type: 'Button', key: 'compact' })
  expect(button?.props.label).toBe('Compacting…')
  expect(button?.props.dimColor).toBe(true)

  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(commands).toEqual(['compact'])

  release()
  await clock.settle()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.label).toBe('Compact')
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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const button = await ui.find({ type: 'Button', key: 'compact' })
  expect(button?.props.label).toBe('Compact')
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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const compaction = $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.label).toBe('Compacting…')
  release()
  await compaction
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.label).toBe('Compact')
  await ui.unmount()
})
