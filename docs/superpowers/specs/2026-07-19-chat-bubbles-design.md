# Conversation bubble UI for the Session view

## Problem

The Session view (`apps/web/src/Session.tsx`) currently renders the live transcript and Callie's
replies as plain, unstyled `<p>` text that accumulates into two growing blobs — one string for
everything the user has said across the whole session, one for Callie's most recent reply only
(older replies are overwritten). There is no styling anywhere in `apps/web` at all: no CSS file,
no styling library, nothing. This makes the back-and-forth conversation hard to follow and gives
the app no visual identity.

## Goals

- Restyle the Session view as a scrolling thread of alternating speech bubbles (user right-aligned,
  Callie left-aligned), full turn-by-turn history, not just the current turn.
- Establish Tailwind CSS as the project's styling foundation (nothing exists yet to build on).
- Extend today's inline correction experience: keep the existing corrections side panel, and add a
  wavy underline directly on the flagged words inside the user's bubble, linked to that panel entry.
- Cover the whole Session screen in this pass (bubbles, corrections panel, buttons) rather than
  bubbles in isolation, since introducing Tailwind with only half the screen styled would look
  inconsistent.

## Non-goals

- No backend or `packages/types` protocol changes. See "Turn-correlation invariant" below for why
  the inline-error-indicator feature doesn't need one.
- No virtualized/windowed list. Session duration is already hard-capped server-side (ticket 10,
  default ~15 minutes) and the spec's own cost model assumes ~10 turns per 10-minute session, so an
  unbounded-history performance problem doesn't exist today. Explicitly deferred: if the session
  length cap is ever relaxed enough for this to matter, revisit then.
- No changes to History.tsx (the past-sessions error-history view, ticket 14) — that's a separate
  screen with its own list rendering, out of scope here.

## Styling foundation

Tailwind CSS v4.3.3 (current stable) via the `@tailwindcss/vite` plugin. Tailwind v4's Vite
integration needs no `postcss.config.js` or `tailwind.config.js` — configuration lives in CSS
itself:

- `apps/web/vite.config.ts`: add `@tailwindcss/vite` to the `plugins` array.
- `apps/web/src/index.css` (new): `@import "tailwindcss";` plus an `@theme` block defining the
  violet/lavender accent tokens used by the bubbles (e.g. `--color-callie-bubble`,
  `--color-user-bubble`).
- `apps/web/src/main.tsx`: import `./index.css` once, above the `createRoot` call.

## Client-side data model

`Session.tsx`'s `SessionState` currently holds `finalized: string[]`, `interim: string`,
`corrections: TurnCorrections[]`, and `replyCaption: string` while `status === "active"`. These are
replaced by a single ordered array, which becomes the one source of truth for the bubble thread,
the typing indicator, and the corrections panel:

```ts
type Turn =
  | {
      role: "user";
      id: string;
      status: "live" | "final";
      text: string;
      errors?: PersistedError[];
      createdAt?: string;
    }
  | {
      role: "assistant";
      id: string;
      status: "pending" | "streaming" | "final" | "interrupted";
      text: string;
    };
```

`SessionState`'s `active` and `ended` variants both carry `turns: Turn[]` in place of the four
fields above. Each `Turn.id` is a client-generated `crypto.randomUUID()`, used only as a React key
and as the anchor for the click-to-scroll-to-panel-entry behavior described below — it never
crosses the wire.

### Message-to-state mapping

| Message | Effect on `turns` |
|---|---|
| `session_started` | `turns: []` |
| `transcript` (`isFinal: false`) | update the trailing `user`/`live` turn's text to the interim string (create one if none is open) |
| `transcript` (`isFinal: true`) | append the finalized fragment into the trailing `user`/`live` turn's text |
| `end_of_turn` | lock the trailing user turn to `status: "final"`; push a new `assistant`/`pending` turn (this is what shows the typing-dots bubble immediately, before any reply text exists) |
| `reply_text_delta` | first delta: flip the trailing assistant turn from `pending` to `streaming` and set its text; later deltas: append |
| `reply_text` | set the trailing assistant turn's text to the authoritative full string (status unchanged — finalization is `reply_audio_end`'s job, matching today's separation between text-complete and audio-complete) |
| `reply_audio_end` | trailing assistant turn → `status: "final"` |
| `reply_interrupted` | trailing assistant turn → `status: "interrupted"`, text kept as-is (covers both mid-analysis and mid-playback barge-in, and the `reason: "error"` pipeline-failure case) |
| `turn_errors` | attach `errors` and `createdAt` to the most recently created `user` turn |

