# 04 — Voice session plumbing (mic → live transcript)

**What to build:** A user can start a session; their mic audio streams to the backend over WebSocket, the backend streams it to Deepgram, and the resulting live transcript appears in the UI. No reply and no correction yet — this proves the raw audio pipeline works end to end.

**Blocked by:** 03 — Onboarding: native language + recording consent

**Status:** ready-for-human

- [x] User can start a session from the authenticated home page, which opens a WebSocket connection to the backend
- [x] Browser mic audio streams to the backend over the WebSocket connection in real time
- [x] Backend streams received audio to Deepgram and receives transcript results back
- [x] Live transcript text is sent to the client over the WebSocket and rendered in the UI as the user speaks
- [x] End-of-turn (endpointing) is detected and signaled, even though nothing consumes it yet
- [x] A Session record is created when the session starts and closed when it ends
- [x] Session cannot start for a user without recorded consent (enforced server-side, per ticket 03)

## Comments

Built the full plumbing: `apps/server/src/routes/session.ts` registers `GET /api/session` as a
`@fastify/websocket` route. A `preValidation` hook (`requireConsentedUser`) checks auth + the
`profiles` consent record before the WebSocket upgrade completes, so an unconsented/unauthenticated
client gets a normal HTTP 401/403 and the upgrade never happens — no session row or Deepgram
connection is created for a rejected request. Browsers can't set custom headers on a WS handshake,
so the client passes its Clerk token as a `?token=` query param, which the server bridges into the
`Authorization` header before calling `getAuth`.

Once accepted, the handler creates a `sessions` row (new table, `apps/server/src/db/schema.ts`),
sends `session_started`, then opens a Deepgram live connection (`apps/server/src/deepgram.ts`,
`@deepgram/sdk` v5 `listen.v1.connect`, nova-3, English). Binary WS frames from the client are
forwarded to Deepgram as-is (browser sends `MediaRecorder` `audio/webm;codecs=opus` chunks — Deepgram
auto-detects the container). Deepgram `Results` messages are relayed to the client as `transcript`
messages; a `speech_final` result also emits `end_of_turn` (nothing consumes it yet, per spec). The
session ends (row closed with `endedAt`/`endReason`, Deepgram connection closed, socket closed) on
client-sent `{type:"end_session"}` (`user_ended`), socket disconnect (`disconnected`), or a failed/
errored Deepgram connection (`error`).

Message contract (`ServerToClientMessage`/`ClientToServerMessage`/`SessionEndReason`) lives in
`@callie/types` per the spec's "typed and shared WS contract" requirement, ready for ticket 05 to
extend.

Frontend: new `apps/web/src/Session.tsx`, rendered from `Home.tsx`. Handles mic capture
(`getUserMedia` + `MediaRecorder`), the WS lifecycle, and renders the live transcript
(interim + finalized). Vite's dev proxy (`vite.config.ts`) now forwards `/api` WS upgrades too
(`ws: true`).

Testing: `apps/server/src/routes/session.test.ts` covers the WS protocol boundary per the spec's
testing decision — real ephemeral Postgres, only the Deepgram client mocked (`vi.mock("../deepgram.js")`
with a fake connection). Uses `@fastify/websocket`'s `injectWS` test helper rather than a real
listening server. `apps/web/src/Session.test.tsx` covers the component/interaction seam with fake
`MediaRecorder`/`WebSocket` globals. Also disabled Vitest's cross-file parallelism in
`apps/server/vitest.config.ts` — `session.test.ts` is now a second file writing to the `profiles`
table, and running it concurrently with `onboarding.test.ts` against the same shared real test
database caused the two files' unscoped `afterEach` cleanups to stomp on each other's rows.

Status set to `ready-for-human` rather than `ready-for-agent`: `DEEPGRAM_API_KEY` needs to be
provisioned (see `apps/server/.env.example`) and the flow manually verified against the real
Deepgram API in a browser (mic permission prompt, live transcript rendering) before this ships —
an agent can't do either without credentials or a browser.
