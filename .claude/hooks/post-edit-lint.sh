#!/usr/bin/env bash
# PostToolUse hook: auto-format and lint edited files.
# Called with file paths as arguments after Write/Edit/NotebookEdit.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

files=()
for f in "$@"; do
  case "$f" in
    *.ts|*.js|*.json) [ -f "$f" ] && files+=("$f") ;;
  esac
done

[ ${#files[@]} -eq 0 ] && exit 0

# Auto-fix formatting and lint issues
npx --no-install biome format --write "${files[@]}" 2>/dev/null || true
npx --no-install biome lint --write "${files[@]}" 2>/dev/null || true

# Check for remaining violations
errors=""
format_out=$(npx --no-install biome format "${files[@]}" 2>&1) || errors+="$format_out"$'\n'
lint_out=$(npx --no-install biome lint "${files[@]}" 2>&1) || errors+="$lint_out"$'\n'

if [ -n "$errors" ]; then
  # Feed remaining violations back to the agent
  cat <<HOOK_JSON
{"hookSpecificOutput": {"additionalContext": "Biome violations remain after auto-fix:\n${errors//\"/\\\"}"}}
HOOK_JSON
fi

exit 0
