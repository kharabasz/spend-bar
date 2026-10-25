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

test('pressing Compact compacts the session when no turn is running', async ($, on) => {
  const clock = mock.clock(on)
  let compactions = 0
  on('session.usage', () => USAGE)
  on('session.compact', () => {
    compactions += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(compactions).toBe(1)
  expect(toasts).toEqual([])
  await ui.unmount()
})

test('pressing Compact during a turn does not compact', async ($, on) => {
  const clock = mock.clock(on)
  let compactions = 0
  on('session.usage', () => USAGE)
  on('session.compact', () => {
    compactions += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: true } })
  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(compactions).toBe(0)
  await ui.unmount()
})

test('in a headless session Compact runs the /compact command instead', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[] = []
  on('session.usage', () => USAGE)
  on('session.compact', () => {
    throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet')
  })
  on('command.run', (_, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(commands).toEqual(['compact'])
  expect(toasts).toEqual([])
  await ui.unmount()
})
