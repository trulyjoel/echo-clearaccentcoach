# Voice onboarding flow

## Problem

Onboarding today collects only L1 and consent, through a plain form (`Onboarding.tsx` +
`apps/server/src/routes/onboarding.ts`) — before any voice session exists. It doesn't ask what to
call the learner or what they want to work on, so `profiles` has no `name` or goals data, and every
session opens with a generic greeting and a one-size-fits-all coaching persona.

## Goals

- Collect five things before a learner's first real coaching turn: what they want to be called
  (`name`), their native language (`l1` — already exists, just moves where it's collected), a
  self-rated proficiency level (`proficiency`), why they're improving their English (`context` —
  career, travel, immigration, socializing, etc., free text), and what they want to work on
  (`goals`, free text).
- Collect them by voice, through the same STT → LLM → TTS pipeline that runs regular coaching turns
  (`apps/server/src/routes/session.ts`), not a second form or a separate lightweight voice
  mechanism.
- Ask `context` right before `goals` and have the goals question reference it — a cold "what do you
  want to work on" is a hard open-ended question to answer; grounding it in the reason the learner
  just gave gives them an easier on-ramp than an abstract proficiency label would.
- Persist all five to `profiles` and use `name`/`goals`/`proficiency`/`context` to personalize the
  reply system prompt — `context` in particular lets the coach steer conversation topics toward
  what the learner actually needs English for, not just correction focus — and (for `name`) the
  returning-user greeting.
- Keep `l1` doing exactly what it already does today: biasing pass-1 error detection toward known
  interference patterns for that language (`buildAnalysisSystemPrompt(l1)` / `L1_INTERFERENCE_HINTS`
  in `llm.ts`, both unchanged). Only *where* `l1` is collected moves — once onboarding sets it, it
  flows into `analyzeErrors` exactly as it does for a returning user today.
- Degrade gracefully when speech-to-text or extraction doesn't produce a confident answer, without
  looping indefinitely.

## Non-goals

- No generic reusable "flow" or state-machine abstraction. This is the first multi-step flow in the
  codebase; building one abstraction from a single use case would be speculative. The onboarding
  state machine described below is purpose-built for these five fields.
- No structured taxonomy for `goals` or `context`. Both are stored as LLM-summarized free-text
  strings. `goals` isn't mapped onto the existing `ERROR_CATEGORIES` enum — that's pass-1's error
  taxonomy, a different concern, and forcing spoken goals into it would lose information for no
  current benefit. `context` isn't mapped onto a fixed picklist (career/travel/etc.) either, for the
  same reason — real answers ("job interviews next month" vs. "day-to-day work chat") carry nuance a
  coarse bucket would throw away, and the only consumer (the reply prompt) can use free text as-is.
- No editing an already-set profile via voice. Once all five fields are set, a session goes
  straight to coaching mode; changing them later (if ever needed) is a separate feature.
- `proficiency` and `context` don't feed pass 1 (`analyzeErrors`) — only the reply prompt. `l1` is
  the exception: it already biases pass 1 today and keeps doing so unchanged (see Goals). Scaling
  how many errors get flagged per level, or biasing error detection toward a domain (e.g. workplace
  vocabulary), is a plausible follow-up but isn't what was asked for here.
- No changes to how consent itself is gated or recorded — only the L1 field moves out of the
  consent form.

## Data model

`packages/types/src/index.ts` gains a proficiency scale, the same pattern as `SUPPORTED_L1S`:

```ts
export const PROFICIENCY_LEVELS = ["beginner", "intermediate", "advanced"] as const;
export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];
```

`apps/server/src/db/schema.ts`: `profiles` gains four nullable columns:

```ts
export const proficiencyEnum = pgEnum("proficiency", [...PROFICIENCY_LEVELS]);

export const profiles = pgTable("profiles", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  name: text("name"),
  l1: l1Enum("l1"),
  proficiency: proficiencyEnum("proficiency"),
  context: text("context"),
  goals: text("goals"),
  consentGivenAt: timestamp("consent_given_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

New drizzle migration. All four nullable — existing rows already have `null` for all of them, and
a row is "profile complete" exactly when `name`, `l1`, `proficiency`, `context`, and `goals` are all
non-null.

```ts
export interface OnboardingRequest {
  consent: boolean;
}

