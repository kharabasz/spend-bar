import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Usage } from '../types'
import { billingMeasured, configureBilling, refreshMonthly, startBilling } from './billing'
import { costOf, dollars } from './pricing'
import {
  configureStats,
  flushStats,
  hookStats,
  statsCompacted,
  statsCost,
  statsMeasured,
  statsSessionStarted,
  statsStepEnded,
  statsStepStarting,
} from './stats'
import { spendReviewPrompt, weeklyReviewPrompt } from './optimize'
import { configureTrim } from './trim'

const usage = atom({ plugin: 'spend-bar', key: 'usage' } as const, null)
const lastResponseAt = atom({ plugin: 'spend-bar', key: 'lastResponseAt' } as const, null)
const now = atom({ plugin: 'spend-bar', key: 'now' } as const, 0)
const isCompacting = atom({ plugin: 'spend-bar', key: 'isCompacting' } as const, false)
const isOptimizing = atom({ plugin: 'spend-bar', key: 'isOptimizing' } as const, false)
const monthly = atom({ plugin: 'spend-bar', key: 'monthly' } as const, null)
const sessionUsd = atom({ plugin: 'spend-bar', key: 'sessionUsd' } as const, null)

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
    spendLimit: toLimit(limits, 'spend_limit'),
    contextPercent: context.percent ?? null,
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

function contextGateNote(percent: number): string {
  return (
    `<spend-bar-notice>This session's context is ${percent}% full, so every request resends a very large prompt. ` +
    'Before starting new work, tell the user in one line that they should run /compact or hand off to a fresh session ' +
    '(a short handoff note is cheaper than compacting). Then continue with their request.</spend-bar-notice>'
  )
}

