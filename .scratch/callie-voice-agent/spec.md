# Callie: Conversational Voice Agent for L2 English Coaching

Status: ready-for-agent

## Problem Statement

L2 (second-language) English speakers who want to improve their spoken English have no good way to practice natural conversation while getting real-time feedback on their mistakes. Static exercises (flashcards, drills) don't build conversational fluency. Conversation-practice apps without correction let bad habits (word order, grammar, verb tense) go unaddressed. A human tutor who can converse *and* correct in real time is expensive and hard to access on demand. Learners need a coach that can hold an unscripted conversation, catch the mistakes that matter, and explain them, all without breaking the flow of talking.

## Solution

Callie is a browser-based conversational voice agent. The user talks to Callie through their microphone; she carries on a natural, turn-based conversation while detecting grammar and word-order errors in what the user says. Corrections are delivered two ways every turn: briefly and naturally woven into Callie's spoken reply, and as a fuller structured breakdown in an on-screen text panel. Because certain error patterns are characteristic of a learner's native language (L1), Callie asks for the user's L1 at onboarding and uses it to bias detection toward patterns common for that language family. Sessions are turn-based (Callie waits for the user to finish speaking before responding) but support barge-in (the user can interrupt Callie mid-reply). Error history persists per user across sessions so progress can be tracked over time. Pronunciation scoring (as opposed to grammar/word-order) is explicitly deferred — see Out of Scope.

## User Stories

