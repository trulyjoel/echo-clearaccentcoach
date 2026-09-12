# Cut HuPER, make `wav2vec2-xlsr-53-espeak-cv-ft` the served recognizer

## Problem

`2026-09-08-wav2vec2-xlsr53-comparison-scoring-design.md` added
`facebook/wav2vec2-xlsr-53-espeak-cv-ft` as a comparison-only signal alongside `HuperRecognizer`
(`huper29/huper_recognizer`, WavLM-Large, ARPAbet, 39 phones) — logged, never served, with
"deciding whether to eventually replace HuPER" explicitly out of scope. This design makes that
replacement: `wav2vec2-xlsr-53-espeak-cv-ft` becomes the only recognizer, serving what the app
shows users. `HuperRecognizer` is removed entirely, not kept as a fallback or reverse-comparison
signal.

## Goals

- Serve `wav2vec2-xlsr-53-espeak-cv-ft` for every scored turn; delete `HuperRecognizer` and every
  code path that exists only because HuPER's vocabulary was ARPAbet.
- Cut the ARPAbet round-trip the comparison feature introduced: `g2p.ts` emits wav2vec2's own IPA
  vocabulary directly, instead of collapsing espeak's IPA to ARPAbet and then re-expanding it to
  IPA server-side.
- Preserve the accent-target collapsing behavior `IPA_TO_ARPABET` currently encodes (cot-caught
  merger, NURSE-vowel spelling variants, reduced vowels, the glottal-stop /t/ allophone) — moving
  representations must not silently drop these merges.

## Non-goals

- **Re-tuning `GOP_MISPRONUNCIATION_THRESHOLD` (-3.0).** Carried over unchanged from HuPER's
  distribution. Flagged as a follow-up once real usage data exists on the new model — not decided
  here.
- **Any fallback or dual-serving path.** No feature flag, no reverse-comparison logging period. One
  deploy, one recognizer.
- **LLM tutor-prompt wording changes.** `llm.ts` will interpolate IPA symbols instead of ARPAbet
  letters into its context string; both are equally opaque to a lay reader and IPA is the actual
  standard, so no prompt rewording is in scope.
- **Changing the `/score` HTTP contract's shape** (still `POST` multipart audio + JSON
  `canonical_phones` → `ScoreResponse`). Only the *content* of the phone strings changes, not the
  schema.

## Wire-contract change

This is the substance of the cutover. Today:

```
phonemizer -> IPA -> collapsed to ARPAbet (g2p.ts, IPA_TO_ARPABET)
  -> CanonicalWord (ARPAbet) over the wire
  -> to_ipa_phones() re-expands ARPAbet back to IPA (arpabet_to_ipa.py, comparison path only)
  -> score_pronunciation(comparison_recognizer, ...)
```

The ARPAbet hop only existed because HuPER's vocabulary was ARPAbet. With HuPER gone, `g2p.ts` maps
espeak's IPA directly to wav2vec2's own IPA vocabulary and sends that over the wire — no
server-side re-expansion step at all:

```
phonemizer -> IPA -> collapsed to wav2vec2's canonical IPA (g2p.ts, IPA_TO_CANONICAL)
  -> CanonicalWord (wav2vec2 IPA) over the wire
  -> score_pronunciation(recognizer, ...)
```

`IPA_TO_ARPABET`'s job was never pure relabeling — it also merges several espeak spelling variants
into one accent-target phone: cot-caught (`ɔː`/`ɑː`/`ɔ`/`ɑ`/`oː` → one target), NURSE vowel
(`ɜː`/`ɜ`/`ɚ` → one target), reduced vowels (`ə`/`ᵻ`/`ɐ` → one target), and the glottal-stop /t/
allophone (`ʔ` → /t/'s target). `IPA_TO_CANONICAL` is mechanically composed from the two existing,
independently-verified tables (`IPA_TO_ARPABET` ∘ `ARPABET_TO_IPA`) so every merge rule carries over
without being retyped and risking a transcription error. Values become plain strings, not
`string[]` — every entry in the current table is already single-symbol, so the array was unused
generality.

`CanonicalWord.phones` and `PronunciationEditOp.expectedPhoneme`/`spokenPhoneme` now carry
wav2vec2's IPA symbols end to end (TS type, Python `schemas.py`, DB `text` columns, WebSocket
messages) instead of ARPAbet. This is an internal service boundary between two things deployed
together, not a public/versioned API, so both sides move in the same change — no compatibility
shim.

## Architecture

