# Kalli

Conversational voice agent for L2 English coaching. See `.scratch/kalli-voice-agent/spec.md` for the product spec and `.scratch/kalli-voice-agent/issues/` for implementation tickets.

## Repo layout

- `apps/server` — Fastify backend (WebSocket session orchestration, deployed to Fly.io)
- `apps/web` — Vite + React frontend (deployed to Vercel)
- `packages/types` — shared TypeScript types between `apps/web` and `apps/server`

## Development

Requires Node 22+, pnpm, and a local Postgres server.

```sh
pnpm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
# then fill in CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY / VITE_CLERK_PUBLISHABLE_KEY
# from a Clerk app with Password disabled and Email verification link enabled,
# DEEPGRAM_API_KEY from https://console.deepgram.com,
# ANTHROPIC_API_KEY from https://console.anthropic.com,
# and ELEVENLABS_API_KEY from https://elevenlabs.io

createdb kalli_dev
createdb kalli_test
# set DATABASE_URL in apps/server/.env to point at kalli_dev, e.g.
#   DATABASE_URL=postgresql://<you>@localhost:5432/kalli_dev
# and apps/server/.env.test (gitignored) to point at kalli_test
#
# apps/server/.env.test also needs CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY so the real
# clerkPlugin can initialize in app.test.ts (routes/session.test.ts mocks Clerk away, but
# app.test.ts doesn't) — any syntactically valid test-mode key works, e.g.:
#   CLERK_PUBLISHABLE_KEY=pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk
#   CLERK_SECRET_KEY=sk_test_0000000000000000000000000000000000000000
pnpm --filter @kalli/server db:migrate

pnpm dev          # runs the server (http://localhost:3000) and web app (http://localhost:5173) together
```

Run server and web individually with `pnpm dev:server` / `pnpm dev:web`.

Schema changes: edit `apps/server/src/db/schema.ts`, then `pnpm --filter @kalli/server db:generate`
to write a migration and `db:migrate` to apply it (run against both `kalli_dev` and the test database).

## Checks

```sh
pnpm lint          # oxlint
pnpm format:check  # oxfmt --check
pnpm typecheck     # tsc --noEmit across all workspaces
pnpm test          # vitest across all workspaces
```

## Deploying

Not yet wired up — `apps/server/Dockerfile` and `apps/server/fly.toml` are in place for Fly.io, and `apps/web` deploys to Vercel with no extra config needed. Deploying requires `flyctl auth login` and a Vercel account/CLI login, done separately from this scaffold.
