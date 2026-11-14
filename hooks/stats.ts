import { atom, read } from 'claude-code'
import type { EngineInterface, Register, SessionCompactInput, SessionCompactResult, ToolCallResult, TurnUsage } from 'claude-code'

import { costOf } from './pricing'
import { trimToolResult } from './trim'

const lastResponseAt = atom({ plugin: 'spend-bar', key: 'lastResponseAt' } as const, null)

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const RETENTION_DAYS = 30
const OUTPUT_RETENTION_DAYS = 7
const ERROR_TEXT_LENGTH = 100
const FILE_LIMIT_BYTES = 3 * 1024 * 1024
const DAY_KEY_PREFIX = 'day:'
// The same skill can reach three hooks at once (skill.prompt, the Skill tool call, the slash command);
// one run counts once. Likewise a compaction can reach session.compact and its boundary notice.
const SAME_SKILL_RUN_MS = 5_000
const SAME_COMPACTION_MS = 30_000

type On = Parameters<Register>[0]
type Options = Parameters<Register>[1]

type Counts = { [key: string]: number | Counts }

export type Line = { t: number; kind: string; [field: string]: unknown }

export type Location = { dir: string; sep: string; isWindows: boolean }

type StepInput = { turnId: string; index: number; effort?: string | number; agentId?: string }

type StepResult = { usage: TurnUsage | null; toolUses: readonly { name: string }[] }

export type StepStart = { previous: number | null; startedAt: number }

// Why a Read named a file this session had read before:
// - exact: the same agent re-read lines it had already read, file unchanged, no compaction since;
// - new-range: the same agent read lines it had not read yet (paging through a file by offset/limit);
// - after-change: an Edit, Write, MultiEdit or NotebookEdit changed the file since this agent read it;
// - after-compact: this agent's context was compacted since it read the file;
// - cross-agent: another agent (the main thread or a subagent) read it, but not this one, and
//   agents do not share context.
// Changes made through a shell command are not seen, so they count as exact or new-range.
export type RepeatKind = 'exact' | 'new-range' | 'after-change' | 'after-compact' | 'cross-agent'

type ReadSeen = { spans: [number, number][]; pages: Set<string>; changes: number; compactions: number }

// Tools that change files; their record holds the whole file, which the model never reads back.
export const CHANGES_FILES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const FILE_RECORD_FIELDS = ['originalFile', 'content', 'structuredPatch', 'gitDiff']
// The Read tool's default: 2000 lines from the start.
const READ_DEFAULT_LIMIT = 2000
const MAIN_AGENT = 'main'

