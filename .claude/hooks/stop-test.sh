#!/usr/bin/env bash
# Stop hook: verify format, lint, types, and tests before agent stops.
# Exit 1 with additionalContext to force the agent to continue fixing.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

errors=""

# 1. Format check
fmt_out=$(npm run format:check 2>&1) || errors+="[format] $fmt_out"$'\n'

# 2. Lint check
lint_out=$(npm run lint 2>&1) || errors+="[lint] $lint_out"$'\n'

# 3. Type check
type_out=$(npm run typecheck 2>&1) || errors+="[typecheck] $type_out"$'\n'

# 4. Build + tests
test_out=$(npm test 2>&1) || errors+="[test] $test_out"$'\n'

if [ -n "$errors" ]; then
  # Truncate to avoid overly large context
  truncated="${errors:0:3000}"
  cat <<HOOK_JSON
{"hookSpecificOutput": {"additionalContext": "Checks failed — fix before stopping:\n${truncated//\"/\\\"}"}}
HOOK_JSON
  exit 1
fi

exit 0