```
apps/server/src/
├── g2p.ts                    # IPA_TO_ARPABET -> IPA_TO_CANONICAL (espeak IPA -> wav2vec2 IPA);
│                              # HUPER_VALID_PHONES -> CANONICAL_VALID_PHONES; CanonicalWord doc
│                              # comment updated (ARPAbet -> wav2vec2 IPA vocab)
├── g2p.test.ts                # phone-literal expectations rewritten against real output
└── pronunciationRevisionDetector.test.ts  # hardcoded ARPAbet literals -> IPA equivalents

apps/pronunciation-service/
├── models.py             # HuperRecognizer deleted; Wav2Vec2XlsrRecognizer docstring drops its
│                          # "comparison-only" framing
├── handler.py             # handle_score_request loses comparison_recognizer param and the
│                          # comparison try/except block entirely
├── modal_app.py             # one recognizer, one download function, drops the ARPABET_TO_IPA
│                            # vocab-coverage assert (see Error handling)
├── arpabet_to_ipa.py          # deleted
├── schemas.py                  # doc comment: ARPAbet -> wav2vec2 IPA vocab
├── README.md                    # HuPER/comparison framing removed
├── _debug_predict.py              # deleted — already-dead, references a HuperCorrector class
│                                  # removed in an earlier migration; unrelated pre-existing cruft
│                                  # noticed while touching this area
└── tests/
    ├── test_arpabet_to_ipa.py     # deleted
    └── test_handler.py             # comparison-path cases removed
```

## Data flow

One `/score` request → `handle_score_request` decodes audio once (unchanged) → scores with
`wav2vec2-xlsr-53-espeak-cv-ft` against the wav2vec2-IPA canonical phones already produced by
`g2p.ts` → returns `ScoreResponse`. No second model, no second decode/score pass, no mapping step
in Python.

## Error handling

Today, an out-of-vocab canonical phone on the comparison path raises inside `score_pronunciation`,
but `handle_score_request`'s broad `try/except Exception` around that call catches it, logs it, and
returns the unaffected `ScoreResponse` — invisible to any caller. `modal_app.py`'s startup assert
(`set(ARPABET_TO_IPA.values()) <= set(recognizer.label2id)`) existed specifically to catch a
mapping-table typo before it degraded silently that way.

With wav2vec2 as the sole, unwrapped primary path, that same `ValueError` is no longer caught by
anything — it propagates to `modal_app.py`'s existing catch-all (`except Exception: raise
HTTPException(503, ...)`), a real, visible request failure. That's strictly louder than today's
silent-drop failure mode, not weaker, so the Python-side startup assert is redundant and is dropped
rather than ported. The coverage guard moves entirely to `g2p.test.ts`'s `CANONICAL_VALID_PHONES`
assertion (same role `HUPER_VALID_PHONES` already played), which checks every phone `g2p()` can
produce is in the served recognizer's vocabulary before it ever reaches a real request.

## Testing

- `g2p.test.ts`: `HUPER_VALID_PHONES` → `CANONICAL_VALID_PHONES` (wav2vec2's vocab subset); every
  phone-literal expectation re-verified against real `phonemizer` + `IPA_TO_CANONICAL` output, not
  guessed from the old ARPAbet expectations.
- `pronunciationRevisionDetector.test.ts`: hardcoded ARPAbet literals (e.g. `"V"`/`"B"`) become
  their IPA equivalents (`"v"`/`"b"`); the detector's own logic is vocabulary-agnostic (plain
  positional diff over whatever `g2p()` returns) so no code change there, only fixture updates.
- `test_handler.py`: comparison-path cases (failure-is-swallowed, both-sides-logged) removed;
  existing HuPER-path cases become the only-path cases, otherwise unchanged.
- `test_arpabet_to_ipa.py`: deleted with the module it tests.
- No new Python unit test for the wav2vec2 recognizer itself — same precedent `HuperRecognizer`
  already set (no unit coverage, verified via manual smoke test against real audio and the live
  deploy), now the only recognizer instead of the second one.

## Known follow-ups (not resolved by this design)

- **GOP threshold re-tuning.** -3.0 was chosen against HuPER's score distribution; whether it's
  still the right cut point for wav2vec2's is unverified. Revisit once real usage data exists.
- **`blank=0` still hardcoded** in `score_pronunciation`'s `forced_align` call (pre-existing,
  unaffected by this design — wav2vec2's pad/blank token is already asserted to be id 0 in
  `Wav2Vec2XlsrRecognizer.__init__`).
