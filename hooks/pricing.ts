import type { TurnUsage } from 'claude-code'

// List prices, US dollars per million tokens. A cache write costs input x1.25 at the 5-minute
// TTL and x2 at the hour. Update this table when prices change; an unknown model is unpriced.
type Price = { input: number; output: number; cacheRead: number }

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}
// Longest first, so claude-opus-5-5 wins over claude-opus-5.
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length)
const M = 1_000_000

function normalize(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[.*\]$/, '')
    .replace(/^(global|us|eu|apac)\./, '')
    .replace(/^anthropic\./, '')
}

export function priceOf(model: string): Price | null {
  const id = normalize(model)
  const key = KEYS.find(k => id.startsWith(k))
  return key ? (PRICES[key] ?? null) : null
}

// The estimated cost of one request, or null for a model the table does not price.
export function costOf(usage: TurnUsage, isHourCache: boolean): number | null {
  const price = priceOf(usage.model)
  if (!price) return null
  const write = isHourCache ? 2 : 1.25
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.cache_creation_input_tokens * price.input * write) /
    M
  )
}

export function dollars(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd)}`
  return `$${usd.toFixed(2)}`
}
