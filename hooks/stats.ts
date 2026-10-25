import { atom, read } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

const lastResponseAt = atom({ plugin: 'spend-bar', key: 'lastResponseAt' } as const, null)

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const RETENTION_DAYS = 30
const FILE_LIMIT_BYTES = 3 * 1024 * 1024
const DAY_KEY_PREFIX = 'day:'

type On = Parameters<Register>[0]
type Options = Parameters<Register>[1]

type Counts = { [key: string]: number | Counts }

type Line = { t: number; kind: string; [field: string]: unknown }

type Location = { dir: string; sep: string; isWindows: boolean }

type StepInput = { turnId: string; index: number; effort?: string | number; agentId?: string }

type StepResult = { usage: TurnUsage | null; toolUses: readonly { name: string }[] }

export type StepStart = { previous: number | null; startedAt: number }

let isEnabled = false
let ttlMs = 60 * MINUTE
let configuredDir = ''
let location: Location | null = null
let sessionId = 'unknown'
let lines: Line[] = []
let rollups: Record<string, Counts> = {}
let contextPercent: number | null = null
let flushing: Promise<void> = Promise.resolve()
let hasLoggedFailure = false
const readPaths = new Set<string>()

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

function filePathOf(input: object): string | undefined {
  const path = (input as { file_path?: unknown }).file_path
  return typeof path === 'string' ? path : undefined
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
    return { dir: `${localAppData}\\claude-building-blocks\\spend-bar\\events`, sep: '\\', isWindows: true }
  }
  const stateHome = await $.env.get('XDG_STATE_HOME')
  const home = await $.env.get('HOME')
  const base = stateHome || (home ? `${home}/.local/state` : undefined)
  return base ? { dir: `${base}/claude-building-blocks/spend-bar/events`, sep: '/', isWindows: false } : null
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

async function prune($: EngineInterface, now: number) {
  const cutoff = dayOf(now - RETENTION_DAYS * DAY)
  for (const key of await $.store.keys()) {
    if (key.startsWith(DAY_KEY_PREFIX) && key.slice(DAY_KEY_PREFIX.length) < cutoff) {
      await $.store.delete(key)
    }
  }
  const place = location
  if (!place || !(await $.fs.exists(place.dir))) return
  for (const entry of await $.fs.list(place.dir)) {
    if (entry.kind !== 'dir' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name) || entry.name >= cutoff) continue
    const folder = `${place.dir}${place.sep}${entry.name}`
    await $.process.run(place.isWindows ? ['cmd', '/c', 'rmdir', '/s', '/q', folder] : ['rm', '-rf', folder])
  }
}

export function configureStats(options: Options) {
  isEnabled = options.collectStats !== false
  ttlMs = options.cacheTtl === '5m' ? 5 * MINUTE : 60 * MINUTE
  configuredDir = typeof options.statsDir === 'string' ? options.statsDir.trim() : ''
}

export async function statsSessionStarted($: EngineInterface, surface: string | null) {
  if (!isEnabled) return
  try {
    location = await locate($)
    sessionId = await $.session.id()
    readPaths.clear()
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

export async function statsStepStarting($: EngineInterface, e: StepInput): Promise<StepStart> {
  if (!isEnabled) return { previous: null, startedAt: 0 }
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
      if (!isMain) add(day, [], 'subagentRequests', 1)
      if (e.effort !== undefined) add(day, ['effort'], String(e.effort), 1)
      if (isIdleRewrite) {
        add(day, ['idleCacheRewrites'], 'count', 1)
        add(day, ['idleCacheRewrites'], 'tokens', usage.cache_creation_input_tokens)
      }
      if (ctx !== null) {
        add(day, ['context'], 'samples', 1)
        if (ctx > 40) add(day, ['context'], 'over40', 1)
        if (ctx > 60) add(day, ['context'], 'over60', 1)
      }
    },
  )
}

export function hookStats(on: On) {
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!isEnabled) return result
    const at = await $.clock.now()
    const path = filePathOf(e)
    const pathHash = path === undefined ? undefined : hashPath(path)
    const isRead = e.tool === 'Read' && pathHash !== undefined
    const isRepeatRead = isRead && readPaths.has(pathHash)
    if (isRead) readPaths.add(pathHash)
    const isDenied = typeof result.deny === 'string'
    const bytes = isDenied ? 0 : sizeOf(result.result)
    const isError = result.isError === true
    record(
      { t: at, kind: 'tool', tool: e.tool, agent: e.agentId ?? null, bytes, isError, isDenied, path: pathHash ?? null },
      day => {
        add(day, ['tools', e.tool], 'calls', 1)
        add(day, ['tools', e.tool], 'bytes', bytes)
        if (isError) add(day, ['tools', e.tool], 'errors', 1)
        if (isRepeatRead) add(day, [], 'repeatedReads', 1)
      },
    )

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!isEnabled) return result
    record(
      {
        t: await $.clock.now(),
        kind: 'compact',
        trigger: e.trigger,
        agent: e.agentId ?? null,
        tokensBefore: 'tokensBefore' in result ? (result.tokensBefore ?? null) : null,
        tokensAfter: 'tokensAfter' in result ? (result.tokensAfter ?? null) : null,
      },
      day => add(day, ['compactions'], e.trigger, 1),
    )

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    if (isEnabled) {
      record(
        {
          t: await $.clock.now(),
          kind: 'agent',
          type: e.subagentType,
          model: e.model ?? e.parentModel,
          isBackground: e.background,
          isFork: e.fork,
        },
        day => add(day, ['agents'], e.subagentType, 1),
      )
    }

    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    if (isEnabled) {
      record({ t: await $.clock.now(), kind: 'skill', skill: e.skill }, day => add(day, ['skills'], e.skill, 1))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await flushStats($)

    return result
  })

  on('session.end', async ($, e, next) => {
    if (isEnabled) record({ t: await $.clock.now(), kind: 'end', reason: e.reason }, () => {})
    await flushStats($)

    return next(e)
  })
}