let isEnabled = false
let ttlMs = 60 * MINUTE
let configuredDir = ''
let location: Location | null = null
let sessionId = 'unknown'
let lines: Line[] = []
let rollups: Record<string, Counts> = {}
let contextPercent: number | null = null
let billedUsd: number | null = null
let flushing: Promise<void> = Promise.resolve()
let hasLoggedFailure = false
const readPaths = new Set<string>()
const readsByPath = new Map<string, Map<string, ReadSeen>>()
const changesByPath = new Map<string, number>()
const compactionsByAgent = new Map<string, number>()
const skillSeenAt = new Map<string, number>()
let compactRecordedAt: number | null = null

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function hashPath(path: string): string {
  let hash = 0x811c9dc5
  for (const char of path.replace(/\\/g, '/').toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function add(target: Counts, branch: readonly string[], leaf: string, amount: number) {
  let node = target
  for (const key of branch) {
    const next = node[key]
    if (typeof next === 'object') {
      node = next
    } else {
      const created: Counts = {}
      node[key] = created
      node = created
    }
  }
  const current = node[leaf]
  node[leaf] = (typeof current === 'number' ? current : 0) + amount
}

export function mergeCounts(into: Counts, from: Counts): Counts {
  const merged: Counts = { ...into }
  for (const [key, value] of Object.entries(from)) {
    const existing = merged[key]
    if (typeof value === 'number') {
      merged[key] = (typeof existing === 'number' ? existing : 0) + value
    } else {
      merged[key] = mergeCounts(typeof existing === 'object' ? existing : {}, value)
    }
  }
  return merged
}

function sizeOf(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

export function firstWord(command: string): string {
  const segments = command
    .split(/&&|\|\||;|\r?\n/)
    .map(segment => segment.trim())
    .filter(Boolean)
  const main = segments.find(segment => !/^(cd|pushd|set-location|sl)\b/i.test(segment)) ?? segments[0] ?? ''
  const bare = main.replace(/^(&\s*|\(\s*|\w+=\S*\s+|(sudo|env|time)\s+)+/i, '')
  const match = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(bare)
  const word = match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
  const name = word.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').toLowerCase().slice(0, 40) || '?'
}

function shellCommandOf(input: { tool: string }): string | undefined {
  if (input.tool !== 'Bash' && input.tool !== 'PowerShell') return undefined
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

export function errorTextOf(result: ToolCallResult): string {
  const value = result.result as { stderr?: unknown } | string | undefined
  const stderr = typeof value === 'object' && value !== null && typeof value.stderr === 'string' ? value.stderr : ''
  const text = stderr.trim() || (typeof result.text === 'string' ? result.text : typeof value === 'string' ? value : '')
  return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_TEXT_LENGTH)
}

function filePathOf(input: object): string | undefined {
  const path = (input as { file_path?: unknown }).file_path
  return typeof path === 'string' ? path : undefined
}

function changedPathOf(input: { tool: string }): string | undefined {
  if (!CHANGES_FILES.has(input.tool)) return undefined
  const notebook = (input as { notebook_path?: unknown }).notebook_path
  return filePathOf(input) ?? (typeof notebook === 'string' ? notebook : undefined)
}

// How many characters the model read: core's `text` (the result as the model reads it) plus any
// reminder after it. A hook's own result (spend-bar's trimmed shell output) has no `text`, so its
// size counts; a file-changing tool without `text` counts without the file copies in its record.
export function seenSizeOf(tool: string, answer: ToolCallResult): number {
  if (typeof answer.deny === 'string') return answer.deny.length
  const context = ((answer as { context?: readonly string[] }).context ?? []).reduce((sum, text) => sum + text.length, 0)
  if (typeof answer.text === 'string') return answer.text.length + context
  const value = answer.result
  if (CHANGES_FILES.has(tool) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const field of FILE_RECORD_FIELDS) delete rest[field]
    return sizeOf(rest) + context
  }
  return sizeOf(value) + context
}

function isCovered(spans: readonly [number, number][], start: number, end: number): boolean {
  let reached = start
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (from > reached) break
    reached = Math.max(reached, to)
    if (reached >= end) return true
  }
  return reached >= end
}

// The kind of repeat a successful Read is, or null for the session's first read of the file.
function classifyRead(pathHash: string, agent: string, input: object): RepeatKind | null {
  const { offset, limit, pages } = input as { offset?: unknown; limit?: unknown; pages?: unknown }
  const start = Math.max(typeof offset === 'number' ? offset : 1, 1)
  const end = start + (typeof limit === 'number' && limit > 0 ? limit : READ_DEFAULT_LIMIT)
  const page = typeof pages === 'string' && pages ? pages : null
  const changes = changesByPath.get(pathHash) ?? 0
  const compactions = compactionsByAgent.get(agent) ?? 0
  const byAgent = readsByPath.get(pathHash) ?? new Map<string, ReadSeen>()
  readsByPath.set(pathHash, byAgent)
  const seen = byAgent.get(agent)
  const now: ReadSeen = { spans: [], pages: new Set(), changes, compactions }
  let kind: RepeatKind | null
  if (!seen) {
    kind = byAgent.size === 0 ? null : 'cross-agent'
  } else if (seen.changes !== changes) {
    kind = 'after-change'
  } else if (seen.compactions !== compactions) {
    kind = 'after-compact'
  } else {
    const isSeen = page === null ? isCovered(seen.spans, start, end) : seen.pages.has(page)
    kind = isSeen ? 'exact' : 'new-range'
    now.spans = seen.spans
    now.pages = seen.pages
  }
  if (page === null) now.spans.push([start, end])
  else now.pages.add(page)
  byAgent.set(agent, now)
  return kind
}

function countCompaction(agent: string | null | undefined) {
  const key = agent ?? MAIN_AGENT
  compactionsByAgent.set(key, (compactionsByAgent.get(key) ?? 0) + 1)
}

function record(line: Line, counts: (day: Counts) => void) {
  lines.push(line)
  const day = dayOf(line.t)
  const rollup = rollups[day] ?? {}
  counts(rollup)
  rollups[day] = rollup
}

function fail($: EngineInterface, step: string, error: unknown) {
  if (hasLoggedFailure) return
  hasLoggedFailure = true
  $.ui.log(`spend-bar stats: ${step} failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
}

async function locate($: EngineInterface): Promise<Location | null> {
  const localAppData = await $.env.get('LOCALAPPDATA')
  if (configuredDir) {
    const isWindows = localAppData !== undefined
    return { dir: configuredDir.replace(/[\\/]+$/, ''), sep: isWindows ? '\\' : '/', isWindows }
  }
  if (localAppData) {
    return { dir: `${localAppData}\\claude-toolkit\\spend-bar\\events`, sep: '\\', isWindows: true }
  }
  const stateHome = await $.env.get('XDG_STATE_HOME')
  const home = await $.env.get('HOME')
  // macOS keeps app data in ~/Library/Application Support; its homes, and only its, are under /Users.
  const isMac = !stateHome && home !== undefined && home.startsWith('/Users/')
  const base = stateHome || (home ? (isMac ? `${home}/Library/Application Support` : `${home}/.local/state`) : undefined)
  return base ? { dir: `${base}/claude-toolkit/spend-bar/events`, sep: '/', isWindows: false } : null
}

async function fileFor($: EngineInterface, place: Location, folder: string) {
  for (let part = 0; ; part++) {
    const name = part === 0 ? `${sessionId}.jsonl` : `${sessionId}.${part}.jsonl`
    const path = `${folder}${place.sep}${name}`
    if (!(await $.fs.exists(path))) return { path, existing: '' }
    const { size } = await $.fs.stat(path)
    if (size < FILE_LIMIT_BYTES) return { path, existing: await $.fs.read(path) }
  }
}

async function writeLines($: EngineInterface, batch: Line[]) {
  const place = location
  if (!place || batch.length === 0) return
  const byDay = new Map<string, Line[]>()
  for (const line of batch) {
    const day = dayOf(line.t)
    byDay.set(day, [...(byDay.get(day) ?? []), line])
  }
  for (const [day, dayLines] of byDay) {
    const { path, existing } = await fileFor($, place, `${place.dir}${place.sep}${day}`)
    const text = dayLines.map(line => JSON.stringify({ sid: sessionId, ...line })).join('\n') + '\n'
    await $.fs.write(path, existing + text)
  }
}

async function writeRollups($: EngineInterface, batch: Record<string, Counts>) {
  for (const [day, counts] of Object.entries(batch)) {
    const key = `${DAY_KEY_PREFIX}${day}`
    const stored = await $.store.get(key)
    const current = stored && typeof stored === 'object' ? (stored as Counts) : {}
    await $.store.set(key, mergeCounts(current, counts))
  }
}

async function writeBatch($: EngineInterface, batch: Line[], batchRollups: Record<string, Counts>) {
  try {
    await writeRollups($, batchRollups)
  } catch (error) {
    fail($, 'saving daily totals', error)
  }
  try {
    await writeLines($, batch)
  } catch (error) {
    fail($, 'writing the event log', error)
  }
}

export async function flushStats($: EngineInterface) {
  if (!isEnabled) return
  await drainCompactions($)
  const batch = lines
  const batchRollups = rollups
  lines = []
  rollups = {}
  const previous = flushing
  flushing = (async () => {
    await previous
    await writeBatch($, batch, batchRollups)
  })()
  await flushing
}

async function pruneDays($: EngineInterface, place: Location, dir: string, cutoff: string) {
  if (!(await $.fs.exists(dir))) return
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'dir' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name) || entry.name >= cutoff) continue
    const folder = `${dir}${place.sep}${entry.name}`
    await $.process.run(place.isWindows ? ['cmd', '/c', 'rmdir', '/s', '/q', folder] : ['rm', '-rf', folder])
  }
}

async function prune($: EngineInterface, now: number) {
  const cutoff = dayOf(now - RETENTION_DAYS * DAY)
  for (const key of await $.store.keys()) {
    if (key.startsWith(DAY_KEY_PREFIX) && key.slice(DAY_KEY_PREFIX.length) < cutoff) {
      await $.store.delete(key)
    }
  }
  const place = location
  if (place) await pruneDays($, place, place.dir, cutoff)
}

async function pruneOutputs($: EngineInterface, now: number) {
  const place = location
  if (place) await pruneDays($, place, `${place.dir}${place.sep}output`, dayOf(now - OUTPUT_RETENTION_DAYS * DAY))
}

export function statsLocation(): Location | null {
  return location
}

export function statsSessionId(): string {
  return sessionId
}

export function isCollectingStats(): boolean {
  return isEnabled
}

export function configureStats(options: Options) {
  isEnabled = options.collectStats !== false
  ttlMs = options.cacheTtl === '5m' ? 5 * MINUTE : 60 * MINUTE
  configuredDir = typeof options.statsDir === 'string' ? options.statsDir.trim() : ''
}

export async function statsSessionStarted($: EngineInterface, surface: string | null) {
  try {
    location = await locate($)
    sessionId = await $.session.id()
    await pruneOutputs($, await $.clock.now())
  } catch (error) {
    fail($, 'locating the stats folder', error)
  }
  if (!isEnabled) return
  try {
    readPaths.clear()
    readsByPath.clear()
    changesByPath.clear()
    compactionsByAgent.clear()
    skillSeenAt.clear()
    compactRecordedAt = null
    // The baseline: a resumed session has cost this much already, none of it this session's growth.
    billedUsd = (await $.session.usage()).cost?.usd ?? null
    const now = await $.clock.now()
    const tools = await $.tool.list()
    const mcpTools = tools.filter(t => t.mcp)
    record(
      {
        t: now,
        kind: 'session',
        model: await $.session.model(),
        surface,
        tools: tools.length,
        mcpTools: mcpTools.length,
        mcpServers: [...new Set(mcpTools.map(t => t.name.split('__')[1] ?? t.name))],
      },
      day => add(day, [], 'sessions', 1),
    )
    await flushStats($)
    await prune($, now)
  } catch (error) {
    fail($, 'starting', error)
  }
}

export function statsMeasured(percent: number | null) {
  contextPercent = percent
}

// Read even with stats off: the idle-rewrite alert needs the gap too.
export async function statsStepStarting($: EngineInterface, e: StepInput): Promise<StepStart> {
  return {
    previous: e.agentId === undefined ? await read($, lastResponseAt) : null,
    startedAt: await $.clock.now(),
  }
}

export function statsStepEnded(e: StepInput, result: StepResult, { previous, startedAt }: StepStart) {
  const usage = result.usage
  if (!isEnabled || !usage) return
  const isMain = e.agentId === undefined
  const gapMs = previous === null ? null : startedAt - previous
  const isIdleRewrite = gapMs !== null && gapMs > ttlMs && usage.cache_creation_input_tokens > 0
  const ctx = isMain ? contextPercent : null
  // Main-thread writes at the configured TTL; subagents write at the 5-minute rate.
  const usd = costOf(usage, isMain && ttlMs > 5 * MINUTE)
  record(
    {
      t: startedAt,
      kind: 'step',
      turn: e.turnId,
      index: e.index,
      model: usage.model,
      effort: e.effort ?? null,
      agent: e.agentId ?? null,
      in: usage.input_tokens,
      out: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      usd: usd === null ? null : Math.round(usd * 1_000_000) / 1_000_000,
      gapMs,
      ctx,
      tools: result.toolUses.map(use => use.name),
    },
    day => {
      const model = ['models', usage.model]
      add(day, model, 'requests', 1)
      add(day, model, 'input', usage.input_tokens)
      add(day, model, 'output', usage.output_tokens)
      add(day, model, 'cacheRead', usage.cache_read_input_tokens)
      add(day, model, 'cacheWrite', usage.cache_creation_input_tokens)
      if (usd !== null) {
        add(day, model, 'usd', usd)
        add(day, [], 'estimatedUsd', usd)
        if (!isMain) add(day, [], 'subagentUsd', usd)
      }
      if (!isMain) add(day, [], 'subagentRequests', 1)
      if (e.effort !== undefined) add(day, ['effort'], String(e.effort), 1)
      if (isIdleRewrite) {
        add(day, ['idleCacheRewrites'], 'count', 1)
        add(day, ['idleCacheRewrites'], 'tokens', usage.cache_creation_input_tokens)
        if (usd !== null) add(day, ['idleCacheRewrites'], 'usd', usd)
      }
      if (ctx !== null) {
        add(day, ['context'], 'samples', 1)
        if (ctx > 40) add(day, ['context'], 'over40', 1)
        if (ctx > 60) add(day, ['context'], 'over60', 1)
      }
    },
  )
}

// The engine's billed total (/cost) grows with each response; the day keeps what it grew by, so a
// spend review can set the estimate beside what was billed.
export async function statsCost($: EngineInterface, usd: number | undefined) {
  if (!isEnabled || usd === undefined) return
  const previous = billedUsd
  billedUsd = usd
  const delta = usd - (previous ?? 0)
  if (delta <= 0) return
  record({ t: await $.clock.now(), kind: 'cost', usd: Math.round(usd * 1_000_000) / 1_000_000 }, day => add(day, [], 'billedUsd', delta))
}

// Counts one skill run, from whichever hook sees it first. A plugin above this one (the built-in
// security guard) passes skill.prompt over, so the Skill tool call and the slash command count too.
async function statsSkill($: EngineInterface, skill: string, via: 'prompt' | 'tool' | 'command') {
  if (!isEnabled) return
  const t = await $.clock.now()
  const seenAt = skillSeenAt.get(skill)
  if (seenAt !== undefined && t - seenAt < SAME_SKILL_RUN_MS) return
  skillSeenAt.set(skill, t)
  record({ t, kind: 'skill', skill, via }, day => add(day, ['skills'], skill, 1))
}

export async function statsCompacted($: EngineInterface, e: SessionCompactInput, result: SessionCompactResult) {
  if (!isEnabled) return
  const t = await $.clock.now()
  compactRecordedAt = t
  countCompaction(e.agentId)
  record(
    {
      t,
      kind: 'compact',
      trigger: e.trigger,
      agent: e.agentId ?? null,
      tokensBefore: 'tokensBefore' in result ? (result.tokensBefore ?? null) : null,
      tokensAfter: 'tokensAfter' in result ? (result.tokensAfter ?? null) : null,
    },
    day => add(day, ['compactions'], e.trigger, 1),
  )
}

// A plugin above this one (the built-in security guard) sends session.compact past it, but not the
// PostCompact command hook in hooks.json: scripts/record-compact.sh leaves a line per compaction in
// <events>/pending/<session>.jsonl, counted here and cleared. (Trigger only: no token counts.)
async function drainCompactions($: EngineInterface) {
  const place = location
  if (!isEnabled || !place) return
  const path = `${place.dir}${place.sep}pending${place.sep}${sessionId}.jsonl`
  try {
    if (!(await $.fs.exists(path))) return
    const text = await $.fs.read(path)
    if (!text.trim()) return
    await $.fs.write(path, '')
    for (const row of text.split('\n')) {
      let parsed: { t?: unknown; trigger?: unknown; agent?: unknown }
      try {
        parsed = JSON.parse(row)
      } catch {
        continue
      }
      const t = typeof parsed.t === 'number' ? parsed.t : await $.clock.now()
      // session.compact reached this plugin and counted it already.
      if (compactRecordedAt !== null && Math.abs(t - compactRecordedAt) < SAME_COMPACTION_MS) continue
      const trigger = parsed.trigger === 'manual' || parsed.trigger === 'auto' ? parsed.trigger : 'unknown'
      const agent = typeof parsed.agent === 'string' ? parsed.agent : null
      countCompaction(agent)
      record({ t, kind: 'compact', trigger, agent, tokensBefore: null, tokensAfter: null, via: 'hook' }, day =>
        add(day, ['compactions'], trigger, 1),
      )
    }
  } catch (error) {
    fail($, 'reading the compaction notes', error)
  }
}

async function isCustomCommand($: EngineInterface, name: string): Promise<boolean> {
  try {
    const found = (await $.command.list()).find(command => command.name === name)
    // Built-ins are not skills, and spend-bar's own /spend-review is not one either.
    return found !== undefined && found.source !== 'builtin' && !(found.plugin === 'spend-bar')
  } catch {
    return false
  }
}

export function hookStats(on: On) {
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const at = await $.clock.now()
    const place = location
    const folder = place ? { dir: `${place.dir}${place.sep}output${place.sep}${dayOf(at)}`, sep: place.sep } : null
    const answer = await trimToolResult($, e.tool, e.tool_use_id ?? `call-${at}`, result, folder)
    if (!isEnabled) return answer
    const path = filePathOf(e)
    const pathHash = path === undefined ? undefined : hashPath(path)
    const isRead = e.tool === 'Read' && pathHash !== undefined
    const isRepeatRead = isRead && readPaths.has(pathHash)
    if (isRead) readPaths.add(pathHash)
    const isDenied = typeof result.deny === 'string'
    const skillName = e.tool === 'Skill' ? (e as { skill?: unknown }).skill : undefined
    if (typeof skillName === 'string' && !isDenied) await statsSkill($, skillName, 'tool')
    const bytes = isDenied ? 0 : sizeOf(result.result)
    const isError = result.isError === true
    const shell = shellCommandOf(e)
    const cmd = shell === undefined ? null : firstWord(shell)
    const err = cmd !== null && isError ? errorTextOf(result) : null
    const sentBytes = answer === result ? bytes : sizeOf(answer.result)
    const isTrimmed = sentBytes !== bytes
    const seenBytes = seenSizeOf(e.tool, answer)
    const agent = e.agentId ?? MAIN_AGENT
    // Only a read the model got counts toward the repeat kinds; a denied or failed one showed no lines.
    const repeat = isRead && !isDenied && !isError ? classifyRead(pathHash, agent, e) : null
    const changed = isDenied || isError ? undefined : changedPathOf(e)
    if (changed !== undefined) {
      const changedHash = hashPath(changed)
      changesByPath.set(changedHash, (changesByPath.get(changedHash) ?? 0) + 1)
    }
    record(
      {
        t: at,
        kind: 'tool',
        tool: e.tool,
        agent: e.agentId ?? null,
        bytes,
        ...(isTrimmed ? { sentBytes } : {}),
        seenBytes,
        isError,
        isDenied,
        path: pathHash ?? null,
        ...(repeat !== null ? { repeat } : {}),
        ...(cmd !== null ? { cmd } : {}),
        ...(err !== null ? { err } : {}),
      },
      day => {
        add(day, ['tools', e.tool], 'calls', 1)
        add(day, ['tools', e.tool], 'bytes', bytes)
        add(day, ['tools', e.tool], 'seenBytes', seenBytes)
        if (isError) add(day, ['tools', e.tool], 'errors', 1)
        if (isRepeatRead) add(day, [], 'repeatedReads', 1)
        if (repeat !== null) add(day, ['repeatedReadsByKind'], repeat, 1)
        if (isTrimmed) {
          add(day, ['trimmed'], 'calls', 1)
          add(day, ['trimmed'], 'bytesSaved', bytes - sentBytes)
        }
        if (cmd !== null) {
          add(day, ['commands', cmd], 'calls', 1)
          if (isError) add(day, ['commands', cmd], 'errors', 1)
        }
      },
    )

    return answer
  })

  on('agent.spawn', async ($, e, next) => {
    if (!isEnabled) return next(e)
    const t = await $.clock.now()
    const result = await next(e)
    const isStarted = result.deny === undefined
    record(
      {
        t,
        kind: 'agent',
        type: e.subagentType,
        model: isStarted ? result.model : null,
        requestedModel: e.model ?? null,
        agentId: isStarted ? (result.agentId ?? null) : null,
        isBackground: e.background,
        isFork: e.fork,
        ...(isStarted ? {} : { isDenied: true }),
      },
      day => add(day, ['agents'], e.subagentType, 1),
    )

    return result
  })

  on('skill.prompt', async ($, e, next) => {
    await statsSkill($, e.skill, 'prompt')

    return next(e)
  })

  // Sees the slash commands skill.prompt would where a plugin above this one (the built-in security
  // guard on Team and Enterprise seats) sends that event past it; the Skill tool call is seen above.
  on('command.run', async ($, e, next) => {
    if (isEnabled && (await isCustomCommand($, e.command))) await statsSkill($, e.command, 'command')

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (isEnabled) record({ t: await $.clock.now(), kind: 'end', reason: e.reason }, () => {})
    await flushStats($)

    return next(e)
  })
}
