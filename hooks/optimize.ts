import type { EngineInterface } from 'claude-code'

import { dayOf, flushStats, isCollectingStats, statsLocation, statsSessionId } from './stats'
import type { Line } from './stats'
import { dollars } from './pricing'

const DAY = 24 * 60 * 60_000
const WEEK_DAYS = 7
const HIGH_CONTEXT_PERCENT = 40
const LONG_TURN_REQUESTS = 50
const LARGE_RESULT_BYTES = 20_000
const BIG_REWRITE_TOKENS = 100_000
const TOP_COMMANDS = 5
const TOP_ERRORS = 3

type Tally = Record<string, number>

export type Score = {
  requests: number
  usd: number
  subagentUsd: number
  sentTokens: number
  outputTokens: number
  sentAtKnownContext: number
  sentAboveContext: number
  turns: number
  longTurns: number
  longTurnRequests: number
  shellCalls: number
  reads: number
  repeatedReads: number
  largeResults: number
  largeResultsByTool: Tally
  bigRewrites: number
  bigRewriteTokens: number
  trimmedCalls: number
  commands: Tally
  commandErrors: Tally
  errors: Tally
}

export type DayTotals = {
  estimatedUsd?: number
  billedUsd?: number
  idleCacheRewrites?: { count?: number; tokens?: number; usd?: number }
  compactions?: Tally
  subagentRequests?: number
  models?: Record<string, { requests?: number }>
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function bump(tally: Tally, key: string, amount = 1) {
  tally[key] = (tally[key] ?? 0) + amount
}

export function scoreLines(lines: readonly Line[]): Score {
  const score: Score = {
    requests: 0,
    usd: 0,
    subagentUsd: 0,
    sentTokens: 0,
    outputTokens: 0,
    sentAtKnownContext: 0,
    sentAboveContext: 0,
    turns: 0,
    longTurns: 0,
    longTurnRequests: 0,
    shellCalls: 0,
    reads: 0,
    repeatedReads: 0,
    largeResults: 0,
    largeResultsByTool: {},
    bigRewrites: 0,
    bigRewriteTokens: 0,
    trimmedCalls: 0,
    commands: {},
    commandErrors: {},
    errors: {},
  }
  const turnRequests = new Map<string, number>()
  const readPaths = new Set<string>()

  for (const line of lines) {
    if (line.kind === 'step') {
      const sent = numberOf(line.in) + numberOf(line.cacheRead) + numberOf(line.cacheWrite)
      score.requests++
      score.usd += numberOf(line.usd)
      if (line.agent != null) score.subagentUsd += numberOf(line.usd)
      score.sentTokens += sent
      score.outputTokens += numberOf(line.out)
      if (numberOf(line.cacheWrite) > BIG_REWRITE_TOKENS) {
        score.bigRewrites++
        score.bigRewriteTokens += numberOf(line.cacheWrite)
      }
      if (line.agent == null) {
        if (typeof line.ctx === 'number') {
          score.sentAtKnownContext += sent
          if (line.ctx > HIGH_CONTEXT_PERCENT) score.sentAboveContext += sent
        }
        const turn = `${String(line.sid)}:${String(line.turn)}`
        turnRequests.set(turn, (turnRequests.get(turn) ?? 0) + 1)
      }
    } else if (line.kind === 'tool') {
      const tool = String(line.tool)
      if (tool === 'Bash' || tool === 'PowerShell') score.shellCalls++
      if (tool === 'Read' && typeof line.path === 'string') {
        score.reads++
        const key = `${String(line.sid)}:${line.path}`
        if (readPaths.has(key)) score.repeatedReads++
        readPaths.add(key)
      }
      if (numberOf(line.bytes) > LARGE_RESULT_BYTES) {
        score.largeResults++
        bump(score.largeResultsByTool, tool)
      }
      if (typeof line.sentBytes === 'number') score.trimmedCalls++
      if (typeof line.cmd === 'string') {
        bump(score.commands, line.cmd)
        if (line.isError === true) bump(score.commandErrors, line.cmd)
      }
      if (typeof line.err === 'string' && line.err) bump(score.errors, `${String(line.cmd ?? tool)}: ${line.err}`)
    }
  }

  score.turns = turnRequests.size
  for (const requests of turnRequests.values()) {
    if (requests > LONG_TURN_REQUESTS) {
      score.longTurns++
      score.longTurnRequests += requests
    }
  }
  return score
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : 'n/a'
}

function top(tally: Tally, count: number): [string, number][] {
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
}

export function describeScore(score: Score): string {
  if (score.requests === 0) return 'no logged requests'
  const largeBy = top(score.largeResultsByTool, 3)
    .map(([tool, n]) => `${tool} ${n}`)
    .join(', ')
  return [
    `${score.requests} requests costing about ${dollars(score.usd)} at list prices (${percent(score.subagentUsd, score.usd)} in subagents), ${compact(score.sentTokens)} tokens sent, ${compact(score.outputTokens)} output`,
    `${percent(score.sentAboveContext, score.sentAtKnownContext)} of main-thread tokens sent above ${HIGH_CONTEXT_PERCENT}% context`,
    `${score.longTurns} of ${score.turns} turns over ${LONG_TURN_REQUESTS} requests (${score.longTurnRequests} requests in them)`,
    `${(score.shellCalls / score.requests).toFixed(2)} shell calls per request`,
    `${score.repeatedReads} of ${score.reads} reads repeated`,
    `${score.largeResults} tool results over ${compact(LARGE_RESULT_BYTES)} chars${largeBy ? ` (${largeBy})` : ''}, ${score.trimmedCalls} trimmed`,
    `${score.bigRewrites} cache rewrites over ${compact(BIG_REWRITE_TOKENS)} tokens (${compact(score.bigRewriteTokens)} tokens)`,
  ].join('; ')
}

export function describeTotals(days: readonly DayTotals[]): string {
  let idle = 0
  let idleTokens = 0
  let idleUsd = 0
  let billed = 0
  let subagents = 0
  let requests = 0
  const compactions: Tally = {}
  for (const day of days) {
    idle += numberOf(day.idleCacheRewrites?.count)
    idleTokens += numberOf(day.idleCacheRewrites?.tokens)
    idleUsd += numberOf(day.idleCacheRewrites?.usd)
    billed += numberOf(day.billedUsd)
    subagents += numberOf(day.subagentRequests)
    for (const model of Object.values(day.models ?? {})) requests += numberOf(model.requests)
    for (const [trigger, n] of Object.entries(day.compactions ?? {})) bump(compactions, trigger, numberOf(n))
  }
  const compacted = Object.entries(compactions)
    .map(([trigger, n]) => `${trigger} ${n}`)
    .join(', ')
  return [
    ...(billed > 0 ? [`${dollars(billed)} billed`] : []),
    `${idle} cache rewrites after the cache expired (${compact(idleTokens)} tokens, about ${dollars(idleUsd)})`,
    `${percent(subagents, requests)} of requests from subagents`,
    `compactions: ${compacted || 'none'}`,
  ].join('; ')
}

export function buildPrompt(session: Score, week: Score, days: readonly DayTotals[]): string {
  const commands = top(week.commands, TOP_COMMANDS)
    .map(([cmd, n]) => `${cmd} ${n}${week.commandErrors[cmd] ? ` (${week.commandErrors[cmd]} failed)` : ''}`)
    .join(', ')
  const errors = top(week.errors, TOP_ERRORS)
    .map(([text, n]) => `"${text}" x${n}`)
    .join('; ')
  return [
    'Spend review from the spend-bar mod. From these numbers, suggest the three to five changes to how I work with Claude Code',
    '(habits, settings, CLAUDE.md rules, hooks or scripts) that would cut token spend the most, biggest saving first, in under 250 words.',
    'Do not run tools or change files; just answer.',
    '',
    `This session: ${describeScore(session)}.`,
    `Past ${WEEK_DAYS} days: ${describeScore(week)}; ${describeTotals(days)}.`,
    `Top shell commands this week: ${commands || 'none'}.`,
    ...(errors ? [`Most common shell errors: ${errors}.`] : []),
  ].join('\n')
}

function parseLines(text: string): Line[] {
  const parsed: Line[] = []
  for (const row of text.split('\n')) {
    if (!row.trim()) continue
    try {
      const line = JSON.parse(row) as Line
      if (line && typeof line === 'object' && typeof line.kind === 'string') parsed.push(line)
    } catch {
      continue
    }
  }
  return parsed
}

export function weekDays(now: number): string[] {
  return Array.from({ length: WEEK_DAYS }, (_, i) => dayOf(now - i * DAY))
}

async function readWeek($: EngineInterface, days: readonly string[]): Promise<Line[]> {
  const place = statsLocation()
  if (!place) return []
  const lines: Line[] = []
  for (const day of days) {
    const folder = `${place.dir}${place.sep}${day}`
    if (!(await $.fs.exists(folder))) continue
    for (const entry of await $.fs.list(folder)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
      lines.push(...parseLines(await $.fs.read(`${folder}${place.sep}${entry.name}`)))
    }
  }
  return lines
}

async function readTotals($: EngineInterface, days: readonly string[]): Promise<DayTotals[]> {
  const totals: DayTotals[] = []
  for (const day of days) {
    const stored = await $.store.get(`day:${day}`)
    if (stored && typeof stored === 'object') totals.push(stored as DayTotals)
  }
  return totals
}

export async function spendReviewPrompt($: EngineInterface): Promise<string | null> {
  if (!isCollectingStats()) return null
  await flushStats($)
  const days = weekDays(await $.clock.now())
  const lines = await readWeek($, days)
  const sessionId = statsSessionId()
  return buildPrompt(
    scoreLines(lines.filter(line => line.sid === sessionId)),
    scoreLines(lines),
    await readTotals($, days),
  )
}
