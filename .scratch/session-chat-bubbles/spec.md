# Session chat bubble UI

Status: ready-for-agent

## Problem Statement

The Session screen — where a user actually talks with Callie — currently renders the live
transcript and Callie's replies as plain, unstyled text: the user's speech accumulates into one
growing blob for the whole session, and Callie's reply field is overwritten turn after turn so
only the latest one is ever visible. There is no styling anywhere in the frontend at all (no CSS
file, no styling library). The back-and-forth of an actual conversation is hard to follow, past
turns disappear, and the screen looks unfinished next to the coaching value it's delivering.

## Solution

The Session screen's conversation area becomes a scrolling thread of speech bubbles: Callie's
turns on the left, the user's turns on the right, in a violet/lavender palette, with every past
turn in the session still visible and scrollable rather than being overwritten. A live-updating
draft bubble shows the user's words as they're still being spoken, and a typing-indicator bubble
shows while Callie is composing a reply. A word or phrase flagged by the correction pipeline gets
a wavy underline directly on the flagged span inside the user's bubble, in addition to (not instead
of) the existing structured corrections panel — clicking the underlined span scrolls to and
highlights that error's entry in the panel. This is also the feature that introduces the project's
first styling foundation (Tailwind CSS), since nothing web-facing has been styled before now, and
this pass covers the whole Session screen (bubbles, corrections panel, buttons) so the new styling
doesn't look inconsistent against unstyled leftovers.

## User Stories

1. As a user, I want to see my own words and Callie's replies as a scrolling conversation thread, so that I can follow the back-and-forth naturally instead of reading two disconnected text blobs.
2. As a user, I want my own turns visually distinguished from Callie's (position + color), so that I can tell at a glance who said what without reading names.
3. As a user, I want every past turn in the session to stay visible as I keep talking, so that I can scroll back and re-read something Callie or I said earlier in the session.
4. As a user, I want to see my words appear as I'm still speaking (before the turn finalizes), so that the conversation feels responsive rather than frozen until I stop talking.
5. As a user, I want to see an indication that Callie is "thinking" between when I finish speaking and when her reply starts, so that I know the app is working rather than stuck.
6. As a user, I want a bubble that gets cut off by my own barge-in to stay visible in the thread (clearly marked as cut off), so that the conversation history still reads coherently rather than having gaps.
7. As a user, I want to see exactly which word(s) in my own turn were flagged as an error, directly on what I said, so that I don't have to cross-reference a separate panel to know what was wrong.
8. As a user, I want the fuller written correction (what I said, what's correct, why) still available in a dedicated panel, so that the in-bubble indicator doesn't replace the detail I already rely on.
9. As a user, I want clicking the flagged span in my bubble to take me straight to that correction's full detail, so that I can go from "something was flagged" to "here's why" in one action.
10. As a user, I want the whole Session screen (buttons, corrections panel, not just the conversation) to look like a finished product, so that the experience feels coherent rather than half-styled.
11. As a screen-reader user, I want the conversation thread to announce new turns as they arrive, so that I'm not left with no signal that the conversation moved on.
12. As a developer, I want the correction pipeline's turn-error messages to keep working without any change to the WebSocket protocol, so that this is a frontend-only change with no risk to the tested backend turn-processing logic.

## Implementation Decisions

**Styling foundation**
- Tailwind CSS (current stable major version), via its official Vite plugin — no separate
  PostCSS or Tailwind config file needed; configuration lives in one CSS entry file (an
  `@import` plus a theme block defining the violet/lavender accent tokens used by the bubbles),
  imported once at the app's entry point.
- This is the first styling introduced anywhere in the frontend; the whole Session screen is
  brought under it in this pass, not just the new bubble thread.

**Conversation state model**
- The Session screen's state currently tracks: all finalized user speech as one concatenated
  string, the current interim (not-yet-finalized) fragment, the most recent reply's caption only
  (older ones are overwritten), and a separately-maintained list of per-turn correction results.
- This is replaced with a single ordered list of turns, each either a user turn or an assistant
  (Callie) turn, carrying its own status:
  - A user turn is `live` while its speech is still arriving/interim, and `final` once its
    turn boundary is reached. It optionally carries the detected errors for that turn once they
    arrive, plus their timestamp.
  - An assistant turn starts `pending` the instant the user's turn ends (this is what shows the
    typing indicator immediately, before any reply text exists), moves to `streaming` as reply
    text arrives incrementally, becomes `final` once that reply's audio finishes playing, or
    becomes `interrupted` if barge-in or a pipeline error cuts it short (its text is kept as-is,
    however much streamed before the cut-off, rather than being discarded).