export interface OnboardingStatusResponse {
  consentGivenAt: string | null;
  name: string | null;
  l1: L1 | null;
  proficiency: ProficiencyLevel | null;
  context: string | null;
  goals: string | null;
}
```

`l1` is dropped from `OnboardingRequest` — it's no longer collected through the form.

## Consent form

`apps/server/src/routes/onboarding.ts`: `POST /api/onboarding` drops the `isL1` check, only
requires `consent === true`, and no longer writes `l1`. `GET /api/onboarding` returns the full
`OnboardingStatusResponse` shape above (reading `name`/`l1`/`proficiency`/`context`/`goals` straight
off the `profiles` row).

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
const profileComplete = Boolean(
  profile.name && profile.l1 && profile.proficiency && profile.context && profile.goals,
);
```

If `profileComplete` is false, the session starts in **onboarding mode**: `sendGreeting()` is
skipped in favor of the onboarding flow's own opening question, and `EndOfTurn` transcripts are
routed to a new `handleOnboardingTurn` instead of `handleTurn`. `l1` isn't read into the closed-over
`l1` variable up front (as it is today) since it may not exist yet — it's read once onboarding
finishes, at which point it's used for `analyzeErrors`/`buildAnalysisSystemPrompt` exactly as it
already is for a returning user whose profile was already complete at connection time.

When onboarding completes (all five fields collected and persisted), the session flips in place:
the closed-over profile data is updated, a short transition line is spoken through the same
greeting-style pipeline `sendGreeting` uses, and every subsequent `EndOfTurn` for the rest of the
connection routes to the normal `handleTurn`. No reconnect, no new session row — one continuous
session from first word to last.

## Onboarding flow module

New `apps/server/src/onboarding/flow.ts` — a pure state machine, unit-testable in isolation from
`session.ts`'s WebSocket plumbing (the same separation `llm.ts` already has from `session.ts`).

```ts
type OnboardingField = "name" | "l1" | "proficiency" | "context" | "goals";
type OnboardingPhase = "asking" | "confirming";

interface OnboardingState {
  field: OnboardingField;
  phase: OnboardingPhase;
  attempts: number; // extraction attempts spent on the current field, 0-2
  spelling: boolean; // name field only — set once the spell-out fallback has been invoked
  pendingValue: string | null; // candidate value awaiting spoken confirmation
  collected: {
    name: string | null;
    l1: L1 | null;
    proficiency: ProficiencyLevel | null;
    context: string | null;
    goals: string | null;
  };
}
```

