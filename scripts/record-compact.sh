#!/bin/sh
# PostCompact hook. Claude Code's built-in security guard sends the session.compact event past installed
# plugins, so the mod cannot see a compaction itself; a plugin's command hooks still run. This leaves one
# line per compaction in <events>/pending/<session>.jsonl, which the mod counts and clears at its next
# chance (session start, turn end, session end). Metadata only: no summary text is read.
input=$(cat)
field() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
sid=$(field session_id)
trigger=$(field trigger)
agent=$(field agent_id)
[ -n "$sid" ] || exit 0
case "$sid" in *[!A-Za-z0-9_.-]*) exit 0 ;; esac
case "$trigger" in manual|auto) ;; *) trigger=unknown ;; esac

if [ -n "$CLAUDE_PLUGIN_OPTION_STATSDIR" ]; then
  dir=$CLAUDE_PLUGIN_OPTION_STATSDIR
elif [ -n "$LOCALAPPDATA" ]; then
  dir="$LOCALAPPDATA/claude-toolkit/spend-bar/events"
elif [ -n "$XDG_STATE_HOME" ]; then
  dir="$XDG_STATE_HOME/claude-toolkit/spend-bar/events"
else
  case "$HOME" in
    /Users/*) dir="$HOME/Library/Application Support/claude-toolkit/spend-bar/events" ;;
    *) dir="$HOME/.local/state/claude-toolkit/spend-bar/events" ;;
  esac
fi

mkdir -p "$dir/pending" || exit 0
now=$(date +%s)000
printf '{"t":%s,"trigger":"%s","agent":%s}\n' "$now" "$trigger" "$([ -n "$agent" ] && printf '"%s"' "$agent" || printf null)" >> "$dir/pending/$sid.jsonl"
exit 0
