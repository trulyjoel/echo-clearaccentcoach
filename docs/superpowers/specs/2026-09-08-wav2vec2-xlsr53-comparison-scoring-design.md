# `wav2vec2-xlsr-53-espeak-cv-ft` parallel comparison scoring (alongside HuPER-GOP)

## Problem

`2026-09-08-gop-pronunciation-scoring-design.md` replaced the HuPER Corrector with GOP scoring
against `huper29/huper_recognizer`, shipped it, and deployed it live. Testing the live service with
real audio (a native English speaker vs. a Spanish-accented speaker, word set "Rock/Red/Arrow/Try")
found a structural limitation: **the current backend cannot detect a trilled R vs. the English
approximant R.** ARPAbet — the phone inventory this whole pipeline is built on, from `g2p.ts` through
the recognizer's own output vocabulary — has exactly one symbol for R.

Further live testing against the deployed service (not a spike — the actual `/score` endpoint,
via `scoreAudioFile.ts`) during this same investigation showed the gap is narrower than first
assumed. HuPER-GOP, unmodified, already correctly flags:

- **Japanese L1's L/R merger** — `sub (expected=L, spoken=R)`, confirmed on 4 real recordings
  ("especially"/"completed", two speakers/repeats each).
- **Final-obstruent devoicing** — `sub (expected=D, spoken=T)` and equivalents, confirmed on both
  a Spanish-accented speaker ("Bad"→`B AH T`, "Cod"→`K AA T`, "Job"→`JH AA P`, "Love"→`L AA F`) and
  the Japanese-L1 "completed" sample (`D`→`T`).
- **Spanish's b/v merger** — this is the case the original GOP-vs-Corrector spec's own spike
  evidence was built on ("very"/"berry" collapsing sharply at the canonical phone, GOP -7.6 to -8.3).

These all work because **ARPAbet already has separate symbols for both sides of the
contrast** (`L`/`R`, `D`/`T`, `B`/`V`) — GOP only needed the recognizer to prefer the wrong
*existing* symbol, which it does. The real, still-confirmed-open gap is narrower and more specific:
**contrasts ARPAbet has no symbol for at all**, not L1 substitution detection broadly. Beyond the
rhotic case, this includes (surveyed against common ESL-pedagogy L1-transfer patterns, not yet
spiked individually):

- **Retroflex-for-alveolar substitutions** (Hindi/Indian English `T`/`D`/`N`/`L`/`S` produced
  retroflex) — ARPAbet has no retroflex marking, the same shape of gap as rhotics, affecting a large
  population of learners.
- **Dark-L vs. clear-L** (velarized `L`, common Russian/Slavic/Portuguese transfer) — ARPAbet's
  single `L` symbol doesn't distinguish, the same shape of gap again.
- **Aspiration contrasts** (Hindi's four-way and Korean's three-way stop systems misapplied to
  English stops) — ARPAbet doesn't encode aspiration at all, since English doesn't phonemically
  contrast it.

Separately, **consonant-cluster vowel epenthesis** (Spanish "estudent," Japanese "sutoraiku," and
similar patterns across many L1s) is invisible regardless of which recognizer model is used — it's
an *insertion*, and `forced_align` structurally can't represent an extra phone absent from the
canonical target. This was already an explicit Non-goal of the shipped GOP design and isn't
something a second model changes.

## Candidate selection

The first candidate considered, `xinjli/allosaurus` (ICASSP 2020), was rejected after checking its
actual maintenance signal: Open Source Insights' scorecard shows zero commits and zero issue
activity in the last 90 days, one release ever (2021), last push April 2024, and GPL-3.0 licensing —
a single-author, dormant package is a poor foundation for a service meant to run indefinitely.

The second candidate, `ZIPA-CR-small` (ACL 2025, `lingjzhu/zipa`), was chosen next: actively
maintained (real commits within the last ~2 months, MIT-licensed), and beats both Allosaurus and
`wav2vec2-xlsr-53-espeak-cv-ft` on the published aggregate multilingual phone-recognition benchmark
(PFER). It was set aside after a direct local spike of `wav2vec2-xlsr-53-espeak-cv-ft` (below)
produced clean, confident, real-audio evidence on the exact contrasts this project cares about —
strong enough to prefer it over ZIPA-CR's better-on-average-but-unverified-here benchmark edge,
combined with its meaningfully lower dependency risk (see "Dependency risk" below).

