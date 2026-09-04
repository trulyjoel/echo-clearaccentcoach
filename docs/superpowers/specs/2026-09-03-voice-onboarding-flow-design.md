# Voice onboarding flow

## Problem

Onboarding today collects only L1 and consent, through a plain form (`Onboarding.tsx` +
`apps/server/src/routes/onboarding.ts`) — before any voice session exists. It doesn't ask what to
call the learner or what they want to work on, so `profiles` has no `name` or goals data, and every
session opens with a generic greeting and a one-size-fits-all coaching persona.

## Goals

- Collect three things before a learner's first real coaching turn: what they want to be called
  (`name`), their native language (`l1` — already exists, just moves where it's collected), and
  what they want to work on (`goals`, free text).
- Collect them by voice, through the same STT → LLM → TTS pipeline that runs regular coaching turns
  (`apps/server/src/routes/session.ts`), not a second form or a separate lightweight voice
  mechanism.
- Persist all three to `profiles` and use `name`/`goals` to personalize the reply system prompt and
  (for `name`) the returning-user greeting.
- Degrade gracefully when speech-to-text or extraction doesn't produce a confident answer, without
  looping indefinitely.

## Non-goals

- No generic reusable "flow" or state-machine abstraction. This is the first multi-step flow in the
  codebase; building one abstraction from a single use case would be speculative. The onboarding
  state machine described below is purpose-built for these three fields.
- No structured taxonomy for `goals`. It's stored as an LLM-summarized free-text string, not mapped
  onto the existing `ERROR_CATEGORIES` enum — that enum is pass-1's error taxonomy, a different
  concern, and forcing spoken goals into it would lose information for no current benefit.
- No editing an already-set profile via voice. Once `name`/`l1`/`goals` are all set, a session goes
  straight to coaching mode; changing them later (if ever needed) is a separate feature.
- No changes to how consent itself is gated or recorded — only the L1 field moves out of the
  consent form.

## Data model

`apps/server/src/db/schema.ts`: `profiles` gains two nullable columns:

```ts
export const profiles = pgTable("profiles", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  name: text("name"),
  l1: l1Enum("l1"),
  goals: text("goals"),
  consentGivenAt: timestamp("consent_given_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

New drizzle migration. Both columns nullable — existing rows already have `null` for both, and a
row is "profile complete" exactly when all three of `name`, `l1`, `goals` are non-null.

`packages/types/src/index.ts`:

```ts
export interface OnboardingRequest {
  consent: boolean;
}

export interface OnboardingStatusResponse {
  consentGivenAt: string | null;
  name: string | null;
  l1: L1 | null;
  goals: string | null;
}
```

`l1` is dropped from `OnboardingRequest` — it's no longer collected through the form.

## Consent form

`apps/server/src/routes/onboarding.ts`: `POST /api/onboarding` drops the `isL1` check, only
requires `consent === true`, and no longer writes `l1`. `GET /api/onboarding` returns the full
`OnboardingStatusResponse` shape above (reading `name`/`l1`/`goals` straight off the `profiles`
row).

`apps/web/src/Onboarding.tsx` drops the L1 `<select>` and its `"l1"` step — becomes a single-step
consent screen ("I agree to have my voice recorded..." + a continue button). Once consent is
given, the client proceeds to the normal session view exactly as it does today; it does not need to
know whether the upcoming session will be an onboarding session or a coaching session, since both
run through the same `/api/session` WebSocket and the same `Session.tsx` UI.

## Session gate and mode

`apps/server/src/routes/session.ts`, at connection time:

```ts
const [profile] = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId));
if (!profile?.consentGivenAt) {
  reject("Recording consent required");
  return;
}
const profileComplete = Boolean(profile.name && profile.l1 && profile.goals);
```

If `profileComplete` is false, the session starts in **onboarding mode**: `sendGreeting()` is
skipped in favor of the onboarding flow's own opening question, and `EndOfTurn` transcripts are
routed to a new `handleOnboardingTurn` instead of `handleTurn`. `l1` isn't read into the closed-over
`l1` variable up front (as it is today) since it may not exist yet — it's read once onboarding
finishes.

When onboarding completes (all three fields collected and persisted), the session flips in place:
the closed-over profile data is updated, a short transition line is spoken through the same
greeting-style pipeline `sendGreeting` uses, and every subsequent `EndOfTurn` for the rest of the
connection routes to the normal `handleTurn`. No reconnect, no new session row — one continuous
session from first word to last.

## Onboarding flow module

New `apps/server/src/onboarding/flow.ts` — a pure state machine, unit-testable in isolation from
`session.ts`'s WebSocket plumbing (the same separation `llm.ts` already has from `session.ts`).

```ts
type OnboardingField = "name" | "l1" | "goals";
type OnboardingPhase = "asking" | "confirming";

