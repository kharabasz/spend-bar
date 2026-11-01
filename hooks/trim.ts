import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

type Options = Parameters<Register>[1]

type Block = { type: string; text?: string }

export type OutputFolder = { dir: string; sep: string }

const DEFAULT_LIMIT = 10_000
const HEAD_SHARE = 0.4

let limit = DEFAULT_LIMIT

export function configureTrim(options: Options) {
  const value = Number(options.trimLimit ?? DEFAULT_LIMIT)
  limit = Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_LIMIT
}

export function isTrimmedTool(tool: string): boolean {
  return tool === 'Bash' || tool === 'PowerShell' || tool.endsWith('__browser_batch')
}

function isShellResult(value: unknown): value is { stdout: string; stderr: string } {
  if (typeof value !== 'object' || value === null) return false
  const shell = value as { stdout?: unknown; stderr?: unknown }
  return typeof shell.stdout === 'string' && typeof shell.stderr === 'string'
}

function blocksOf(value: unknown): Block[] | null {
  const content = Array.isArray(value) ? value : (value as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return null
  return content.every(block => typeof block === 'object' && block !== null && typeof block.type === 'string') ? content : null
}

function cut(text: string, budget: number, note: string): string {
  if (text.length <= budget) return text
  const head = Math.floor(budget * HEAD_SHARE)
  const tail = budget - head
  return `${text.slice(0, head)}\n\n[spend-bar trimmed ${text.length - budget} of ${text.length} characters here. ${note}]\n\n${text.slice(text.length - tail)}`
}

async function save($: EngineInterface, folder: OutputFolder | null, id: string, text: string): Promise<string | null> {
  if (!folder) return null
  const path = `${folder.dir}${folder.sep}${id.replace(/[^\w.-]/g, '_')}.txt`
  try {
    await $.fs.write(path, text)
    return path
  } catch {
    return null
  }
}

function noteFor(path: string | null): string {
  return path
    ? `Full output: ${path} (Read it with offset and limit, or grep it, instead of running the command again)`
    : 'To see the rest, run a narrower command (filter it, take its head or tail, or redirect it to a file and read parts)'
}

function trimShell(shell: { stdout: string; stderr: string }, note: string) {
  const stderrBudget = Math.min(shell.stderr.length, Math.floor(limit / 2))
  return { ...shell, stdout: cut(shell.stdout, limit - stderrBudget, note), stderr: cut(shell.stderr, stderrBudget, note) }
}

function trimBlocks(blocks: Block[], total: number, note: string): Block[] {
  return blocks.map(block => {
    if (typeof block.text !== 'string') return block
    const budget = Math.floor((limit * block.text.length) / total)
    return { ...block, text: cut(block.text, budget, note) }
  })
}

function textLength(blocks: Block[]): number {
  return blocks.reduce((sum, block) => sum + (typeof block.text === 'string' ? block.text.length : 0), 0)
}

function rebuilt(original: ToolCallResult, result: unknown): ToolCallResult {
  return {
    result,
    ...(original.context ? { context: original.context } : {}),
    ...(original.isError ? { isError: true } : {}),
  } as ToolCallResult
}

export async function trimToolResult(
  $: EngineInterface,
  tool: string,
  id: string,
  original: ToolCallResult,
  folder: OutputFolder | null,
): Promise<ToolCallResult> {
  if (limit === 0 || typeof original.deny === 'string' || !isTrimmedTool(tool)) return original
  const value = original.result

  if (typeof value === 'string') {
    if (value.length <= limit) return original
    return rebuilt(original, cut(value, limit, noteFor(await save($, folder, id, value))))
  }

  if (isShellResult(value)) {
    if (value.stdout.length + value.stderr.length <= limit) return original
    const full = value.stderr ? `${value.stdout}\n\n[stderr]\n${value.stderr}` : value.stdout
    return rebuilt(original, trimShell(value, noteFor(await save($, folder, id, full))))
  }

  const blocks = blocksOf(value)
  if (!blocks) return original
  const total = textLength(blocks)
  if (total <= limit) return original
  const full = blocks.flatMap(block => (typeof block.text === 'string' ? [block.text] : [])).join('\n\n')
  const trimmed = trimBlocks(blocks, total, noteFor(await save($, folder, id, full)))
  return rebuilt(original, Array.isArray(value) ? trimmed : { ...(value as object), content: trimmed })
}