Fields are asked in fixed order: `name` → `l1` → `proficiency` → `context` → `goals`. `context`
goes right before `goals` deliberately — the goals question's opening line references whatever
reason the learner just gave ("Since it's mostly for work, what would you like to focus on —
pronunciation, grammar, sounding more natural, whatever comes to mind?"), so a blank-page "what do
you want to work on" never has to stand alone. `proficiency` is still asked (and still shapes the
reply prompt's vocabulary/pacing), it just isn't the thing goals leans on for its opener anymore —
"why" is a more natural on-ramp into "what to work on" than an abstract level label. Per field:
**ask → extract → confirm (spoken repeat-back) → next field**.

- Every user turn while onboarding calls a new `extractOnboardingAnswer` (in
  `apps/server/src/onboarding/extract.ts`, a `generateObject` call analogous to `analyzeErrors`)
  with the current field and transcript, returning `{ value: string | null; l1: L1 | null;
proficiency: ProficiencyLevel | null; confident: boolean }`. `l1` is only populated (and only
  consulted) on the `l1` step, mapping free speech onto `L1_VALUES`; `proficiency` likewise only on
  the `proficiency` step, mapping onto `PROFICIENCY_LEVELS`. `context` and `goals` both just use
  `value` as free text.
- **Low confidence** (`confident: false`) on `attempts === 0`: for `l1`, `proficiency`, `context`,
  and `goals`, speak a rephrased version of the question ("Sorry, could you say that again?"). For
  `name` specifically, ask the learner to spell it instead ("Could you spell that for me?"), set
  `spelling: true`, and route the next turn's extraction through a separate spelling-reconstruction
  mode in `extractOnboardingAnswer` (letters transcribed either run-together, hyphenated, or
  NATO-style — "M as in Mike, A, R, I, A" — are reassembled into a name instead of run through the
  normal free-speech extraction). This is the one field-specific branch in an otherwise generic
  flow, justified by names being the proper-noun case STT reliably mangles, especially for
  L2-accented speech — the other four fields don't have the same failure mode since they map onto a
  fixed enum or tolerate paraphrase. Either way, `attempts` increments and the phase stays `asking`.
  Low confidence again on `attempts === 1` (spelled or not): accept the best available value — the
  last extracted value if any, else a fixed per-field default (`goals` defaults to `"general accent
  reduction"`, `context` to `"general everyday communication"`) — skip confirmation, and move to the
  next field. This bounds every field to at most 2 extraction rounds, same as before.
- **Confident** extraction moves to `confirming`: speak a repeat-back ("Got it, María — is that
  right?"). When `spelling` is true, the repeat-back spells it out letter by letter ("Got it —
  M, A, R, I, A. Is that right?") rather than just saying the name, since the whole point of that
  path was the spoken form being unreliable. Then wait for the next turn. That turn is *also* run through
  `extractOnboardingAnswer`, in a confirm-mode that classifies it as yes/no (and, if the learner
  volunteered a correction inline, captures the corrected value). Confirmed "yes" commits
  `pendingValue` into `collected` and moves to the next field (`asking`, `attempts` reset to 0).
  "No" loops back to `asking` with `attempts` incremented — so a second "no" also fails through to
  the best-effort-accept path above, keeping the same hard cap on rounds per field regardless of
  whether the rejections came from confidence or from confirmation.
- After `goals` is committed, the flow returns `{ done: true, name, l1, proficiency, context,
  goals }`. `session.ts` persists all five to `profiles` in one `UPDATE`, sends the new
  `profile_updated` message (below), speaks the transition line, and switches to coaching mode.

## Prompt personalization

`apps/server/src/llm.ts`:

- `buildReplySystemPrompt()` takes `{ name, goals, proficiency, context }` and folds a short
  paragraph into the existing prompt (e.g. "The learner's name is {name}, at a {proficiency} level;
  they're improving their English mainly for {context}, and told you they want to work on: {goals}.
  Use their name naturally sometimes, keep their goal in mind without being rigid about it, steer
  conversation topics toward what they actually need English for when it fits naturally, and match
  your vocabulary and pacing to their level — simpler and slower for beginner, natural conversational
  pace for advanced."). This is still turn-invariant *within* a session (none of these change turn to
  turn), so the existing prompt-cache breakpoint behavior in `toCacheableMessages` is unaffected.
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
  | {
      type: "profile_updated";
      name: string;
      l1: L1;
      proficiency: ProficiencyLevel;
      context: string;
      goals: string;
    };
```

Sent once onboarding completes, so any client-side profile state updates without a refetch of
`GET /api/onboarding`.

## Testing

- `onboarding/flow.ts`: pure unit tests over the state machine — confident-first-try path,
  low-confidence-then-rephrase-then-accept path, confirm-then-reject-then-accept path, the `l1`
  and `proficiency` steps' mapping onto their respective enums, the fixed `goals`/`context`
  defaults, the goals question referencing the just-collected `context` value, and the `name`
  field's spell-out fallback (low confidence → spelling prompt → letter-by-letter repeat-back →
  confirm).
- `onboarding/extract.ts`: mocked at the LLM-call boundary (consistent with how `llm.ts`'s existing
  passes are tested), not against real model output. Includes cases for the spelling-reconstruction
  mode — run-together letters, hyphenated, and NATO-style ("M as in Mike") transcripts.
- `session.ts`: extend existing session-route tests to cover the onboarding-mode branch — profile
  missing any of `name`/`l1`/`proficiency`/`context`/`goals` routes turns to `handleOnboardingTurn`;
  completing onboarding flips subsequent turns to `handleTurn` within the same connection and
  persists the profile.
- `onboarding.ts` route: update existing tests for the shrunk consent-only request/response shape.