interface OnboardingState {
  field: OnboardingField;
  phase: OnboardingPhase;
  attempts: number; // extraction attempts spent on the current field, 0-2
  pendingValue: string | null; // candidate value awaiting spoken confirmation
  collected: { name: string | null; l1: L1 | null; goals: string | null };
}
```

Fields are asked in fixed order: `name` → `l1` → `goals`. Per field: **ask → extract → confirm
(spoken repeat-back) → next field**.

- Every user turn while onboarding calls a new `extractOnboardingAnswer` (in
  `apps/server/src/onboarding/extract.ts`, a `generateObject` call analogous to `analyzeErrors`)
  with the current field and transcript, returning `{ value: string | null; l1: L1 | null;
confident: boolean }`. `l1` is only populated (and only consulted) on the `l1` step, mapping free
  speech onto the existing `L1_VALUES` enum.
- **Low confidence** (`confident: false`) on `attempts === 0`: speak a rephrased version of the
  question ("Sorry, could you say that again?"), increment `attempts`, stay in `asking`. Low
  confidence again on `attempts === 1`: accept the best available value — the last extracted value
  if any, else a fixed per-field default (`goals` defaults to `"general accent reduction"`) — skip
  confirmation, and move to the next field. This bounds every field to at most 2 extraction rounds.
- **Confident** extraction moves to `confirming`: speak a repeat-back ("Got it, María — is that
  right?") and wait for the next turn. That turn is *also* run through
  `extractOnboardingAnswer`, in a confirm-mode that classifies it as yes/no (and, if the learner
  volunteered a correction inline, captures the corrected value). Confirmed "yes" commits
  `pendingValue` into `collected` and moves to the next field (`asking`, `attempts` reset to 0).
  "No" loops back to `asking` with `attempts` incremented — so a second "no" also fails through to
  the best-effort-accept path above, keeping the same hard cap on rounds per field regardless of
  whether the rejections came from confidence or from confirmation.
- After `goals` is committed, the flow returns `{ done: true, name, l1, goals }`. `session.ts`
  persists all three to `profiles` in one `UPDATE`, sends the new `profile_updated` message (below),
  speaks the transition line, and switches to coaching mode.

## Prompt personalization

`apps/server/src/llm.ts`:

- `buildReplySystemPrompt()` takes `{ name: string; goals: string }` and folds a short paragraph
  into the existing prompt (e.g. "The learner's name is {name}; they told you they want to work on:
  {goals}. Use their name naturally sometimes and keep this in mind without being rigid about it.").
  This is still turn-invariant *within* a session (name/goals don't change turn to turn), so the
  existing prompt-cache breakpoint behavior in `toCacheableMessages` is unaffected.
- `pickGreeting(name?: string)` — for returning users only (`profileComplete` true at connection
  time) — optionally interpolates the name into the existing fixed lines ("Hey María, good to have
  you back — what's on your mind today?"). Onboarding sessions never call `pickGreeting`; they use
  the flow's own opening question and transition line instead.

## Client changes

`apps/web/src/Session.tsx` needs no new UI: onboarding turns (questions, confirmations, the
transition line) render through the exact same transcript/reply-text/audio path as coaching turns
today. Its only change is handling one new message:

```ts
export type ServerToClientMessage =
  | ... // existing variants
  | { type: "profile_updated"; name: string; l1: L1; goals: string };
```

Sent once onboarding completes, so any client-side profile state updates without a refetch of
`GET /api/onboarding`.

## Testing

- `onboarding/flow.ts`: pure unit tests over the state machine — confident-first-try path,
  low-confidence-then-rephrase-then-accept path, confirm-then-reject-then-accept path, the `l1`
  step's mapping onto `L1_VALUES`, and the fixed `goals` default.
- `onboarding/extract.ts`: mocked at the LLM-call boundary (consistent with how `llm.ts`'s existing
  passes are tested), not against real model output.
- `session.ts`: extend existing session-route tests to cover the onboarding-mode branch — profile
  missing `name`/`l1`/`goals` routes turns to `handleOnboardingTurn`; completing onboarding flips
  subsequent turns to `handleTurn` within the same connection and persists the profile.
- `onboarding.ts` route: update existing tests for the shrunk consent-only request/response shape.
