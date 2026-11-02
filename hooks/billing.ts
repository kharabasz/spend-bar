import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Monthly } from '../types'
import { dollars } from './pricing'

// Billing differs by account. A subscription reports 5-hour and weekly windows on every response.
// An Enterprise or Team seat on usage-based billing reports none: what it has is the month's
// extra-usage spend against a limit, which only the desktop app's get_usage tool reads. A
// gateway reports a `spend_limit` window. Every account has the session's own cost.

type Options = Parameters<Register>[1]

const monthly = atom({ plugin: 'spend-bar', key: 'monthly' } as const, null)
const sessionUsd = atom({ plugin: 'spend-bar', key: 'sessionUsd' } as const, null)

const MINUTE = 60_000
const MONTHLY_REFRESH_MS = 60 * MINUTE
const MONTHLY_STALE_MS = 10 * MINUTE
const MONTH_WARN_PERCENTS = [75, 90]

let sessionWarningUsd = 25
let isRefreshing = false
let hasMonthly = true
let warnedSessionSteps = 0
let warnedMonthPercent = 0
let stopRefreshing: (() => void) | undefined

function amountOf(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : NaN
}

// The get_usage reply's `plan.extraUsage`, or null where the account has none.
export function parseMonthly(text: string, at: number): Monthly | null {
  const plan = (JSON.parse(text) as { plan?: { status?: string; plan?: string; extraUsage?: Record<string, unknown> } }).plan
  const extra = plan?.extraUsage
  if (plan?.status !== 'ok' || !extra || extra.enabled !== true) return null
  const spent = amountOf(extra.spent)
  const limit = amountOf(extra.monthlyLimit)
  if (Number.isNaN(spent) || Number.isNaN(limit)) return null
  // The reply's own percentUsed rounds to whole points, so it reads 0% for $7 of $1,800.
  const percent = limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0
  return { spent, limit, percent, currency: String(extra.currency ?? 'USD'), plan: plan.plan ?? null, readAt: at }
}

export function configureBilling(options: Options) {
  const value = Number(options.sessionCostWarning ?? 25)
  sessionWarningUsd = Number.isFinite(value) && value >= 0 ? value : 25
}

export async function refreshMonthly($: EngineInterface, ifStale = false) {
  if (!hasMonthly || isRefreshing) return
  const at = await $.clock.now()
  const last = await read($, monthly)
  if (ifStale && last && at - last.readAt < MONTHLY_STALE_MS) return
  isRefreshing = true
  try {
    const reply = await $.mcp.call('ccd_session_mgmt', 'get_usage', {})
    const block = reply.content[0]
    const text = block && block.type === 'text' ? block.text : undefined
    if (reply.isError || text === undefined) return
    const value = parseMonthly(text, at)
    await update($, monthly, () => value)
    if (value) await warnMonth($, value)
  } catch {
    // No desktop app (a terminal session, -p, the SDK): the month is unknown, so stop asking.
    hasMonthly = false
  } finally {
    isRefreshing = false
  }
}

async function warnMonth($: EngineInterface, value: Monthly) {
  const crossed = MONTH_WARN_PERCENTS.filter(p => value.percent >= p && p > warnedMonthPercent).pop()
  if (crossed === undefined) return
  warnedMonthPercent = crossed
  $.ui.toast(`Extra usage is at ${value.percent}% of this month's limit: ${dollars(value.spent)} of ${dollars(value.limit)}.`)
}

export async function startBilling($: EngineInterface) {
  hasMonthly = true
  warnedSessionSteps = 0
  warnedMonthPercent = 0
  await refreshMonthly($)
  stopRefreshing?.()
  const timer = $.clock.every(MONTHLY_REFRESH_MS, () => {
    void refreshMonthly($)
  })
  stopRefreshing = () => timer.cancel()
}

// The session's billed total from the engine's ledger (/cost), and a toast at each multiple of the
// warning, so a session past $25 or $50 is a choice rather than a surprise.
export async function billingMeasured($: EngineInterface, usd: number | undefined) {
  if (usd === undefined) return
  await update($, sessionUsd, () => usd)
  if (sessionWarningUsd <= 0) return
  const steps = Math.floor(usd / sessionWarningUsd)
  if (steps <= warnedSessionSteps) return
  if (warnedSessionSteps === 0 && steps > 1) {
    // A resumed session starts past the warning: note where it is once, without a toast per step.
    warnedSessionSteps = steps
    return
  }
  warnedSessionSteps = steps
  $.ui.toast(
    `This session has cost ${dollars(usd)}. Each request resends the whole context: compact, or carry on in a new session from a short handoff note.`,
  )
}
