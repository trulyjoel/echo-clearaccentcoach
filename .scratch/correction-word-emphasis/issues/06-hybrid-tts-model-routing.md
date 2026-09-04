# 06 — Route the emphasized sentence to Inworld's full model, everything else to flash

**What to build:** Kalli's TTS defaults to Inworld's cheap/fast `inworld-tts-2-flash` tier for
ordinary sentences, since a live listening comparison found capitalization-based emphasis (ticket
02) reads clearly on the full `inworld-tts-2` model but not on flash. Rather than moving the whole
session to the pricier tier, only the one sentence per reply (if any) carrying the emphasized word
should route to the full model — everything else stays on flash.

**Blocked by:** 02 — Inline emphasis marker resolution, 05 — Wire word emphasis into the live
reply/TTS pipeline (this ticket routes the sentence 05's pipeline already segments per-sentence)

**Status:** ready-for-human

- [x] `getTTSProvider` accepts an optional `{ highQuality?: boolean }` — only the Inworld branch
      reacts to it (routes to `inworld-tts-2` instead of the default/env-configured flash tier);
      every other provider (ElevenLabs, Kokoro, Chatterbox) ignores it, and the shared
      `TTSProvider.synthesize(text)` interface itself is unchanged.
- [x] Only the sentence containing the resolved emphasis marker is requested against the full
      model; every other sentence in the same reply still uses flash.
- [x] TTS billing (`recordUsage`'s `ttsModel`) reflects whichever model actually ran per sentence,
      with no separate bookkeeping needed — the existing per-sentence `recordUsage` call already
      reports the model each `synthesize()` call returns.
- [x] A reply with no emphasis marker never invokes the full model.

## Comments

New scope, not in the original spec — surfaced during design discussion once the emphasis
mechanism (capitalization) turned out to need Inworld's full model rather than flash to read
clearly, which raised the cost/latency question of whether to move the whole session to the full
tier or route per-sentence. Chose per-sentence: ticket 05's pipeline already synthesizes one TTS
call per sentence (ticket 17), so this is a routing decision on an existing call, not new
architecture.

Implemented 2026-09-03: `EMPHASIS_INWORLD_MODEL` constant + `InworldTTSProvider` constructor now
takes an optional `modelOverride`; `getTTSProvider({ highQuality })`
(`apps/server/src/tts.ts`) constructs the provider with that override when true.
`synthesizeInworld` gained a `modelOverride` parameter (preferred over `INWORLD_MODEL` env when
given) — replaces the informal env-mutation pattern used in the exploratory comparison scripts
(`inworldEmphasis.ts`, `inworldModelSwitch.ts`) with a real parameter.

Live-verified by ear in this session, not just unit-tested: `inworldModelSwitch.ts` generated a
six-sentence dialogue three ways (all-flash, all-full, alternating every sentence) via the real
Inworld API, confirming the model switch itself doesn't sound jarring even under repeated
mid-conversation switching — user's verdict: "alternating sounded fine." This is the specific
manual check this feature needed a human ear for; unlike tickets 02/03/05 above, it's not still
pending.

One latency tradeoff flagged but not addressed here: the full model's TTFB is materially higher
than flash's, so an emphasized sentence will have an audibly longer pause before its audio starts
than the sentences around it (sentences already stream strictly in order, so this is a per-sentence
latency cost, not a correctness issue). Not tested for perceptibility in this pass.
