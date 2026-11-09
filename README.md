# spend-bar

A bar above the prompt showing:

- **Usage limits**, by how the account is billed:
  - on a subscription, the **session (5h) and weekly limits**, with time until each resets — amber above 70%, red above 90%
  - on an Enterprise or Team seat with usage-based billing, which has no 5h or weekly windows, the **month's extra-usage spend against its limit** (`month $412/$1800`), read from the desktop app's `get_usage` tool at session start, hourly and after a turn once the reading is 10 minutes old or missing (so a failed read at session start, while the app is still connecting, is retried) — amber from 75%, red from 90%, with a toast as it crosses each. The terminal has no such tool, so it shows no month figure. Personal plans (Free, Pro, Max) never show it, even with extra usage turned on
  - behind a gateway, its **spend limit** (`spend 40%`)
- **Session cost**, as `/cost` totals it — amber from $25, red from $50
- **Prompt cache status**, counted down from the last model response — amber in the last fifth of the TTL, red once expired
- **Context usage**, as a percentage of the window — amber above 20%, red above 30%
- A **↓** (Compact) button, hotkey `c` while the bar has focus, that runs `/compact` in the chat, as the session rail does. It reads **↓…** while any compaction runs (automatic ones too) and is dimmed and inactive below 30% context. It turns amber from 40% context, the point to compact by
- A **$** (Optimize spend) button, hotkey `o`, that scores this session and the past week from the usage stats below and asks Claude for suggestions. It looks at the share of tokens sent above 40% context, turns over 50 requests, shell calls per request, repeated reads, tool results over 20k characters, cache rewrites over 100k tokens, the estimated and billed cost and the subagents' share of it, the most used shell commands and the most common shell errors

Toasts warn about the patterns that cost the most:

- one main-thread turn reaches 40 model requests, since each request resends the whole context
- the session's cost reaches each multiple of the session cost warning ($25, $50, ...)
- a request after the prompt cache expired rewrites 100k tokens or more, with its estimated cost — after a break, a large session is cheaper to continue from a short handoff note in a new session
- the month's extra usage crosses 75% and 90% of its limit

Values under their thresholds are plain dim text; values past them become pills (rounded SVG pills on the desktop app, coloured labels in the terminal).

Options, in the config menu: **Prompt cache TTL** (`1h` default for subscriptions and Enterprise seats, `5m` for most API keys), **Compact warning** (40% by default), **Long turn warning** (40 requests by default), **Session cost warning** ($25 by default) and **Idle cache rewrite warning** (100,000 tokens by default); `0` turns any warning off.

## Enforce options

Warnings only tell you. These two options tell Claude, by adding a note to what the model reads (you do not see it), and are off (`0`) by default:

- **Context gate** (`contextGatePercent`): when a new turn starts with context at or above this share, Claude is told to say in one line, before new work, that you should `/compact` or hand off to a fresh session (a short handoff note is cheaper). Once per crossing; it re-arms when context falls back under the limit. Slash commands, prompts typed into a running turn and prompts sent by plugins get no note.
- **Long-turn brake** (`turnRequestBrake`): when the main-thread turn reaches this many model requests, Claude is told, with the next tool results, to stop, summarize what is done and what is left, and ask before continuing. Set it above **Long turn warning** so the toast comes first. A model can ignore the note; nothing is aborted.

## Weekly spend review

`/spend-review` reads the last 7 days of spend-bar's own event logs (and the 7 before, for comparison) and asks Claude to compare this week with the one before: estimated cost by day, the share of tokens sent at high context, long turns, repeated reads, cache rewrites, subagent share and the most common shell errors. It sends metadata only, never prompt text. The **$** button gives the shorter review of this session and the past week.

To run it every week, set a recurring local reminder (for example `/loop 7d /spend-review`, or a scheduled task that opens a session and runs `/spend-review`). A cloud routine cannot read the logs, which stay on your machine.

## Output trimming

Bash, PowerShell and `browser_batch` results over 10,000 characters are cut to their head and tail before the model reads them. The note in the middle names a file with the full output (under `events\output\<date>`, kept 7 days), so the model can read or grep it instead of running the command again. Option: **Trim tool output over** (`0` turns trimming off).

## Usage stats

The bar also records how each session uses tokens, for a later spend review. It records metadata only, never prompt text or file contents, and of command output only the start of shell error text:

- each model request: model, effort, main thread or subagent, input, output, cache read and cache write tokens, its estimated cost at list prices, the idle gap before it, and context %
- the session's billed total as it grows, so the spend review can set the estimate beside what was billed
- each tool call: tool name, result size (and the size sent after trimming), error or denied, and a hash of the file path (to spot repeated reads)
- each shell call: the first word of the command (`git`, `gh`, `dotnet`, `npm`, ...) and, when it fails, the first 100 characters of its error text
- compactions (trigger, size before and after), subagents spawned, skills run, and the tools and MCP servers loaded at session start

On Team and Enterprise seats, and wherever managed settings are present, Claude Code's built-in security guard (`cc-plugin-sec-default`) sends the `skill.prompt` and `session.compact` events past installed plugins, which is the "its skill.prompt hook was skipped" notice at launch. The stats still count those runs: skills from the Skill tool call and from slash commands, and compactions from a `PostCompact` command hook (`scripts/record-compact.sh`). What the guard hides is a compaction's size before and after, so those show as empty there.

Each session writes a JSONL file per day to `%LOCALAPPDATA%\claude-toolkit\spend-bar\events\<date>\<session>.jsonl` on Windows, `~/Library/Application Support/claude-toolkit/spend-bar/events/<date>/<session>.jsonl` on macOS, and under `$XDG_STATE_HOME` or `~/.local/state` elsewhere. Estimated costs come from the list prices in `hooks/pricing.ts`, with main-thread cache writes at the configured TTL's rate and subagents' at the 5-minute rate; update the table when prices change. Daily totals are kept in the plugin's store. Both are deleted after 30 days. Options: **Collect usage stats** (on by default) and **Stats folder**.

Requires Claude Code 2.1.308 or newer.

## Install

```bash
claude plugin install spend-bar --marketplace kharabasz/spend-bar
```

At the prompt of a terminal session: `/plugin install spend-bar --marketplace kharabasz/spend-bar`. In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `kharabasz/spend-bar`, then **Add plugin**.

### Moving from claude-toolkit

The plugin id changed from `spend-bar@claude-toolkit` to `spend-bar@spend-bar`. Install the new one and uninstall the old:

```bash
claude plugin install spend-bar --marketplace kharabasz/spend-bar
claude plugin uninstall spend-bar@claude-toolkit
```

The event logs do not depend on the plugin id, so history stays. The daily totals live in the plugin store under the old id and start again from zero; `scripts/migrate-store.sh` copies them across once.

## Developing

```bash
claude plugin validate .
claude plugin test .
```

MIT licensed.