function turnBrakeNote(requests: number): string {
  return (
    `<spend-bar-notice>This turn has made ${requests} model requests, each resending the whole context. ` +
    'Stop now: do not call more tools. Summarize what you have done and what is left, then ask the user ' +
    'whether to continue before doing anything else.</spend-bar-notice>'
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const MIN_COMPACT_PERCENT = 30

function isCompactable(current: Usage | null): boolean {
  return current?.contextPercent != null && current.contextPercent >= MIN_COMPACT_PERCENT
}

async function refresh($: EngineInterface) {
  const { context, rateLimits, cost } = await $.session.usage()
  await update($, usage, () => toUsage(context, rateLimits))
  await billingMeasured($, cost?.usd)
}

function thresholdOf(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

let turnId = ''
let turnRequests = 0

function countMainRequest(id: string): number {
  if (id !== turnId) {
    turnId = id
    turnRequests = 0
  }
  turnRequests++
  return turnRequests
}

async function optimizeSpend($: EngineInterface, weekly = false) {
  let prompt: string | null = null
  try {
    prompt = await (weekly ? weeklyReviewPrompt($) : spendReviewPrompt($))
  } catch (error) {
    $.ui.toast(`Spend review failed: ${messageOf(error)}`)
  } finally {
    await update($, isOptimizing, () => false)
  }
  if (prompt === null) {
    $.ui.toast('Turn on "Collect usage stats" in spend-bar\'s options to review spend')
    return
  }
  try {
    await $.prompt.submit({ text: prompt })
  } catch (error) {
    $.ui.toast(`Spend review failed: ${messageOf(error)}`)
  }
}

export const register: Register = (on, options) => {
  configureStats(options)
  configureBilling(options)
  configureTrim(options)
  hookStats(on)

  const compactWarnPercent = thresholdOf(options.compactWarnPercent, 40)
  const turnRequestWarning = thresholdOf(options.turnRequestWarning, 40)
  const idleRewriteWarning = thresholdOf(options.idleRewriteWarning, 100_000)
  // Enforce options: both off (0) by default.
  const contextGatePercent = thresholdOf(options.contextGatePercent, 0)
  const turnRequestBrake = thresholdOf(options.turnRequestBrake, 0)
  let isGateNoted = false
  let isBrakePending = false
  let brakeRequests = 0

  const ttlMs = options.cacheTtl === '5m' ? 5 * MINUTE : 60 * MINUTE
  // Amber in the last fifth of the TTL: 12m of an hour, 1m of five minutes.
  const cacheWarnMs = ttlMs / 5
  let stopTicking: (() => void) | undefined
  let isCompactRunning = false

  on('session.compact', async ($, e, next) => {
    const isMainCompaction = e.agentId === undefined && e.trigger !== 'precompute'
    if (isMainCompaction) {
      isCompactRunning = true
      await update($, isCompacting, () => true)
    }
    try {
      const result = await next(e)
      await statsCompacted($, e, result)

      return result
    } finally {
      if (isMainCompaction) {
        isCompactRunning = false
        await update($, isCompacting, () => false)
      }
    }
  })

  on('command.run', { command: 'spend-review' }, async $ => {
    $.clock.after(0, () => {
      void optimizeSpend($, true)
    })

    return { text: 'Reading the last 7 days of spend-bar logs, and the week before for comparison…' }
  })

  // The context gate: a new user turn that starts at or above the limit carries a note only the model
  // reads (prompt.submit's `context`), asking it to tell the user to compact or hand off before new work.
  // Once per crossing: it re-arms when the context falls back under the limit (a compaction, /clear).
  // Slash commands, prompts typed into a running turn and prompts a plugin sends get no note.
  on('prompt.submit', async ($, e, next) => {
    if (contextGatePercent <= 0 || e.origin !== undefined || e.command || e.turnId !== undefined || e.text.trim().startsWith('/')) {
      return next(e)
    }
    const percent = (await read($, usage))?.contextPercent
    if (percent == null || percent < contextGatePercent) {
      isGateNoted = false
      return next(e)
    }
    if (isGateNoted) {
      return next(e)
    }
    isGateNoted = true
    return next({ ...e, context: [...(e.context ?? []), contextGateNote(percent)] })
  })

  // The long-turn brake: at the limit the next tool batch of the main thread carries a note telling
  // the model to stop and report. PostToolBatch is the last hook before the turn's next model request.
  on('classic.PostToolBatch', async (_, e, next) => {
    const result = await next(e)
    if (!isBrakePending || e.agent_id !== undefined) {
      return result
    }
    isBrakePending = false
    return { ...result, additionalContext: [...(result.additionalContext ?? []), turnBrakeNote(brakeRequests)] }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await flushStats($)
    await refreshMonthly($, true)

    return result
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spend-review',
      description: "Review this week's Claude Code spend against the week before, from spend-bar's own logs",
    })
    const result = await next(e)
    await update($, now, () => Date.now())
    await refresh($)
    stopTicking?.()
    const timer = $.clock.every(TICK_MS, () => {
      void update($, now, () => Date.now())
    })
    stopTicking = () => timer.cancel()
    await statsSessionStarted($, e.surface)
    await startBilling($, e.surface)

    return result
  })

  on('session.measure', async ($, e, next) => {
    statsMeasured(e.context.percent ?? null)
    await update($, usage, () => toUsage(e.context, e.rateLimits))
    await billingMeasured($, e.cost?.usd)
    await statsCost($, e.cost?.usd)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const started = await statsStepStarting($, e)
    const result = yield* next(e)
    statsStepEnded(e, result, started)
    if (e.agentId === undefined) {
      const written = result.usage?.cache_creation_input_tokens ?? 0
      const gapMs = started.previous === null ? null : started.startedAt - started.previous
      if (idleRewriteWarning > 0 && gapMs !== null && gapMs > ttlMs && written >= idleRewriteWarning && result.usage) {
        const usd = costOf(result.usage, ttlMs > 5 * MINUTE)
        $.ui.toast(
          `The prompt cache had expired (idle ${duration(gapMs)}), so this request rewrote ${kTokens(written)} tokens${usd === null ? '' : `, about ${dollars(usd)}`}. ` +
            'For a session this large, a new session from a short handoff note is cheaper after a break.',
        )
      }
      const requests = countMainRequest(e.turnId)
      if (requests === 1) {
        isBrakePending = false
      }
      if (turnRequestWarning > 0 && requests === turnRequestWarning) {
        $.ui.toast(
          `This turn has made ${requests} model requests, each resending the whole context. Consider stopping it, compacting, or splitting the work.`,
        )
      }
      if (turnRequestBrake > 0 && requests === turnRequestBrake) {
        $.ui.toast(`Long-turn brake: this turn reached ${requests} model requests, so Claude was told to stop and ask before continuing.`)
        isBrakePending = true
        brakeRequests = requests
      }
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
    const month = await read($, monthly)
    const spent = await read($, sessionUsd)

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
    if (current?.spendLimit) {
      const { percent } = current.spendLimit
      pills.push(pill('spend', levelOf(percent, 75, 90), `spend ${Math.round(percent)}%${untilReset(current.spendLimit, at)}`))
    }
    // A usage-billed seat (Enterprise, Team) has no windows: its limit is the month's extra usage.
    if (month) {
      pills.push(pill('month', levelOf(month.percent, 75, 90), `month ${dollars(month.spent)}/${dollars(month.limit)}`))
    }
    if (!current?.session && !current?.weekly && !current?.spendLimit && !month && spent === null) {
      pills.push(pill('limits', 'ok', 'limits —'))
    }
    if (spent !== null) {
      const warnAt = thresholdOf(options.sessionCostWarning, 25)
      const level = warnAt > 0 ? levelOf(spent, warnAt - 0.005, warnAt * 2 - 0.005) : 'ok'
      pills.push(pill('cost', level, `session ${dollars(spent)}`))
    }

    if (e.props.isWorking) {
      pills.push(pill('cache', 'ok', 'cache live'))
    } else if (last === null) {
      pills.push(pill('cache', 'ok', 'cache —'))
    } else {
      const left = last + ttlMs - at
      if (left <= 0) {
        pills.push(pill('cache', 'alert', 'cache expired'))
      } else {
        pills.push(pill('cache', left <= cacheWarnMs ? 'warn' : 'ok', `cache ${duration(left)} left`))
      }
    }

    if (current?.contextPercent != null) {
      pills.push(pill('context', levelOf(current.contextPercent, 20, 30), `ctx ${current.contextPercent}%`))
    } else {
      pills.push(pill('context', 'ok', 'ctx —'))
    }

    const canCompact = !compacting && isCompactable(current)
    const shouldCompact =
      canCompact && compactWarnPercent > 0 && current?.contextPercent != null && current.contextPercent >= compactWarnPercent
    const optimizing = await read($, isOptimizing)

    const optimize = async () => {
      if (await read($, isOptimizing)) return
      await update($, isOptimizing, () => true)
      $.clock.after(0, () => {
        void optimizeSpend($)
      })
    }

    const compact = async () => {
      if ((await read($, isCompacting)) || !isCompactable(await read($, usage))) return
      await update($, isCompacting, () => true)
      $.clock.after(0, () => {
        void (async () => {
          try {
            await $.command.run({ command: 'compact' })
          } catch (error) {
            $.ui.toast(`Compact failed: ${messageOf(error)}`)
          } finally {
            if (!isCompactRunning) await update($, isCompacting, () => false)
          }
        })()
      })
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        {pills}
        {shouldCompact ? (
          <Button key="compact" label="↓" hotkey="c" dimColor={false} onPress={compact}>
            <Text color="warning" bold>
              ↓
            </Text>
          </Button>
        ) : (
          <Button key="compact" label={compacting ? '↓…' : '↓'} hotkey="c" dimColor={!canCompact} onPress={compact} />
        )}
        <Button key="optimize" label={optimizing ? '$…' : '$'} hotkey="o" dimColor={optimizing} onPress={optimize} />
      </Box>
    )
  })
}
