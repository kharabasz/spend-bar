#!/bin/sh
# One-time copy of the daily totals from the old plugin id (spend-bar@claude-toolkit) to the new
# one (spend-bar@spend-bar). Install the new plugin and start a session first, so its store file exists.
set -e
store="$HOME/.claude/plugins/store"
old=$(ls "$store"/spend-bar_claude-toolkit-*.json 2>/dev/null | head -1)
new=$(ls "$store"/spend-bar_spend-bar-*.json 2>/dev/null | head -1)
[ -n "$old" ] || { echo "no old store file in $store"; exit 1; }
[ -n "$new" ] || { echo "no new store file yet: start a session with spend-bar@spend-bar first"; exit 1; }
python3 - "$old" "$new" <<'PY'
import json, sys
old, new = (json.load(open(p)) for p in sys.argv[1:3])
added = 0
for key, value in old.items():
    if key.startswith('day:') and key not in new:
        new[key] = value
        added += 1
json.dump(new, open(sys.argv[2], 'w'), indent=2)
print(f'copied {added} daily totals into {sys.argv[2]}')
PY
