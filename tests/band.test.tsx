import { expect, test } from 'claude-code/testing'

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

test('the band draws its pills and the compact button, on every surface', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 94000, window: 200000, percent: 47 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 75 },
        { kind: 'seven_day', percentUsed: 95 },
      ],
    },
  }))
  on('clock.every', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find(surface === "terminal" ? { type: "Text", text: /ctx 47%/ } : { type: "Svg" })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeTruthy()
    await ui.unmount()
  }
})
