#!/bin/sh
# Points this clone at .githooks/. Run once per clone.
git config core.hooksPath .githooks
echo "hooks on. Pattern file: ${LEAK_PATTERN_FILE:-$HOME/.config/public-leak-check/pattern}"
