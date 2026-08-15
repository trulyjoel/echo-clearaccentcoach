# 02 — Sign up / log in (passwordless magic link)

**What to build:** A user can create an account and log back in using a passwordless email magic link — no password is ever created or stored. On successful login they land on an authenticated home page.

**Blocked by:** 01 — Monorepo scaffold + deploy skeleton

**Status:** ready-for-human

- [x] User can enter their email and receive a magic link to sign up
- [x] Clicking the magic link creates an account (if new) and logs the user in
- [x] Returning user can request a new magic link to log back in with the same account
- [x] No password field exists anywhere in the sign-up/login flow
- [x] Authenticated routes are protected server-side; unauthenticated users are redirected to sign-in
- [x] Logged-in user sees a basic authenticated home page

## Comments

Implemented with Clerk: `apps/server` uses `@clerk/fastify` (`clerkPlugin` + `getAuth`), scoped to an
encapsulated `/api` sub-context so it doesn't run on `/health`. `apps/web` uses `@clerk/react` — `<SignIn/>`
(default hash-based routing, handles both sign-up and sign-in since there's no separate route) inside
`<Show when="signed-out">`, and the authenticated `Home` page inside `<Show when="signed-in">`. `Home` calls
`GET /api/me` with the Clerk session token to prove the server-side protection end-to-end.

The email-link-only (no password) behavior is enforced by Clerk dashboard configuration, not app code — see
the setup note in `apps/server/.env.example`. Status set to `ready-for-human` rather than `ready-for-agent`
because an agent can't create/configure the Clerk application (dashboard account + API keys) without
credentials; once a Clerk app exists with Password disabled and Email verification link enabled, and its
keys are filled into `apps/server/.env` / `apps/web/.env`, the flow is complete and testable end-to-end.
