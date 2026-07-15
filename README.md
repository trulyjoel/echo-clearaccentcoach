# Callie

Conversational voice agent for L2 English coaching. See `.scratch/callie-voice-agent/spec.md` for the product spec and `.scratch/callie-voice-agent/issues/` for implementation tickets.

## Repo layout

- `apps/server` — Fastify backend (WebSocket session orchestration, deployed to Fly.io)
- `apps/web` — Vite + React frontend (deployed to Vercel)
- `packages/types` — shared TypeScript types between `apps/web` and `apps/server`

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm dev          # runs the server (http://localhost:3000) and web app (http://localhost:5173) together
```

Run server and web individually with `pnpm dev:server` / `pnpm dev:web`.

## Checks

```sh
pnpm lint          # oxlint
pnpm format:check  # oxfmt --check
pnpm typecheck     # tsc --noEmit across all workspaces
pnpm test          # vitest across all workspaces
```

## Deploying

Not yet wired up — `apps/server/Dockerfile` and `apps/server/fly.toml` are in place for Fly.io, and `apps/web` deploys to Vercel with no extra config needed. Deploying requires `flyctl auth login` and a Vercel account/CLI login, done separately from this scaffold.
