#!/usr/bin/env bash
# PreToolUse hook: block edits to linter/compiler/hook config files.
# Exit 2 = block the tool call.
set -uo pipefail

for f in "$@"; do
  case "$(basename "$f")" in
    biome.json|tsconfig.json)
      cat <<HOOK_JSON
{"hookSpecificOutput": {"decision": "block", "reason": "Editing $f is not allowed. Fix your code to satisfy the existing rules instead."}}
HOOK_JSON
      exit 2
      ;;
  esac
done

exit 0
