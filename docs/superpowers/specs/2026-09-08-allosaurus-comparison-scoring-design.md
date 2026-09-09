# Allosaurus parallel comparison scoring (alongside HuPER-GOP)

## Problem

`2026-09-08-gop-pronunciation-scoring-design.md` replaced the HuPER Corrector with GOP scoring
against `huper29/huper_recognizer`, shipped it, and deployed it live. Testing the live service with
real audio (a native English speaker vs. a Spanish-accented speaker, word set "Rock/Red/Arrow/Try")
found a structural limitation, not a training gap: **the current backend cannot detect a trilled R
vs. the English approximant R, and no amount of retraining fixes it.** ARPAbet — the phone inventory
this whole pipeline is built on, from `g2p.ts` through the recognizer's own output vocabulary — has
exactly one symbol for R. English doesn't phonemically contrast trill/tap/approximant, so ARPAbet
collapses them all into one label; the output space itself has no slot for the distinction.

This matters beyond R: the user's actual goal, confirmed explicitly, is to stay in English as the
target language while detecting mispronunciations from learners across many different L1
backgrounds. Different L1s substitute different non-English allophones into English target phones
(Spanish trills, a Japanese tap-like liquid standing in for both R and L, French/German uvular R,
and so on) — ARPAbet's single-symbol-per-English-phoneme design makes *every one* of these invisible
to the current pipeline, not just the R case that happened to get tested first.

## Candidate and spike evidence

