# Callie

Conversational voice agent for L2 English coaching. See `.scratch/callie-voice-agent/spec.md` for the product spec and `.scratch/callie-voice-agent/issues/` for implementation tickets.

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

createdb callie_dev
createdb callie_test
# set DATABASE_URL in apps/server/.env to point at callie_dev, e.g.
#   DATABASE_URL=postgresql://<you>@localhost:5432/callie_dev
# and apps/server/.env.test (gitignored) to point at callie_test
pnpm --filter @callie/server db:migrate

pnpm dev          # runs the server (http://localhost:3000) and web app (http://localhost:5173) together
```

Run server and web individually with `pnpm dev:server` / `pnpm dev:web`.

Schema changes: edit `apps/server/src/db/schema.ts`, then `pnpm --filter @callie/server db:generate`
to write a migration and `db:migrate` to apply it (run against both `callie_dev` and the test database).

## Checks

```sh
pnpm lint          # oxlint
pnpm format:check  # oxfmt --check
pnpm typecheck     # tsc --noEmit across all workspaces
pnpm test          # vitest across all workspaces
```

## Deploying

Not yet wired up — `apps/server/Dockerfile` and `apps/server/fly.toml` are in place for Fly.io, and `apps/web` deploys to Vercel with no extra config needed. Deploying requires `flyctl auth login` and a Vercel account/CLI login, done separately from this scaffold.