1. As a new user, I want to create an account, so that my conversation history and progress persist across sessions.
2. As a new user, I want to log in on any device, so that I can practice from wherever I am.
3. As a new user, I want to select my native language (L1) during onboarding, so that Callie can watch for error patterns common to speakers of my language.
4. As a new user whose L1 isn't in the supported shortlist, I want to select "Other," so that I can still use the product with generic error detection.
5. As a new user, I want to be asked for explicit consent before any of my voice is recorded and stored, so that I understand and control how my voice data is used.
6. As a user, I want to start a conversation session with a single action, so that I can begin practicing without friction.
7. As a user, I want Callie to listen through my microphone and respond by voice, so that the interaction feels like a real conversation, not a chat app.
8. As a user, I want Callie to wait until I've finished speaking before she responds, so that she doesn't talk over me.
9. As a user, I want to be able to interrupt Callie while she's speaking, so that the conversation feels natural rather than rigid.
10. As a user, I want Callie to notice when I make a grammar or word-order mistake, so that I can learn from it in the moment.
11. As a user, I want Callie to briefly correct my mistake out loud as part of her natural reply, so that I get feedback without the conversation grinding to a halt.
12. As a user, I want to see a fuller written breakdown of each correction (what I said, what's correct, why) in a side panel, so that I can review it without interrupting the flow of talking.
13. As a user whose L1 is one of the supported languages, I want corrections to reflect patterns common for speakers of my language, so that feedback feels relevant rather than generic.
14. As a user, I want to hear a short clip of my own voice for a flagged error, so that I can hear exactly how I said it.
15. As a user, I want to hear a synthesized "target" version of what I said, so that I can compare my pronunciation/phrasing to a model version.
16. As a user, I want my session to end automatically after a maximum duration, so that I don't run up unexpected costs from a stuck or forgotten session.
17. As a user, I want to see my error history across past sessions, so that I can track which mistakes I make repeatedly and whether I'm improving.
18. As a user, I want my recorded error clips to eventually expire, so that my voice data isn't retained indefinitely without my ongoing awareness.
19. As a user, I want the option to bookmark a specific error clip, so that it's kept past the normal expiry window for my own reference.
20. As a user, I want the conversation to be freeform (not locked to a fixed lesson script), so that I can talk about whatever I want to practice.
21. As a user, I want Callie to keep the conversation moving with relevant follow-up if I stall, so that I get more speaking practice per session.
22. As a returning user, I want to resume practicing without re-entering my L1 or consent every time, so that returning sessions start quickly.
23. As a product owner, I want per-user, per-session usage (duration, turns, vendor API cost) recorded, so that future usage-based billing/limits can be built without backfilling data.
24. As a product owner, I want a hard cap on concurrent/daily sessions per user, so that a single user or bug can't generate runaway vendor costs.
25. As a developer, I want the correction pipeline split into a distinct error-analysis pass and a distinct reply-generation pass, so that each can be tuned and tested independently.
26. As a developer, I want the LLM provider abstracted behind a swappable interface, so that the model backing either pass can change without rewriting orchestration logic.
27. As a developer, I want the WebSocket message contract between frontend and backend to be typed and shared, so that both sides of the audio/session protocol stay in sync.
28. As a developer, I want target-comparison audio synthesized on demand rather than stored, so that storage costs don't double for audio that may never be replayed.

## Implementation Decisions

**Repo structure**
- pnpm monorepo: `apps/web` (frontend), `apps/server` (backend), `packages/types` (shared WebSocket message + error schema types).

**Frontend**
- Vite + React, deployed on Vercel.
- Captures mic audio, streams it to the backend over WebSocket, plays back streamed TTS audio, renders the live transcript and the correction text panel, supports sending a "barge-in" signal when the user starts speaking while Callie's audio is playing.

**Backend**
- Fastify + `@fastify/websocket`, deployed on Fly.io (chosen over serverless hosts because the WebSocket connections are long-lived).
- Owns the full session lifecycle: opens/closes the WebSocket session, streams user audio to Deepgram, receives end-of-turn transcripts, runs the two-pass LLM pipeline, streams the reply to ElevenLabs for TTS, streams the resulting audio back to the client, persists turns/errors/usage to Postgres.
- Enforces session limits (max session duration, daily session cap per user) server-side before accepting a WebSocket connection.

**Audio transport**
- Plain WebSocket carrying audio frames (not WebRTC) between browser and backend, since this is a direct client-to-own-server topology, not peer-to-peer or multi-party.
- Mic stays open for the duration of the session (including while Callie's TTS is playing) so the backend can detect barge-in.

**STT**
- Deepgram streaming API (Nova-tier monolingual model), used for both live transcription and end-of-turn (endpointing) detection that triggers the correction pipeline.

**TTS**
- ElevenLabs streaming API, using an existing preset voice for Callie (no custom voice design/cloning in this scope).

**Correction pipeline (two-pass, per user turn)**
- Pass 1 (analysis): given the turn's transcript, produce a structured error list — each error tagged with a category (word order, verb tense/aspect, subject-verb agreement, article usage, preposition choice), the original text, the corrected text, and a brief explanation. The prompt is seeded with the user's L1 to bias detection toward known interference patterns for that language family (hardcoded hint sets for the top 4-5 most common L1s; "Other"/unsupported L1s fall back to the generic category list with no L1-specific hints).
- Pass 2 (reply generation): given the transcript, the pass-1 error list, and recent conversation history, produce Callie's natural conversational reply, briefly acknowledging/correcting the most relevant error without derailing the conversation.
- Both passes run through a shared LLM-provider abstraction (Vercel AI SDK), configured for Claude Sonnet, so the underlying model can be swapped via configuration rather than a code change.
- Pronunciation is explicitly out of scope for the analysis pass in this spec — see Out of Scope.

**Correction delivery**
- Spoken: pass-2 reply audio, streamed to the client as normal conversational TTS.
- Written: the full pass-1 structured error list, sent to the client and rendered in a persistent side panel/transcript view, decoupled from the spoken reply so it doesn't need to be compressed to fit naturally into speech.

**Data model (conceptual entities, exact schema left to implementation)**
- User: auth identity (via Clerk/Auth.js), L1 (native language, from a fixed shortlist + "Other"), consent record (recording consent, timestamp).
- Session: belongs to a user, start/end time, duration, turn count, ended reason (user-ended, hit max duration, disconnected).
- Turn: belongs to a session, transcript, timestamp, reference to any errors detected in that turn.
- Error: belongs to a turn, category, original text, corrected text, explanation, reference to the stored audio clip (if any).
- AudioClip: the short user-voice segment around a flagged error, storage key (Cloudflare R2), expiry timestamp (default 90 days from creation), bookmarked flag (bookmarked clips are exempt from expiry).
- UsageRecord: per session, per-vendor cost/usage figures (Deepgram minutes, ElevenLabs characters, LLM tokens in/out for both passes) for future billing/limit features.

**Audio storage**
- Only the short segment around a flagged error is stored, not full-session audio — reduces storage volume to a small fraction of total session audio.
- Stored as Opus-compressed audio on Cloudflare R2 (chosen for zero egress fees, since replaying a stored clip is an egress event that would otherwise scale with user engagement).
- Default 90-day retention; user can bookmark a clip to exempt it from expiry.
- The "target" comparison audio is synthesized via ElevenLabs on demand when the user opens a specific error for review, and is not persisted — avoids doubling storage for audio that may never be replayed.
- Recording/storing user audio requires an explicit, specific consent step at onboarding/first session (separate from general ToS acceptance) before any audio is captured for storage.

**Auth & persistence**
- Clerk or Auth.js for authentication (not custom-built).
- Postgres (hosted on Neon, chosen for its permanent free tier with no idle-pause and pay-as-you-go scaling beyond it) accessed via Drizzle ORM.

**Cost/usage guardrails**
- Max session duration enforced server-side (recommended default 15 minutes; exact value confirmable at ticket time).
- Soft daily session-count cap per user, enforced server-side before a session can start.
- Per-session, per-vendor usage/cost recorded to the UsageRecord entity regardless of whether billing is active, so a future "pay for more practice time" feature doesn't require backfilling historical usage data.

**Target accent & scope**
- Single fixed target accent (General American) for MVP; no per-user accent selection.
- Conversation is freeform — no lesson plan/curriculum engine. The reply-generation pass may steer toward practice-rich topics if the user stalls, but there is no structured content-authoring system.

## Testing Decisions

- Primary seam: the WebSocket protocol boundary of `apps/server`. Tests open a WebSocket connection, send audio-in/control messages, and assert on outbound messages (transcripts, correction payloads, TTS audio references) and on persisted database state (Turn, Error, UsageRecord rows).
- Only the three external vendor boundaries are mocked/faked: the Deepgram client, the ElevenLabs client, and the LLM provider (Vercel AI SDK/Claude) client. Everything else — turn-detection/session logic, the two-pass pipeline orchestration, correction assembly, persistence, session-cap enforcement, usage metering — runs for real against a real ephemeral test Postgres database (not mocked), consistent with "mock boundaries, not logic."
- Frontend gets its own component/interaction-level tests (render + simulated user interaction) as a separate, lower-level seam, not covered by the backend WebSocket seam.
- No existing test suite prior art in this repo (greenfield project) — the WebSocket-seam pattern established here becomes the reference for subsequent backend tickets in this feature.

## Out of Scope

- Pronunciation/phoneme-level error scoring. Deferred to a future dedicated pronunciation-assessment backend built on a phoneme recognizer (HuPER); MVP detects grammar/word-order errors only.
- Multiple selectable target accents (e.g., British RP, Australian). MVP supports a single fixed target (General American).
- Structured lesson plans/curriculum content system. MVP is freeform conversation only.
- Native mobile app or telephony (phone call) client. MVP is browser-only.
- Custom voice design or voice cloning for Callie. MVP uses an existing ElevenLabs preset voice.
- L1 interference-pattern hints beyond the top 4-5 most common native languages. Other L1s fall back to generic (non-L1-biased) error detection.
- Active billing/paywall enforcement. Usage is metered and recorded from day one, but no payment collection or hard usage-based blocking is built in this scope.
- Fly.io-colocated Postgres. Neon was chosen for its free tier; revisit only if query latency is measured as a real bottleneck.

## Further Notes

- Rough cost modeling done during scoping: ~$0.24/session in vendor API costs (Deepgram + ElevenLabs + Claude) for a 10-minute, 10-turn session at current published rates (July 2026), plus roughly $0–15/month in fixed infra costs at MVP scale (Neon, Clerk, Vercel, Fly.io, R2 largely within free/starter tiers). These are planning estimates, not commitments — vendor pricing changes and should be re-verified before any real budget is set.
- This spec originated from a `/grill-me` session (no prior codebase context) rather than `/grill-with-docs`, so there is no existing `CONTEXT.md`/ADR trail to reconcile against — this spec is the first source of truth for the project's domain vocabulary and architecture decisions.
- Given the scope (auth, real-time audio pipeline, two-pass LLM correction, persistence, usage metering, frontend), this is a multi-session build — next step is `/to-tickets` to split this spec into tracer-bullet tickets with explicit blocking edges.

