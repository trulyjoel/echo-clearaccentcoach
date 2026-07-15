# 02 — Sign up / log in (passwordless magic link)

**What to build:** A user can create an account and log back in using a passwordless email magic link — no password is ever created or stored. On successful login they land on an authenticated home page.

**Blocked by:** 01 — Monorepo scaffold + deploy skeleton

**Status:** ready-for-agent

- [ ] User can enter their email and receive a magic link to sign up
- [ ] Clicking the magic link creates an account (if new) and logs the user in
- [ ] Returning user can request a new magic link to log back in with the same account
- [ ] No password field exists anywhere in the sign-up/login flow
- [ ] Authenticated routes are protected server-side; unauthenticated users are redirected to sign-in
- [ ] Logged-in user sees a basic authenticated home page
