#!/bin/sh
# PostToolBatch hook for the long-turn brake. Claude Code's built-in security guard sends the
# classic.PostToolBatch event past installed plugins, so the mod cannot add the brake's note itself; a
# plugin's command hooks still run. When a main-thread turn reaches the brake, the mod writes this
# hook's whole JSON output to <events>/pending/<session>.brake.json. This prints it once, on the main
# thread's next tool batch, and empties the file. Subagent batches leave it for the main thread.
# Only the event's own fields count: tool_calls carries tool inputs and outputs, which can contain
# any text, so read fields from the part before it, leftmost match first.
input=$(cat)
head=${input%%\"tool_calls\"*}
field() { printf '%s' "$head" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"\([^"]*\)"$/\1/'; }
sid=$(field session_id)
[ -n "$sid" ] || exit 0
case "$sid" in *[!A-Za-z0-9_.-]*) exit 0 ;; esac
[ -z "$(field agent_id)" ] || exit 0

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

file="$dir/pending/$sid.brake.json"
[ -s "$file" ] || exit 0
cat "$file"
: > "$file"
exit 0