- Detected errors for a turn are attached to the most recently opened user turn, not correlated by
  any new identifier. This is safe under the backend's existing invariant that only one turn is
  ever mid-pipeline at a time and an interrupted turn's error/reply messages are never sent at all
  — so whichever user turn is currently open is unambiguously the only one still eligible to
  receive a delayed error result. No WebSocket protocol change is required for this correlation.
- The corrections panel's list is derived directly from this same turn list (turns that are user
  turns with attached errors) rather than being maintained as separate parallel state.

**Conversation thread rendering**
- Turns render as a vertically scrolling list of speech bubbles: Callie's turns left-aligned in a
  neutral/lavender-tinted style, the user's turns right-aligned in a filled violet style, both with
  rounded corners. The thread auto-scrolls to the newest turn as it updates.
- The typing-indicator state (assistant turn `pending`) renders as a small animated placeholder in
  Callie's bubble position, replaced by real content once her reply starts streaming.
- An interrupted assistant turn keeps whatever text streamed before the cut-off, with a small
  visual note that it was cut off, rather than disappearing or being styled as an error/alert.
- The conversation thread is exposed as a live region so a screen reader announces updates as
  turns arrive or update, closing a gap that exists today (the current plain-text rendering has no
  such announcement at all).

**Inline correction indicator**
- Within a user's bubble, any detected error whose original flagged text can be found verbatim as
  a substring of that turn's rendered text gets a wavy underline directly on that span (not a
  corner badge, not a separate link below the bubble). Multiple flagged spans in the same turn are
  matched left-to-right without overlapping each other.
- If a flagged error's original text can't be found verbatim in the turn's text (e.g. minor
  paraphrasing by the analysis pass), that error is simply not underlined inline — it remains
  fully visible in the corrections panel, so no correction is ever silently lost, only its inline
  highlight.
- Hovering an underlined span surfaces the correction and explanation directly; clicking it scrolls
  the corrections panel to that error's entry and briefly highlights it there.

## Testing Decisions

- Primary seam (existing, reused — not new): rendering the Session screen's root component and
  driving it through the same fake WebSocket/media/audio-source stand-ins already established by
  every prior ticket that touched this screen (turn-based replies, barge-in, corrections panel,
  clip/target playback, bookmarking). Assertions are made against rendered output (roles, text,
  visibility) exactly as today's tests do — nothing about this feature changes that seam or
  requires a new one.
- Additionally, the new conversation-thread and bubble rendering pieces get their own isolated
  component tests (rendered standalone with directly-supplied turn data, not through the full
  WebSocket flow), for more targeted coverage of layout, per-status rendering (live/pending/
  streaming/final/interrupted), and the inline correction-indicator matching logic — on top of, not
  instead of, the reused Session-level seam.
- Any newly extracted pure helper functions (state-transition logic per message type, the
  flagged-span-matching logic) get plain unit tests with no rendering involved at all.
- No backend test changes: the WebSocket protocol between frontend and backend is unchanged by
  this feature.

## Out of Scope

- Any change to the WebSocket message protocol or backend turn-processing logic — this is a
  frontend-only feature, made possible by an already-existing backend invariant (single in-flight
  turn, no error/reply messages ever sent for an interrupted turn).
- Virtualized or windowed rendering of the conversation thread for very long histories. Session
  duration is already hard-capped server-side, and typical sessions are short enough (on the order
  of ten turns) that an unbounded-history performance problem doesn't exist today. Explicitly
  deferred — revisit only if the session-length cap is ever relaxed enough for this to become a
  real concern.
- Any change to the separate error-history/progress view (a different screen with its own,
  already-established list rendering) or to any screen besides the live Session screen.
- Multiple selectable visual themes/accent colors — one fixed violet/lavender palette for MVP.

## Further Notes

- This spec was synthesized from a `/grill-with-docs`-style brainstorming session that also
  validated the visual direction (bubble layout, color palette, inline-indicator style) via visual
  mockups before this spec was written; those visual decisions are captured above as settled
  implementation decisions, not open questions.
- No `packages/types` or `apps/server` changes are anticipated; if implementation surfaces a case
  where the turn-correlation invariant above doesn't hold as described, that's a signal to stop and
  re-check the assumption against the current backend code before proceeding, not to route around
  it on the frontend.
