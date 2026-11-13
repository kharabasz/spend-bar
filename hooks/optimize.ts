import type { EngineInterface } from 'claude-code'

import { CHANGES_FILES, dayOf, flushStats, isCollectingStats, statsLocation, statsSessionId } from './stats'
import type { Line, RepeatKind } from './stats'
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
  // Reads of a path already read in the session, any agent, denied and failed reads included.
  repeatedReads: number
  // The same repeats by kind (RepeatKind); 'denied or failed' and, for logs from before 0.7.0,
  // 'unclassified' hold the rest.
  repeatsByKind: Tally
  // Over 20k characters by the tool's own record (Edit's and Write's hold the whole file).
  largeResults: number
  largeResultsByTool: Tally
  // Over 20k characters as the model read them.
  seenLargeResults: number
  seenLargeByTool: Tally
  // Edit/Write results over 20k by record in logs from before 0.7.0, whose read size is unknown.
  unmeasuredLarge: number
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
    repeatsByKind: {},
    largeResults: 0,
    largeResultsByTool: {},
    seenLargeResults: 0,
    seenLargeByTool: {},
    unmeasuredLarge: 0,
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
      // 0.7.0 and later record seenBytes on every tool line, and a repeat kind on repeated reads.
      const isMeasured = typeof line.seenBytes === 'number'
      if (tool === 'Read' && typeof line.path === 'string') {
        score.reads++
        const key = `${String(line.sid)}:${line.path}`
        if (readPaths.has(key)) {
          score.repeatedReads++
          const kind = !isMeasured
            ? 'unclassified'
            : typeof line.repeat === 'string'
              ? line.repeat
              : line.isDenied === true || line.isError === true
                ? 'denied or failed'
                : 'unclassified'
          bump(score.repeatsByKind, kind)
        }
        readPaths.add(key)
      }
      if (numberOf(line.bytes) > LARGE_RESULT_BYTES) {
        score.largeResults++
        bump(score.largeResultsByTool, tool)
      }
      const seen = isMeasured
        ? numberOf(line.seenBytes)
        : CHANGES_FILES.has(tool)
          ? null
          : typeof line.sentBytes === 'number'
            ? line.sentBytes
            : numberOf(line.bytes)
      if (seen === null) {
        if (numberOf(line.bytes) > LARGE_RESULT_BYTES) score.unmeasuredLarge++
      } else if (seen > LARGE_RESULT_BYTES) {
        score.seenLargeResults++
        bump(score.seenLargeByTool, tool)
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

const REPEAT_LABELS: [RepeatKind | 'denied or failed' | 'unclassified', string][] = [
  ['exact', 're-read lines the same agent had already read, file unchanged'],
  ['new-range', 'read lines the same agent had not read yet'],
  ['after-change', 'after an Edit or Write changed the file'],
  ['after-compact', 'after a compaction'],
  ['cross-agent', 'by another agent (agents do not share context)'],
  ['denied or failed', 'denied or failed'],
  ['unclassified', 'from logs before kinds were recorded'],
]

function describeRepeats(score: Score): string {
  const parts = REPEAT_LABELS.filter(([kind]) => (score.repeatsByKind[kind] ?? 0) > 0).map(
    ([kind, label]) => `${score.repeatsByKind[kind]} ${label}`,
  )
  return `${score.repeatedReads} of ${score.reads} reads named a file read earlier in the session${parts.length ? ` (${parts.join('; ')})` : ''}`
}

function byTool(tally: Tally): string {
  return top(tally, 3)
    .map(([tool, n]) => `${tool} ${n}`)
    .join(', ')
}

function describeLarge(score: Score): string {
  const seenBy = byTool(score.seenLargeByTool)
  const recordBy = byTool(score.largeResultsByTool)
  const unmeasured = score.unmeasuredLarge > 0 ? `, ${score.unmeasuredLarge} older Edit/Write results not measured as read` : ''
  return (
    `${score.seenLargeResults} tool results over ${compact(LARGE_RESULT_BYTES)} chars as the model read them${seenBy ? ` (${seenBy})` : ''}, ` +
    `${score.trimmedCalls} trimmed by spend-bar; ${score.largeResults} over ${compact(LARGE_RESULT_BYTES)} by the tool's own record${recordBy ? ` (${recordBy})` : ''}, ` +
    `which for Edit and Write holds the whole file and is not what the model reads${unmeasured}`
  )
}

export function describeScore(score: Score): string {
  if (score.requests === 0) return 'no logged requests'
  return [
    `${score.requests} requests costing about ${dollars(score.usd)} at list prices (${percent(score.subagentUsd, score.usd)} in subagents), ${compact(score.sentTokens)} tokens sent, ${compact(score.outputTokens)} output`,
    `${percent(score.sentAboveContext, score.sentAtKnownContext)} of main-thread tokens sent above ${HIGH_CONTEXT_PERCENT}% context`,
    `${score.longTurns} of ${score.turns} turns over ${LONG_TURN_REQUESTS} requests (${score.longTurnRequests} requests in them)`,
    `${(score.shellCalls / score.requests).toFixed(2)} shell calls per request`,
    describeRepeats(score),
    describeLarge(score),
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

export function usdByDay(lines: readonly Line[]): Tally {
  const byDay: Tally = {}
  for (const line of lines) {
    if (line.kind === 'step') bump(byDay, dayOf(line.t), numberOf(line.usd))
  }
  return byDay
}

function change(now: number, before: number): string {
  if (before <= 0) return now > 0 ? 'new' : 'flat'
  const delta = Math.round(((now - before) / before) * 100)
  return `${delta >= 0 ? '+' : ''}${delta}%`
}

function dayCosts(byDay: Tally, days: readonly string[]): string {
  return [...days]
    .reverse()
    .map(day => `${day.slice(5)} ${dollars(byDay[day] ?? 0)}`)
    .join(', ')
}

// The weekly review: this week set against the one before, from the event logs alone.
export function buildWeeklyPrompt(
  week: Score,
  prior: Score,
  days: readonly string[],
  byDay: Tally,
  totals: readonly DayTotals[],
): string {
  const commands = top(week.commands, TOP_COMMANDS)
    .map(([cmd, n]) => `${cmd} ${n}${week.commandErrors[cmd] ? ` (${week.commandErrors[cmd]} failed)` : ''}`)
    .join(', ')
  const errors = top(week.errors, TOP_ERRORS)
    .map(([text, n]) => `"${text}" x${n}`)
    .join('; ')
  return [
    'Weekly spend review from the spend-bar mod. Compare this week with the one before and tell me, in under 300 words:',
    'what changed and why it likely did, the three to five habits, settings, CLAUDE.md rules, hooks or scripts that would cut the most, biggest saving first,',
    'and one number to watch next week. Do not run tools or change files; just answer.',
    '',
    `This week (last ${WEEK_DAYS} days): ${describeScore(week)}; ${describeTotals(totals)}.`,
    `The week before: ${describeScore(prior)}.`,
    `Estimated cost against the week before: ${change(week.usd, prior.usd)} (${dollars(week.usd)} vs ${dollars(prior.usd)}); requests ${change(week.requests, prior.requests)}.`,
    `Estimated cost by day: ${dayCosts(byDay, days)}.`,
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

export async function weeklyReviewPrompt($: EngineInterface): Promise<string | null> {
  if (!isCollectingStats()) return null
  await flushStats($)
  const days = weekDays(await $.clock.now())
  const before = weekDays((await $.clock.now()) - WEEK_DAYS * DAY)
  const lines = await readWeek($, [...days, ...before])
  const inWeek = new Set(days)
  const thisWeek = lines.filter(line => inWeek.has(dayOf(line.t)))
  const lastWeek = lines.filter(line => !inWeek.has(dayOf(line.t)))
  return buildWeeklyPrompt(
    scoreLines(thisWeek),
    scoreLines(lastWeek),
    days,
    usdByDay(lines),
    await readTotals($, days),
  )
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