**Chosen: `facebook/wav2vec2-xlsr-53-espeak-cv-ft`** — a `Wav2Vec2ForCTC` model (Meta AI, Apache-2.0),
self-supervised pretraining on 53 languages then CTC fine-tuned for phoneme recognition across 42
CommonVoice, 19 BABEL, and 6 MLS languages (including Spanish), from "Simple and Effective Zero-shot
Cross-lingual Phoneme Recognition" (Xu, Baevski, Auli — Interspeech 2022). 392-symbol IPA vocabulary,
confirmed (via its `vocab.json`) to include separate symbols for every contrast this investigation
has tested: `r`(31)/`ɹ`(27)/`ɾ`(15)/`ʁ`(28) for rhotics, `b`(26)/`v`(25) for the Spanish merger.

### Local spike evidence (real audio, this session)

Ran the model directly (`transformers.Wav2Vec2ForCTC` + `Wav2Vec2Processor`, greedy CTC decode)
against every real sample in `apps/server/pronunciation-scorer-test/`:

**Rhotic contrast**, "Rock Red Arrow Try": English speaker's 4 R's all decode `ɹ` (argmax
probability 0.89–0.94); Spanish speaker's 6 R's all decode `r` (trill, 0.90–0.98) — clean top-1
separation, not just a raised competing-candidate probability the way the Allosaurus spike needed.

**b/v contrast**: "very" → `v` (0.976); "berry" → `b` (0.976).

**Independent confirmation on continuous speech** (the "Next vacation I'd love to visit the river"
fixture, unprompted — not a minimal pair): native "river" → `ɹ ɪ v ɚ`; Spanish-accented "river" →
`r i v e r` (trill, no rhotic vowel) — third independent rhotic confirmation. The Spanish speaker's
"vacation" also came out missing its leading `v` (`p eɪ k...` instead of `v eɪ k...`), consistent
with Spanish's b/v instability showing up organically.

**"Bad/Cod/Job/Love" minimal set** (native vs. Spanish-accented, same speaker pair, verified split
via the ~1.06s inter-speaker silence gap): Spanish accented "Bad"→`b a t` (devoiced), "Love"→`l ɔ`
(v dropped). Less complete than HuPER's own decode of the same audio (which caught devoicing on all
four words, see "Problem" above) — worth being honest that on this specific test, HuPER's WavLM
backbone was *more* consistent than this candidate, not less. The candidate's value isn't "better
than HuPER at everything," it's "sees things HuPER structurally cannot."

**"Especially/Completed" Japanese L1 set**: after deploying, real audio confirmed HuPER itself
already flags `sub (expected=L, spoken=R)` for the Japanese L/R merger and `sub (expected=D,
spoken=T)` for final devoicing — both catchable because ARPAbet already has separate symbols for
both sides. This is what narrowed the "Problem" framing above; it isn't a wav2vec2-xlsr-53-specific
finding.

### Dependency risk

| | Allosaurus | ZIPA-CR | **wav2vec2-xlsr-53-espeak-cv-ft** |
|---|---|---|---|
| Loading | bespoke `allosaurus` pip package | `onnxruntime` + standalone script | `transformers.Wav2Vec2ForCTC` — already-pinned library, same pattern as `HuperRecognizer` |
| License | GPL-3.0 | MIT | Apache-2.0 |
| Maintainer | dormant since 2024 | active, single maintainer | static checkpoint (Meta), no ongoing maintenance needed — same risk tier as `huper29/huper_recognizer` itself |
| `trust_remote_code` | n/a | not needed | not needed |

This is the lowest-risk tier of any candidate considered — the same tier HuPER's own production
dependency is already in.

## Why CTC matters here