Each `handleServerMessage` case is implemented as a call to a small pure helper function (e.g.
`applyEndOfTurn(turns): Turn[]`, `applyReplyTextDelta(turns, text): Turn[]`) rather than inline
array-splicing in the switch, keeping each function small and independently unit-testable without
a WebSocket or DOM.

### Turn-correlation invariant

Attaching `turn_errors` to "the most recently created user turn" is safe, not just convenient,
because of how `apps/server/src/routes/session.ts` already serializes turn processing:

- Only one turn is ever mid-pipeline at a time (`if (activeTurn) return` at the top of
  `handleTurn`).
- Every `send()` for `turn_errors`, `reply_text`, and `reply_audio_end` is reached only after an
  `aborted()` check, and barge-in sets that turn's `interrupted` flag synchronously the moment the
  user starts talking again (in the Deepgram message handler), regardless of how far the old
  turn's async pipeline has progressed.
- Consequently, an interrupted turn is guaranteed to never emit `turn_errors`. Whenever
  `turn_errors` does arrive, it can only belong to the one user turn currently progressing toward
  completion — which is always the most recently created one client-side.

This is what keeps the inline-error-indicator feature frontend-only: no `turnId` needs to be
threaded onto `end_of_turn` or the transcript messages.

## Components

- **`Session.tsx`** — unchanged responsibility (owns the WebSocket, media capture, and `turns`
  state); `handleServerMessage` delegates to the pure per-message helpers above.
- **`ConversationThread`** (new) — renders `turns` as the scrolling bubble list; auto-scrolls to
  the last turn on update via a ref + `scrollIntoView`. Wrapped in `role="log" aria-live="polite"`
  so screen readers get the same live announcements sighted users get from watching the thread
  scroll — today's plain `<p>` tags have no `aria-live` region at all, so this closes an existing
  accessibility gap as a direct part of rebuilding this exact rendering.
- **`Bubble`** (new) — one `Turn` → one bubble. Assistant: left-aligned, neutral/lavender-tinted
  background. User: right-aligned, filled violet background. Renders the three non-final assistant
  states: `pending` shows `TypingIndicator`; `streaming`/`final` show the accumulated text;
  `interrupted` shows the accumulated text (however much streamed before the cut-off) plus a small
  muted "— interrupted" trailing note, not a separate error/alert treatment.
- **`TypingIndicator`** (new) — small animated dots, shown only for `assistant`/`pending` turns.
- **Wavy-underline rendering** — a pure utility, `splitOnErrorSpans(text, errors): Array<{ text:
  string; error?: PersistedError }>`, locates each `error.original` as a literal substring of the
  turn's text, left to right, skipping ranges already claimed by an earlier match so overlapping
  spans can't double-wrap. If an error's `original` text isn't found verbatim (e.g. the analysis
  pass paraphrased slightly), that error is simply skipped for underlining — nothing is lost, since
  it's still listed in the corrections panel, it just isn't highlighted inline. `Bubble` renders
  the split as interleaved plain text and `<span>`s carrying the wavy-underline style and a `title`
  tooltip (corrected text + explanation). Clicking a span scrolls the corrections panel to that
  error's entry and briefly highlights it.
- **`CorrectionsPanel`** (existing, restyled) — simplified to derive its list directly from
  `turns.filter(t => t.role === "user" && t.errors?.length)` instead of maintaining its own
  parallel `corrections` array — removes state that's now redundant with `turns`.

## Testing

- New pure helpers (`applyEndOfTurn`, `applyReplyTextDelta`, `splitOnErrorSpans`, etc.) get direct
  unit tests — no DOM or WebSocket needed.
- `Session.test.tsx` is updated to assert on rendered behavior: bubble text/order/role, typing
  indicator visibility per assistant turn status, wavy-underline spans on flagged text, and
  corrections panel entries — consistent with "test behavior, not implementation," not on the
  shape of internal state.
- No backend test changes: the WebSocket protocol (`packages/types`, `apps/server`) is untouched.

## Visual decisions (validated via the visual companion)

- **Layout:** classic messaging style — Callie's bubbles left-aligned, user's bubbles right-aligned,
  rounded corners with a "tail" corner pointing toward the edge.
- **Palette:** violet/lavender accent (`#7c3aed`-family for the user's filled bubble, a pale lavender
  tint for Callie's neutral bubble), over a very light neutral page background.
- **Inline error indicator:** a wavy underline directly on the flagged word span within the user's
  bubble (not a corner badge or a below-bubble link).
