# CLAUDE.md

## Commands

- `npm test` — build + run all tests
- `npm run typecheck` — type check only (no emit)
- `npm run format` — auto-format with biome
- `npm run lint:fix` — auto-fix lint issues
- `npm run check` — full validation (format + lint + typecheck + test)

## Do NOT modify

- `biome.json` — fix your code, not the linter rules
- `tsconfig.json` — fix type errors, do not loosen strict settings
- `.claude/settings.json` — hook configuration is managed separately

## Architecture

- Source: `src/` (TypeScript, compiled to `dist/`)
- Tests: `test/*.test.cjs` (node:test runner, CommonJS)
- Config schema: `.agenv.schema.json`
- Docs: `docs/cli.md` (CLI reference), `docs/profiles.md` (config model)

## Conventions

- Use `createUserError()` from `src/errors.ts` for user-facing errors
- Use `isENOENT()` from `src/errors.ts` for file-not-found checks
- Profile names: lowercase, `^[a-z0-9][a-z0-9_-]*$`
- All JSON writes must include trailing newline (see `writeJson` in `src/state.ts`)