`HuperRecognizer` and this candidate are both CTC (Connectionist Temporal Classification) models: at
every audio frame they independently output a probability distribution over phones (plus a blank
token), with no built-in notion of phone boundaries. `torchaudio.functional.forced_align` takes that
raw `(frames × vocab)` matrix plus a known target phone sequence and finds the most probable
frame-by-frame path producing exactly those phones — which is how `_group_into_spans` gets per-phone
frame ranges and how GOP (canonical phone's probability vs. the best-scoring alternative) gets
computed. This candidate being `Wav2Vec2ForCTC` (not a transducer, unlike `ZIPA-T`) means it plugs
into the exact same mechanism with no new alignment strategy needed.

## Goals

- Run `wav2vec2-xlsr-53-espeak-cv-ft` through the same GOP pipeline as HuPER, on the same audio, for
  every scored turn — as a **comparison signal to observe, not a replacement**. HuPER-GOP stays the
  thing that actually determines what the app shows a user.
- Keep `apps/pronunciation-service`'s HTTP contract, `schemas.py`, and every TS-side consumer
  (`apps/server/src/pronunciation.ts`, `g2p.ts`, `session.ts`) exactly as they are — this is a
  Python-service-internal addition only, same boundary the GOP migration itself preserved.
- Build the ARPAbet→IPA phone mapping, including a real answer for diphthongs (see "Diphthong
  handling" below) rather than a lossy shortcut.
- Specifically observe the narrowed set of contrasts identified in "Problem" — rhotic realizations
  foremost, with retroflex-for-alveolar, dark/light-L, and aspiration contrasts as secondary
  targets worth watching for once comparison data exists.

## Non-goals

- **Serving this model's result to the app, or persisting it anywhere durable.** Decided explicitly:
  log it, don't wire it. If the comparison data turns out to be worth querying later, that's a
  separate follow-up with its own design.
- **Deciding whether to eventually replace HuPER.** This design produces the data to make that call
  later; it doesn't make the call now.
- **Using the learner's L1 (already captured at onboarding) to bias scoring.** Worth revisiting once
  comparison data exists, not decided here.
- **Solving insertion detection (consonant-cluster epenthesis).** Structurally out of reach for
  `forced_align` regardless of which recognizer is used — already a Non-goal of the shipped GOP
  design, unaffected by this addition.
- **Optimizing latency.** Scoring runs inline, doubling per-turn model-inference cost for the
  duration of the comparison period. Unlike `ZIPA-CR-small` (64M params), this candidate is ~300M
  params — essentially the same size class as HuPER itself, so this is a real, roughly 2x latency
  cost, not a cheap add-on. Accepted as an explicit trade for implementation simplicity over a
  fire-and-forget background path. Measured post-deploy: cold-start (first request on a fresh
  container, both models loading) came in at ~9.7s, right at the edge of `SCORE_TURN_TIMEOUT_MS`
  (10s, `apps/server/src/pronunciation.ts`) — matches HuPER's own previously-observed cold-start
  behavior, not a new problem this feature introduced. Warm-container requests measured at ~450ms,
  comfortably clear of the timeout — the latency risk is a cold-start phenomenon only, not a
  steady-state concern.

## Architecture

```
apps/pronunciation-service/
├── modal_app.py        # image gains this candidate's checkpoint download step; PronunciationService
│                        # .load() instantiates both recognizers
├── handler.py           # handle_score_request gains a second recognizer param; HuPER result is still
│                        # the only thing in ScoreResponse
├── models.py             # + Wav2Vec2XlsrRecognizer, alongside the existing HuperRecognizer
├── arpabet_to_ipa.py       # new: static phone-mapping table + to_ipa_phones()
├── pipeline.py              # Recognizer protocol gains non_phone_tokens (per-instance, not a
│                            # shared HuPER-shaped constant) — score_pronunciation itself unchanged
├── schemas.py                # unchanged
└── tests/
    ├── test_arpabet_to_ipa.py   # new
    └── test_handler.py           # + case: comparison-model failure doesn't affect ScoreResponse
```

### `Wav2Vec2XlsrRecognizer` (`models.py`)

Satisfies the same `Recognizer` protocol `pipeline.py` already defines (`label2id`, `id2label`,
`non_phone_tokens`, `log_probs(waveform)`). Loads via `Wav2Vec2FeatureExtractor` + `Wav2Vec2ForCTC`
directly — confirmed during implementation to work without pulling in `phonemizer`/`espeak-ng` (the
full `Wav2Vec2Processor` would need those for its bundled tokenizer's text→phoneme encoding, which
this use case never exercises; only the acoustic model's raw log-probs are used). `label2id`/
`id2label` are read from the model's own `vocab.json` via `huggingface_hub.hf_hub_download`.
`non_phone_tokens` is built dynamically from `model.config.pad_token_id`/`bos_token_id`/
`eos_token_id` read back through `id2label` — never a hardcoded literal token string, since the
model's special-token spellings (confirmed empirically: `<pad>`/`<s>`/`</s>`/`<unk>`) don't need to
be assumed in advance this way.

### Phone mapping (`arpabet_to_ipa.py`)

A static `ARPABET_TO_IPA: dict[str, str]` mapping each of the 39 ARPAbet phones `g2p.ts`'s
`HUPER_VALID_PHONES` may produce (`AA`...`ZH`, `DX` included) to a single IPA symbol in this model's
vocabulary, plus:

```python
def to_ipa_phones(canonical_phones: list[CanonicalWord]) -> list[CanonicalWord]:
    """Rewrites each word's ARPAbet phones into the comparison model's IPA symbols."""
```

**Diphthong handling — resolved, not a two-phone expansion.** ARPAbet writes diphthongs (`AY`,
`AW`, `EY`, `OW`, `OY`) as a single token; the initial assumption was that IPA in general has no
single symbol for a diphthong and a two-phone onset/offset expansion would be needed. Checking this
model's actual `vocab.json` resolved that: it already has dedicated single-token symbols for every
one of these (`aɪ`, `aʊ`, `eɪ`, `oʊ`, `ɔɪ` all confirmed present and used in this session's real
audio decodes). So the mapping table is a plain 1:1 dict for all 39 entries — no `CanonicalWord`
length changes, no `word_positions` bookkeeping concerns.

`R` maps to `ɹ` — the canonical English approximant, not the trill `r`. This direction matters: the
whole point of this comparison model is noticing when the audio's actual phone is the "wrong"
trill/tap/uvular alternative instead of the canonical approximant.

### `handle_score_request` (`handler.py`)

Gains a second `Recognizer` parameter. After building the `ScoreResponse` from HuPER's result
exactly as today, it calls:

```python
try:
    comparison_ops = score_pronunciation(comparison_recognizer, waveform, to_ipa_phones(words))
    logger.info(
        "comparison scoring: words=%s huper=%s comparison=%s",
        [w.word for w in words], edit_ops, comparison_ops,
    )
except Exception:
    logger.exception("comparison scoring failed for words=%s", [w.word for w in words])
```

before returning the (unchanged) `ScoreResponse`. This is the only place that catches broadly —
`score_pronunciation` and `Wav2Vec2XlsrRecognizer` themselves stay strict (raise on bad input, same
contract as the HuPER path), because a real, independently-correct function is what makes the
comparison data trustworthy. The swallowing happens at the call site because *that call's result* is
diagnostic, not because the function itself is allowed to be sloppy. The log line includes both
sides of the comparison (HuPER's `edit_ops` and the comparison model's `comparison_ops`) plus the
turn's words, since a comparison-only feature is useless if its log can't actually be compared
against anything or correlated to a turn.

### `modal_app.py`

`PronunciationService.load()` (the existing `@modal.enter()` hook) instantiates both
`HuperRecognizer` and `Wav2Vec2XlsrRecognizer`, and passes both into `handle_score_request`. The
image gains a download step for `facebook/wav2vec2-xlsr-53-espeak-cv-ft`'s weights via
`huggingface_hub` (already a pinned dependency, same mechanism as `_download_recognizer`) — no new
package family needed; the phonemizer-free loading path was confirmed to work. `logging.basicConfig`
is configured at module level here (the actual container entrypoint), not in `handler.py` — this
service had no logging configuration anywhere before this change, which meant `logger.info` calls
were silent no-ops under Python's default root-logger level (WARNING). Confirmed via a real deploy
that comparison-scoring log lines are now actually visible in `modal app logs`.

## Data flow

One `/score` request → `handle_score_request` decodes audio once (unchanged `decode_audio` +
`load_waveform`) → scores with HuPER against ARPAbet canonical phones (served, unchanged) → scores
the same waveform with the comparison model against IPA-mapped canonical phones (logged only) →
returns exactly today's `ScoreResponse`.

## Error handling

`score_pronunciation` and `Wav2Vec2XlsrRecognizer` raise on bad input exactly like the HuPER path
already does (out-of-vocabulary phone, audio too short, etc.) — no special-casing inside those
functions. `handle_score_request`'s comparison call is wrapped in a single broad `try/except
Exception`, logged and dropped, so a comparison-side failure (model issue, mapping gap, anything)
never changes the HTTP status code or response body a caller sees.

**Mapping-table coverage is asserted at container start, not left to fail per-request.** Since
`score_pronunciation` raises `ValueError` on any canonical phone absent from the recognizer's
vocabulary, and that raise is caught and merely logged by the try/except above, an incomplete
`ARPABET_TO_IPA` entry would otherwise degrade silently — fewer comparison log lines, indistinguishable
from fewer real mispronunciations. `PronunciationService.load()` asserts
`set(ARPABET_TO_IPA.values()) <= set(recognizer.label2id)` once at startup, turning a silent
per-request degradation into a loud deploy-time failure if the model's vocabulary ever changes
underneath this mapping.

## Testing

- `tests/test_arpabet_to_ipa.py`: table coverage for a plain phone (1:1 mapping), a diphthong
  (confirms the model's own single-symbol entry is used, not a two-phone expansion), the `R`→`ɹ`
  directionality, multi-word boundary preservation, and an out-of-table phone (explicit failure, not
  a silent drop).
- `tests/test_handler.py`: existing HuPER-path cases unchanged; cases assert a raised exception from
  the comparison call site is caught and the returned `ScoreResponse` is identical to what it would
  be without the comparison call at all, and that a successful comparison call logs both sides.
- `Wav2Vec2XlsrRecognizer` itself has no unit test — this codebase's existing precedent is that
  `HuperRecognizer` (the analogous class) also has zero unit-test coverage, since a real test would
  require a real model download; verified instead via a manual smoke test against real audio and,
  ultimately, the live deploy itself.
- No TS-side test changes — the wire contract doesn't move.

## Known follow-ups (not resolved by this design)

- **`ACCEPTABLE_REALIZATIONS` (`pipeline.py`) is ARPAbet-keyed** (e.g. `{"D": {"DX"}}`) and doesn't
  apply on the IPA comparison path, where canonical phones are lowercase IPA symbols. This means the
  flap-tolerance behavior that exists specifically to suppress a real false positive on fluent native
  speech (see the original GOP spec) is silently absent for the comparison model — every native flap
  will log as a `sub` on the comparison path that HuPER's own path correctly suppresses. Worth
  becoming a per-`Recognizer` field (mirroring `non_phone_tokens`) in a follow-up, once real log data
  shows whether this actually produces a meaningful volume of noise.
- **`blank=0` is hardcoded** in `score_pronunciation`'s `forced_align` call. Correct for both models
  today (both happen to put their pad/blank token at id 0), but it's the same category of
  model-specific assumption `non_phone_tokens` was pulled out of `pipeline.py` for — worth deriving
  from the recognizer directly (or at least asserting) if a third recognizer is ever added.

## Further notes

`facebook/wav2vec2-xlsr-53-espeak-cv-ft` is a static, Meta-published checkpoint served purely through
`transformers` — the same low-maintenance-risk profile as `huper29/huper_recognizer`'s own production
dependency, and meaningfully lower risk than either Allosaurus (confirmed dormant) or ZIPA-CR
(actively maintained, but still a single-author research artifact). The three L1-transfer contrasts
confirmed working on the live, already-deployed HuPER-GOP service during this investigation (Japanese
L/R merger, final-obstruent devoicing, Spanish b/v) mean this addition's practical value is narrower
and more specific than the original problem statement implied: it's for contrasts ARPAbet has no
symbol for at all (rhotics, confirmed via live deploy; retroflex-for-alveolar, dark/light-L, and
aspiration contrasts, plausible but not yet spiked individually), not L1-driven mispronunciation
broadly.