`xinjli/allosaurus` (ICASSP 2020, "Universal Phone Recognition with a Multilingual Allophone
System") has a fixed 229-phone IPA inventory with separate symbols for exactly the contrasts ARPAbet
collapses (seven distinct rhotic realizations alone: trill, approximant, retroflex approximant,
retroflex flap, tap, uvular trill, uvular fricative).

Reading Allosaurus's source directly (not assumed from its description) confirms its `Recognizer`
class cleanly separates `pm` (audio → features), `am` (features → raw per-frame log-probs), and `lm`
(log-probs → decoded phones for a specific language) — and `allosaurus/am/factory.py`'s `read_am()`
loads the acoustic model **independent of `lang_id`**, so the raw log-probs are always over the same
fixed universal 229-phone space regardless of which language you'd decode with. This means the exact
GOP architecture already built for HuPER (`torchaudio.functional.forced_align` + per-frame
log-posterior-ratio, in `apps/pronunciation-service/pipeline.py`) carries over with only a new
`Recognizer`-protocol implementation needed — `score_pronunciation`, `_group_into_spans`, and the
whole forced-alignment/threshold/allowlist mechanism are model-agnostic by design.

An informal local spike (Allosaurus's public `recognize()` API, `topk=3`, constrained to the
realistic `lang_id='eng'` inventory) confirmed the signal is there:

| test | top-1 (both speakers) | competing candidate's probability |
|---|---|---|
| English "Red" | ɻ/ɹ | trill `r` not even in top-3 |
| Spanish "Red" (trilled) | ɹ (0.808) | `r` (trill) at **0.068** |
| "very" (correct) | v (0.685) | `b` not even in top-3 |
| "berry" (b/v substitution) | v (0.646) | `b` at **0.348** |

Same lesson as the HuPER GOP work: top-1 argmax alone misses both contrasts, but the raw probability
of the "wrong" candidate is measurably higher for the accented sample in both cases — exactly the
failure mode GOP already solves for HuPER. Unconstrained/universal (`lang_id='ipa'`) decoding was
noisy and unreliable on its own; the signal lives in the probabilities, not the raw output string.

## Goals

- Run Allosaurus's acoustic model through the same GOP pipeline as HuPER, on the same audio, for
  every scored turn — as a **comparison signal to observe, not a replacement**. HuPER-GOP stays the
  thing that actually determines what the app shows a user.
- Keep `apps/pronunciation-service`'s HTTP contract, `schemas.py`, and every TS-side consumer
  (`apps/server/src/pronunciation.ts`, `g2p.ts`, `session.ts`) exactly as they are — this is a
  Python-service-internal addition only, same boundary the GOP migration itself preserved.
- Build the ARPAbet→Allosaurus-IPA phone mapping, including a real answer for diphthongs (see
  "Diphthong handling" below) rather than a lossy shortcut.

## Non-goals

- **Serving Allosaurus's result to the app, or persisting it anywhere durable.** Decided explicitly:
  log it, don't wire it. If the comparison data turns out to be worth querying later, that's a
  separate follow-up with its own design (a schema/store decision deserves its own scrutiny, not a
  rider on this one).
- **Deciding whether to eventually replace HuPER with Allosaurus.** This design produces the data to
  make that call later; it doesn't make the call now.
- **Using the learner's L1 (already captured at onboarding) to bias scoring.** The spike only tested
  the realistic "don't know the L1 at scoring time" scenario. Worth revisiting once comparison data
  exists, not decided here.
- **Optimizing latency.** Scoring runs inline, doubling per-turn model-inference cost for the
  duration of the comparison period — an explicit, accepted trade for implementation simplicity over
  a fire-and-forget background path. Revisit if real measured latency threatens
  `SCORE_TURN_TIMEOUT_MS` (`apps/server/src/pronunciation.ts`).

## Architecture

```
apps/pronunciation-service/
├── modal_app.py        # image gains Allosaurus's deps + a checkpoint bake step; PronunciationService
│                        # .load() instantiates both recognizers
├── handler.py           # handle_score_request gains a second recognizer param; HuPER result is still
│                        # the only thing in ScoreResponse
├── models.py             # + AllosaurusRecognizer, alongside the existing HuperRecognizer
├── arpabet_to_ipa.py       # new: static phone-mapping table + to_allosaurus_phones()
├── pipeline.py              # unchanged — score_pronunciation is already model-agnostic
├── schemas.py                # unchanged
└── tests/
    ├── test_models.py          # + AllosaurusRecognizer coverage
    ├── test_arpabet_to_ipa.py   # new
    └── test_handler.py           # + case: Allosaurus failure doesn't affect ScoreResponse
```

### `AllosaurusRecognizer` (`models.py`)

Satisfies the same `Recognizer` protocol `pipeline.py` already defines (`label2id`, `id2label`,
`log_probs(waveform)`), loading Allosaurus's `am` directly via `allosaurus.am.factory.read_am()` —
bypassing `lang_id`/`lm` entirely, per the confirmed-from-source finding above. `label2id`/`id2label`
come from Allosaurus's own 229-phone inventory plus whatever blank/non-phone tokens its CTC output
uses (the exact set — confirmed against the installed package, not assumed — is an implementation
task; see "Deferred to implementation").

### Phone mapping (`arpabet_to_ipa.py`)

A static `ARPABET_TO_IPA: dict[str, tuple[str, ...]]` mapping each ARPAbet phone `pipeline.py` may
see (from `g2p.ts`'s output vocabulary) to one or more Allosaurus IPA symbols, plus:

```python
def to_allosaurus_phones(canonical_phones: list[CanonicalWord]) -> list[CanonicalWord]:
    """Rewrites each word's ARPAbet phones into Allosaurus IPA symbols for comparison scoring."""
```

**Diphthong handling:** ARPAbet writes diphthongs (`AY`, `AW`, `EY`, `OW`, `OY`) as a single token;
Allosaurus's inventory has separate symbols for the onset and offset vowel, no single symbol for the
diphthong as a unit. Decided: expand each diphthong into its two-phone IPA sequence at mapping time,
rather than collapsing to one approximate symbol — `score_pronunciation` already handles a variable
number of phones per word (it just repeats `(word, word_index)` per phone), so this needs no changes
there. The one real consequence: a single ARPAbet diphthong can now produce up to two edit ops in the
Allosaurus-side output where HuPER's would produce (at most) one. Since this output is logged, not
served or counted, that's an acceptable asymmetry — not something a consumer needs to reconcile.

### `handle_score_request` (`handler.py`)

Gains an `allosaurus_recognizer: Recognizer` parameter. After building the `ScoreResponse` from
HuPER's result exactly as today, it calls:

```python
try:
    allosaurus_ops = score_pronunciation(
        allosaurus_recognizer, waveform, to_allosaurus_phones(words)
    )
    logger.info("allosaurus comparison: %s", allosaurus_ops)
except Exception:
    logger.exception("allosaurus comparison scoring failed")
```

before returning the (unchanged) `ScoreResponse`. This is the only place that catches broadly —
`score_pronunciation` and `AllosaurusRecognizer` themselves stay strict (raise on bad input, same
contract as the HuPER path), because a real, independently-correct function is what makes the
comparison data trustworthy. The swallowing happens at the call site because *that call's result*
is diagnostic, not because the function itself is allowed to be sloppy.

### `modal_app.py`

`PronunciationService.load()` (the existing `@modal.enter()` hook) instantiates both
`HuperRecognizer` and `AllosaurusRecognizer`, and passes both into `handle_score_request`. The image
gains Allosaurus and its own dependency chain (`torch`/`numpy`/`scipy`/`panphon`, distinct from the
already-pinned `transformers` stack) and a download/bake step for its checkpoint, mirroring the
existing `_download_recognizer` pattern. Version compatibility between Allosaurus's pins and the
already-pinned `torch==2.14.0`/`torchaudio==2.11.0` is **not verified by this design** — see
"Deferred to implementation."

## Data flow

One `/score` request → `handle_score_request` decodes audio once (unchanged `decode_audio` +
`load_waveform`) → scores with HuPER against ARPAbet canonical phones (served, unchanged) → scores
the same waveform with Allosaurus against IPA-mapped canonical phones (logged only) → returns
exactly today's `ScoreResponse`.

## Error handling

`score_pronunciation` and `AllosaurusRecognizer` raise on bad input exactly like the HuPER path
already does (out-of-vocabulary phone, audio too short, etc.) — no special-casing for Allosaurus
inside those functions. `handle_score_request`'s comparison call is wrapped in a single broad
`try/except Exception`, logged and dropped, so an Allosaurus-side failure (model issue, mapping gap,
anything) never changes the HTTP status code or response body a caller sees.

## Testing

- `tests/test_models.py`: `AllosaurusRecognizer` tested the same way `HuperRecognizer` is — a fake
  covering `label2id`/`id2label`/`log_probs`, no real model load in unit tests.
- `tests/test_arpabet_to_ipa.py`: table coverage for a plain phone (1:1 mapping), a diphthong
  (2-phone expansion), and an out-of-table phone (explicit failure, not a silent drop).
- `tests/test_handler.py`: existing HuPER-path cases unchanged; new case asserts a raised exception
  from the Allosaurus call site is caught and the returned `ScoreResponse` is identical to what it
  would be without the comparison call at all.
- No TS-side test changes — the wire contract doesn't move.

## Deferred to implementation (research tasks, not resolved by this design)

- **Dependency compatibility.** Allosaurus's pinned `torch`/`numpy`/`scipy` versions vs. the image's
  existing pins — verify with an actual `uv pip install <pkg>==<version>` attempt or an exact-version
  PyPI endpoint check, not a sorted "latest versions" list (a prior session-local mistake: sorting
  version strings lexicographically silently hid real available versions).
- **Checkpoint bake step.** Allosaurus's model-download mechanism (its own, not
  `huggingface_hub`-based) needs a concrete `_download_allosaurus_model()`-equivalent for the image
  build, verified against the installed package's actual API.
- **Non-phone token set.** HuPER's `NON_PHONE_TOKENS` (`<PAD>`, `<UNK>`, `<BOS>`, `<EOS>`, `|`) is
  specific to its vocabulary; Allosaurus's CTC blank/special-token set must be confirmed against its
  actual `id2label` output, not assumed to match.
- **Full `ARPABET_TO_IPA` table contents.** The mapping shape (including diphthong expansion) is
  decided; the specific IPA symbol chosen for each ARPAbet phone needs to be checked against
  Allosaurus's installed `phone.txt`, not guessed from general IPA knowledge.

## Further notes

Allosaurus is a single-author academic project (2020), not a `transformers`-native checkpoint, with
its own serving shape — its production maturity is a real open question the parallel-comparison
period is partly meant to answer. The `am`-bypass approach is confirmed to exist in the source but
has only been exercised via the public `recognize()` API in the spike, not end-to-end through real
forced-alignment — that first real exercise happens during this design's implementation.
