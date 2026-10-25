import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Usage } from '../types'

const usage = atom({ plugin: 'spend-bar', key: 'usage' } as const, null)
const lastResponseAt = atom({ plugin: 'spend-bar', key: 'lastResponseAt' } as const, null)
const now = atom({ plugin: 'spend-bar', key: 'now' } as const, 0)
const isCompacting = atom({ plugin: 'spend-bar', key: 'isCompacting' } as const, false)

const MINUTE = 60_000
const TICK_MS = 15_000

type Level = 'ok' | 'warn' | 'alert'

const BACKGROUND: Record<Exclude<Level, 'ok'>, Color> = { warn: 'warning', alert: 'error' }

// An SVG is drawn as an image, outside the theme, so its colours are fixed. Every item on a
// surface that draws SVG is one, plain ones unfilled, so all share one height and baseline.
const PILL_FILL: Record<Level, { fill: string; ink: string }> = {
  ok: { fill: 'none', ink: '#8E8E93' },
  warn: { fill: '#F5A524', ink: '#2B1A00' },
  alert: { fill: '#E5484D', ink: '#FFFFFF' },
}

const PILL_HEIGHT = 20
const PILL_FONT = 12
// Monospace, so the width can be computed from the character count.
const PILL_CHAR_WIDTH = 7.25
const PILL_PADDING = 10

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function pillSvg(text: string, level: Level) {
  const { fill, ink } = PILL_FILL[level]
  const weight = level === 'ok' ? 400 : 600
  const width = Math.ceil(text.length * PILL_CHAR_WIDTH + PILL_PADDING * 2)
  const height = PILL_HEIGHT
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${height / 2}" fill="${fill}"/>` +
    `<text x="${width / 2}" y="${height / 2}" fill="${ink}" font-family="ui-monospace, Consolas, Menlo, monospace" ` +
    `font-size="${PILL_FONT}" font-weight="${weight}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>` +
    `</svg>`

  return { width, height, source }
}

function levelOf(value: number, warnAt: number, alertAt: number): Level {
  if (value > alertAt) return 'alert'
  if (value > warnAt) return 'warn'
  return 'ok'
}

function toLimit(limits: SessionRateLimit[], kind: string): Limit | null {
  const found = limits.find(l => l.kind === kind)
  return found ? { percent: found.percentUsed, resetsAt: found.resetsAt } : null
}

function toUsage(context: SessionContextUsage, limits: SessionRateLimit[]): Usage {
  return {
    session: toLimit(limits, 'five_hour'),
    weekly: toLimit(limits, 'seven_day'),
    contextPercent: context.percent ?? null,
    contextTokens: context.tokens ?? null,
    contextWindow: context.window,
  }
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function untilReset(limit: Limit, at: number): string {
  if (!limit.resetsAt) return ''
  const ms = Date.parse(limit.resetsAt) - at
  return Number.isNaN(ms) ? '' : ` · ${duration(ms)}`
}

function kTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

async function refresh($: EngineInterface) {
  const { context, rateLimits } = await $.session.usage()
  await update($, usage, () => toUsage(context, rateLimits))
}

export const register: Register = (on, options) => {
  const ttlMs = options.cacheTtl === '5m' ? 5 * MINUTE : 60 * MINUTE
  // Amber in the last fifth of the TTL: 12m of an hour, 1m of five minutes.
  const cacheWarnMs = ttlMs / 5
  let stopTicking: (() => void) | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, now, () => Date.now())
    await refresh($)
    stopTicking?.()
    const timer = $.clock.every(TICK_MS, () => {
      void update($, now, () => Date.now())
    })
    stopTicking = () => timer.cancel()

    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e.context, e.rateLimits))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, lastResponseAt, () => at)
      await update($, now, () => at)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, usage)
    const last = await read($, lastResponseAt)
    const at = (await read($, now)) || Date.now()
    const compacting = await read($, isCompacting)

    // Under threshold: plain. Past it: a pill. Where the surface draws SVG both are one; else text.
    const pill = (key: string, level: Level, text: string) => {
      if (e.surface !== 'terminal') {
        const { Svg } = $.ui.resolve(e)
        const { width, height, source } = pillSvg(text, level)
        return <Svg key={key} source={source} alt={text} width={width} height={height} />
      }
      if (level === 'ok') {
        return (
          <Text key={key} dimColor>
            {text}
          </Text>
        )
      }
      return (
        <Text key={key} backgroundColor={BACKGROUND[level]} color="inverseText" bold>
          {` ${text} `}
        </Text>
      )
    }

    const pills = []

    if (current?.session) {
      const { percent } = current.session
      pills.push(pill('session', levelOf(percent, 70, 90), `5h ${Math.round(percent)}%${untilReset(current.session, at)}`))
    }
    if (current?.weekly) {
      const { percent } = current.weekly
      pills.push(pill('weekly', levelOf(percent, 70, 90), `week ${Math.round(percent)}%${untilReset(current.weekly, at)}`))
    }
    if (!current?.session && !current?.weekly) {
      pills.push(pill('limits', 'ok', 'limits —'))
    }

    if (e.props.isWorking) {
      pills.push(pill('cache', 'ok', 'cache live'))
    } else if (last === null) {
      pills.push(pill('cache', 'ok', 'cache —'))
    } else {
      const left = last + ttlMs - at
      if (left <= 0) {
        pills.push(pill('cache', 'alert', `cache expired ${duration(-left)} ago`))
      } else {
        pills.push(pill('cache', left <= cacheWarnMs ? 'warn' : 'ok', `cache ${duration(left)} left`))
      }
    }

    if (current?.contextPercent != null) {
      const tokens = current.contextTokens != null ? ` ${kTokens(current.contextTokens)}/${kTokens(current.contextWindow)}` : ''
      pills.push(pill('context', levelOf(current.contextPercent, 40, 60), `ctx ${current.contextPercent}%${tokens}`))
    } else {
      pills.push(pill('context', 'ok', 'ctx —'))
    }

    const isTurnRunning = e.props.isWorking

    // Compacting is a whole model request: run it from a timer, outside the press's dispatch.
    const compact = async () => {
      if (isTurnRunning) {
        $.ui.toast('Can’t compact while a turn is running')
        return
      }
      if (await read($, isCompacting)) return
      await update($, isCompacting, () => true)
      $.clock.after(0, () => {
        void (async () => {
          try {
            const result = await $.session.compact()
            if (result.skip !== undefined) $.ui.toast(`Compact skipped: ${result.skip}`)
            await refresh($)
          } catch (error) {
            $.ui.toast(`Compact failed: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            await update($, isCompacting, () => false)
          }
        })()
      })
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        {pills}
        <Button
          key="compact"
          label={compacting ? 'Compacting…' : 'Compact'}
          hotkey="c"
          onPress={compact}
        />
      </Box>
    )
  })
}
