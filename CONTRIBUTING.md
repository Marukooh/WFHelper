# Contributing to WFHelper

Thanks for your interest. WFHelper is a Windows-first Electron + Svelte 5 desktop
app; the backend is a Cloudflare Worker under `backend/worker`.

## Getting started

Requires Node 22+ and pnpm 11 (via corepack).

```
corepack enable
pnpm install --frozen-lockfile
pnpm run dev          # Electron + Vite dev loop
```

## Before you open a PR

Run the core validation suite before opening a pull request:

```
pnpm run format:check    # prettier
pnpm run typecheck       # tsc (renderer + main + tests)
pnpm run check           # svelte-check; tsc does not look inside .svelte files
pnpm run lint            # eslint (renderer + main + worker)
pnpm run audit:deadcode  # knip + dead production exports
pnpm test                # vitest
pnpm run build           # production build
```

The pre-push hook also verifies the ONNX models, typechecks and tests the Worker,
and audits production dependencies. On Windows it runs the Electron DBWIN harness
and Playwright suite as well. CI covers the same areas across its Linux and Windows
jobs; dependency auditing is skipped on pull requests and runs on branch pushes.

`pnpm run format` auto-fixes formatting. Please do not bypass the pre-push checks
with `--no-verify`.

## Conventions

- Commit messages: one line, `[tag] - lowercase short phrase`, max 72 characters,
  no body (e.g. `[fix] - relic modal blur`). Only the phrase's **first** character
  must be lowercase; proper nouns keep their case, so `[fix] - fix Warframe crash`
  is fine. Valid tags: `build`, `chore`, `ci`, `cleanup`, `deps`, `docs`, `feat`,
  `fix`, `lint`, `perf`, `refactor`, `release`, `security`, `style`, `test`,
  `tooling`, `types`, `ui`, `worker`. The `commit-msg` hook and the `commit-style`
  CI job enforce this.
- Keep `services/` as CommonJS unless a migration is already in progress.
- Renderer imports use relative paths with a `.js` suffix.
- New Svelte components use runes (`$state`, `$derived`, `$props`). A component
  must use one idiom. Any rune enables runes mode, where `$:` is a compile error.
  Existing `$:` components are fine; migrate one only during a substantial rewrite.
- IPC contract changes touch `src/types/ipc.ts`, `preload.ts`, `src/lib/ipc.ts`,
  and the handler together; every handler uses the sender guards in
  `ipc/ipcSecurity.ts`.
- For Worker changes, read `backend/worker/ARCHITECTURE.md` before editing
  `backend/worker`.
- koffi/Win32: never `koffi.view()` in code that can run under Electron - the
  memory cage makes it a fatal napi error (instant silent crash); decode a copy
  instead. Win32 `BOOL` params/returns are `int32`, never `"bool"` (1-byte bool
  leaves garbage in BOOL's upper bytes). Verify koffi changes under Electron
  (`pnpm run test:dbwin`); plain node does not reproduce cage crashes.

## Scope notes

- The app is Windows-primary: reward OCR and screen capture are Windows-only.
- No telemetry or crash reporting is bundled. Please don't add any.
