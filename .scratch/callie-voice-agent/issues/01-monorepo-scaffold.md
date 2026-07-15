# 01 — Monorepo scaffold + deploy skeleton

**What to build:** The foundational repo structure and deployed skeleton every other ticket builds on. Not user-facing — this is prefactoring so subsequent vertical slices have somewhere to land.

**Blocked by:** None — can start immediately.

**Status:** ready-for-human

- [x] pnpm monorepo initialized with `apps/web`, `apps/server`, `packages/types` workspaces
- [x] `apps/server`: Fastify app with a health-check route — runs locally, not yet deployed (see Comments)
- [x] `apps/web`: Vite + React app — runs locally, not yet deployed (see Comments)
- [x] `packages/types`: empty shared types package, importable from both `apps/web` and `apps/server`
- [x] Lint/format/typecheck configured and passing across all three workspaces
- [x] A one-command local dev setup (server + web running together) documented in the repo README

## Comments

Deploy to Fly.io/Vercel deferred by user decision — `flyctl` was installed but not authenticated, and the `vercel` CLI wasn't installed; deploying means touching real cloud accounts, so that step wasn't taken unilaterally. `apps/server/Dockerfile` and `apps/server/fly.toml` are in place so deploy is a single `flyctl launch`/`flyctl deploy` once authenticated; `apps/web` needs no extra config for Vercel. Status set to `ready-for-human` to reflect the remaining manual step (auth + deploy), not `ready-for-agent`, since an agent can't complete it either without credentials.

Known limitation for later tickets: `packages/types` currently ships raw `.ts` source (no build step — `main`/`types` point at `src/index.ts`), which works fine for dev (Vite and `tsx` both transpile TS directly) but the Dockerfile's `node:22-slim` base can't load `.ts` natively without `--experimental-strip-types`. This is harmless today since no code imports `@callie/types` yet, but whichever ticket first has `apps/server` import real shared types at runtime (expected around ticket 04 or 07) needs to either add a real build step (`tsc` → `dist/`) to `packages/types` or add the strip-types flag to the server's runtime `CMD`.
