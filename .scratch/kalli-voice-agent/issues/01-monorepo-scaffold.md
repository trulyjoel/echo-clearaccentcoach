# 01 — Monorepo scaffold + deploy skeleton

**What to build:** The foundational repo structure and deployed skeleton every other ticket builds on. Not user-facing — this is prefactoring so subsequent vertical slices have somewhere to land.

**Blocked by:** None — can start immediately.

**Status:** ready-for-human

- [x] pnpm monorepo initialized with `apps/web`, `apps/server`, `packages/types` workspaces
- [x] `apps/server`: Fastify app with a health-check route — deployed to Fly.io (see Comments)
- [x] `apps/web`: Vite + React app — deployed to Vercel (see Comments)
- [x] `packages/types`: empty shared types package, importable from both `apps/web` and `apps/server`
- [x] Lint/format/typecheck configured and passing across all three workspaces
- [x] A one-command local dev setup (server + web running together) documented in the repo README

## Comments

Deploy to Fly.io/Vercel deferred by user decision — `flyctl` was installed but not authenticated, and the `vercel` CLI wasn't installed; deploying means touching real cloud accounts, so that step wasn't taken unilaterally. `apps/server/Dockerfile` and `apps/server/fly.toml` are in place so deploy is a single `flyctl launch`/`flyctl deploy` once authenticated; `apps/web` needs no extra config for Vercel. Status set to `ready-for-human` to reflect the remaining manual step (auth + deploy), not `ready-for-agent`, since an agent can't complete it either without credentials.

Known limitation for later tickets: `packages/types` currently ships raw `.ts` source (no build step — `main`/`types` point at `src/index.ts`), which works fine for dev (Vite and `tsx` both transpile TS directly) but the Dockerfile's `node:22-slim` base can't load `.ts` natively without `--experimental-strip-types`. This is harmless today since no code imports `@kalli/types` yet, but whichever ticket first has `apps/server` import real shared types at runtime (expected around ticket 04 or 07) needs to either add a real build step (`tsc` → `dist/`) to `packages/types` or add the strip-types flag to the server's runtime `CMD`.

### Update — server deployed

`apps/server` is now deployed and live at https://kalli-server.fly.dev (`flyctl launch` + `flyctl deploy` run against a pre-existing Fly account). `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, and `WEB_ORIGIN` were set as Fly secrets from the local `.env`. `/health` returns `200 {"status":"ok"}`.

Fixed a real bug surfaced by the deploy: the Dockerfile's `deps` stage copied `pnpm-workspace.yaml`/`package.json`/`pnpm-lock.yaml` but not `tsconfig.base.json`, which `apps/server/tsconfig.json` extends. Without it, `tsc` silently fell back to defaults (`skipLibCheck: false`), which made the build fail trying to type-check unrelated `.d.ts` files deep in `@clerk/shared`'s transitive deps. Added `tsconfig.base.json` to that `COPY` line.

### Update — web deployed

`apps/web` is now deployed to Vercel at https://kalli-livid.vercel.app (project already linked as
`holmes-tech/kalli`, root directory `apps/web`). Set `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_API_URL`
(`https://kalli-server.fly.dev`) as production env vars, then `vercel --prod` from the repo root (Vercel's
configured root directory made running from inside `apps/web` fail — it resolved to `apps/web/apps/web`).

Also updated the `kalli-server` Fly app's `WEB_ORIGIN` secret from the `localhost:5173` placeholder to the
real Vercel URL, since `@fastify/cors` on the server locks `Access-Control-Allow-Origin` to that value.
Verified end-to-end with a headless browser: page loads, Clerk sign-in UI renders, and the `dev_browser`/
`environment`/`client` calls to Clerk all return 200 with the Vercel origin correctly reflected in
`access-control-allow-origin`. Didn't complete an actual sign-in (would create a real account).

Both `apps/web` and `apps/server` are now deployed. Ticket 01 has no remaining agent- or human-only work.
