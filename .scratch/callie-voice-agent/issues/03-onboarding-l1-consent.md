# 03 — Onboarding: native language + recording consent

**What to build:** After a user's first login, they select their native language (L1) and give explicit consent to voice recording/storage before any session can start. Both are persisted on their profile and not asked again on return visits.

**Blocked by:** 02 — Sign up / log in

**Status:** ready-for-human

- [x] First-login user is prompted to select their L1 from a fixed shortlist (the top 4-5 supported languages) plus an "Other" option
- [x] First-login user is shown an explicit, specific consent step for voice recording/storage (distinct from general ToS), and must accept before proceeding
- [x] L1 selection and consent acceptance (with timestamp) are persisted on the user's profile
- [x] Returning user is not re-prompted for L1 or consent on subsequent logins
- [x] No session/recording can start for a user who has not completed consent

## Comments

Implemented via a two-step `Onboarding` component (L1 radio select, then an explicit consent
checkbox/screen separate from ToS) gating `apps/web`'s authenticated route: `AuthenticatedApp` fetches
`GET /api/onboarding` on sign-in and renders `Onboarding` instead of `Home` until both `l1` and
`consentGivenAt` are on record, so returning users skip straight to `Home`. `POST /api/onboarding`
requires an explicit `consent: true` in the body (not just a valid `l1`) before persisting, so the API
contract itself proves consent was given rather than inferring it from call success.

This is the first ticket needing persistence, so it also adds the Postgres/Drizzle layer the spec calls
for: `apps/server/src/db/schema.ts` (a `profiles` table), `drizzle.config.ts`, and a migration. Tests run
against a real local Postgres (`callie_test`), per the spec's testing decision to not mock the DB.

There's no session/recording concept in the codebase yet (that's ticket 04), so the last checkbox is
satisfied by making `l1`/`consentGivenAt` queryable — ticket 04's own acceptance criteria explicitly owns
wiring the actual server-side gate ("enforced server-side, per ticket 03").

Status set to `ready-for-human` rather than `ready-for-agent`: this was built and tested against a local
Postgres instance (`brew services start postgresql@18`; `callie_dev`/`callie_test` databases) since Neon
wasn't provisioned — a human needs to provision the production Neon database, set `DATABASE_URL` as a Fly
secret, and run `pnpm --filter @callie/server db:migrate` against it before this is live in production.
The Docker image build (and thus the `--experimental-strip-types` runtime fix for `apps/server` now
importing runtime values from `@callie/types`) is also unverified end-to-end — the local Docker daemon
wasn't running in this environment, so only the underlying Node module-resolution mechanism was checked
directly, not a full `docker build`.

### Update — deployed

Verified the full Docker build + run locally (`docker build`/`docker run`): image builds clean, `--experimental-strip-types` correctly loads `@callie/types`' raw `.ts` source at runtime, `/health` returns 200.

Neon was provisioned and the migration applied (`pnpm --filter @callie/server db:migrate` against Neon's
direct connection string); `DATABASE_URL` (pooled connection string) set as a Fly secret on `callie-server`;
`callie-server` redeployed (`fly deploy . -c apps/server/fly.toml --dockerfile apps/server/Dockerfile` from
the repo root, since the Dockerfile's `COPY` paths need repo-root build context) and `apps/web` redeployed
to Vercel (`vercel deploy --prod` from the repo root). Verified end-to-end in production: `/health` returns
200, `/api/onboarding` returns 401 unauthenticated, and — via `fly ssh console` querying the DB directly
through the app's own `postgres` driver — the `profiles` table exists on Neon with the expected columns
(`clerk_user_id`, `l1`, `consent_given_at`, `created_at`).

Ticket 03 has no remaining agent- or human-only work.
