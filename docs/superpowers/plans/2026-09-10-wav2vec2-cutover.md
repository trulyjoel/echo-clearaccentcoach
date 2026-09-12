# Cut HuPER, serve wav2vec2-xlsr-53 as sole recognizer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `facebook/wav2vec2-xlsr-53-espeak-cv-ft` the only pronunciation-scoring recognizer, deleting `HuperRecognizer` and the ARPAbet round-trip its vocabulary required.

**Architecture:** `g2p.ts` maps espeak's IPA directly to wav2vec2's own IPA vocabulary (`IPA_TO_CANONICAL`, replacing `IPA_TO_ARPABET`) and sends that over the wire. `apps/pronunciation-service` drops its second model, its comparison-scoring pass, and the `arpabet_to_ipa.py` module that translated between the two vocabularies.

**Tech Stack:** TypeScript (`apps/server`, vitest), Python 3.13 (`apps/pronunciation-service`, pytest/ruff/ty via `uv`).

**Spec:** `docs/superpowers/specs/2026-09-10-wav2vec2-cutover-design.md`

## Global Constraints

- `GOP_MISPRONUNCIATION_THRESHOLD` stays `-3.0` — do not retune it in this plan.
- No fallback, feature flag, or dual-serving path — one recognizer, one deploy.
- The `/score` HTTP contract's shape is unchanged (`POST` multipart audio + JSON `canonical_phones` → `ScoreResponse`); only the phone strings' content changes.
- Preserve every accent-target collapse `IPA_TO_ARPABET` encoded (cot-caught merger, NURSE vowel, reduced vowels, glottal-stop /t/) — `IPA_TO_CANONICAL` must be the mechanical composition of the old `IPA_TO_ARPABET` and `ARPABET_TO_IPA` tables, not retyped.

---

### Task 1: `g2p.ts` — emit wav2vec2's own IPA vocabulary directly

**Files:**
- Modify: `apps/server/src/g2p.ts`
- Test: `apps/server/src/g2p.test.ts`

**Interfaces:**
- Produces: `export const CANONICAL_VALID_PHONES: Set<string>` (replaces `HUPER_VALID_PHONES`), `export async function g2p(transcript: string): Promise<CanonicalWord[]>` (signature unchanged, `phones` now wav2vec2 IPA strings instead of ARPAbet) — consumed by `pronunciationRevisionDetector.ts` (unchanged, vocabulary-agnostic) and by every caller across the wire boundary into `apps/pronunciation-service`.

- [ ] **Step 1: Update the failing test file**

Replace `apps/server/src/g2p.test.ts` in full:

```typescript
import { describe, expect, it } from "vitest";
import { CANONICAL_VALID_PHONES, g2p } from "./g2p.js";

describe("g2p", () => {
  it("produces word-aligned canonical phones with no stress digits for a dictionary word", async () => {
    const result = await g2p("cat");

    expect(result).toEqual([{ word: "cat", phones: ["k", "æ", "t"] }]);
    for (const { phones } of result) {
      for (const phone of phones) expect(phone).not.toMatch(/[0-9]/);
    }
  });

  it("produces one CanonicalWord per word, in transcript order, for a multi-word transcript", async () => {
    const result = await g2p("I like cats");

    expect(result.map((w) => w.word)).toEqual(["I", "like", "cats"]);
    for (const { phones } of result) expect(phones.length).toBeGreaterThan(0);
  });

  it("falls back to rule-based G2P for a word not in the dictionary, without throwing", async () => {
    const result = await g2p("zxqzptrl");

    expect(result).toHaveLength(1);
    expect(result[0]?.word).toBe("zxqzptrl");
    expect(result[0]?.phones.length).toBeGreaterThan(0);
  });

  it("strips punctuation before phonemizing so it isn't treated as a word", async () => {
    const result = await g2p("Hello, world!");

    expect(result.map((w) => w.word)).toEqual(["Hello", "world"]);
  });

  it("returns an empty array for an empty or whitespace-only transcript", async () => {
    expect(await g2p("")).toEqual([]);
    expect(await g2p("   ")).toEqual([]);
  });

  it("every phone g2p ever emits is a member of wav2vec2's 39-phone vocabulary", async () => {
    const result = await g2p("I like cats hello 1995");
    for (const { phones } of result) {
      for (const phone of phones) expect(CANONICAL_VALID_PHONES.has(phone)).toBe(true);
    }
  });

  it("normalizes espeak-ng's reduced schwa to a canonical phone for a word known to trigger it", async () => {
    const result = await g2p("hello");

    expect(result).toHaveLength(1);
    // "hello" -> /həlˈoʊ/ — the unstressed first syllable's schwa must resolve to "ʌ", not pass
    // through as the raw IPA "ə" (which isn't in wav2vec2's target vocabulary).
    expect(result[0]?.phones).toEqual(["h", "ʌ", "l", "oʊ"]);
  });

  it("joins phones from every expanded entry for a number, without truncating to just the first", async () => {
    const result = await g2p("1995");

    expect(result).toHaveLength(1);
    expect(result[0]?.word).toBe("1995");
    // "1995" expands to three entries ("nineteen"/"ninety"/"five") — a truncated implementation
    // that only reads the first entry would produce far fewer phones than this.
    expect(result[0]?.phones.length).toBeGreaterThan(5);
    for (const phone of result[0]?.phones ?? []) {
      expect(CANONICAL_VALID_PHONES.has(phone)).toBe(true);
    }
  });

  it("doesn't truncate for a non-ASCII/accented word", async () => {
    const result = await g2p("naïve");

    expect(result).toHaveLength(1);
    expect(result[0]?.word).toBe("naïve");
    expect(result[0]?.phones.length).toBeGreaterThan(0);
    for (const phone of result[0]?.phones ?? []) {
      expect(CANONICAL_VALID_PHONES.has(phone)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && npx vitest run src/g2p.test.ts`
Expected: FAIL — `CANONICAL_VALID_PHONES` is not exported from `./g2p.js`, and the `"cat"`/`"hello"` assertions don't match the current ARPAbet output.

- [ ] **Step 3: Update `g2p.ts`**

Replace `apps/server/src/g2p.ts` in full:

```typescript
import { phonemize } from "phonemizer";

/** One transcript word and its canonical (target-accent) IPA phones, stress-digit-free and
 * restricted to facebook/wav2vec2-xlsr-53-espeak-cv-ft's vocabulary (verified against that
 * model's vocab.json). */
export interface CanonicalWord {
  word: string;
  phones: string[];
}

/** Matches runs of word characters and apostrophes (so contractions like "don't" stay one word),
 * discarding surrounding punctuation — `phonemizer` would otherwise treat punctuation as its own
 * token. */
const WORD_PATTERN = /[\p{L}\p{N}']+/gu;

/** facebook/wav2vec2-xlsr-53-espeak-cv-ft's Recognizer only recognizes these 39 phones (excluding
 * special tokens like `<pad>`/`<unk>`) — the subset of its 392-symbol vocabulary that
 * `IPA_TO_CANONICAL` ever targets. */
export const CANONICAL_VALID_PHONES = new Set([
  "aɪ", "aʊ", "b", "d", "dʒ", "eɪ", "f", "h", "iː", "j", "k", "l", "m", "n", "oʊ", "p", "s", "t",
  "tʃ", "uː", "v", "w", "z", "æ", "ð", "ŋ", "ɑː", "ɔɪ", "ɚ", "ɛ", "ɡ", "ɪ", "ɹ", "ɾ", "ʃ", "ʊ", "ʌ",
  "ʒ", "θ",
]);

/** IPA symbol (as emitted by `phonemizer`, a WASM build of real espeak-ng) -> its canonical
 * wav2vec2-xlsr-53-espeak-cv-ft target symbol. The 39 entries whose key equals its value are pure
 * vocabulary membership checks (espeak already spells them the way the recognizer expects). The
 * remaining entries collapse espeak-ng symbols with no direct wav2vec2 target of their own onto
 * the nearest American-English accent target: reduced vowels, a glottal-stop /t/ allophone, and
 * cot-caught/NURSE vowel spelling variants. */
const IPA_TO_CANONICAL: Record<string, string> = {
  ɑː: "ɑː", æ: "æ", ʌ: "ʌ", aʊ: "aʊ", aɪ: "aɪ", b: "b",
  tʃ: "tʃ", d: "d", ð: "ð", ɾ: "ɾ", ɛ: "ɛ", ɚ: "ɚ",
  eɪ: "eɪ", f: "f", ɡ: "ɡ", h: "h", ɪ: "ɪ", iː: "iː",
  dʒ: "dʒ", k: "k", l: "l", m: "m", n: "n", ŋ: "ŋ",
  oʊ: "oʊ", ɔɪ: "ɔɪ", p: "p", ɹ: "ɹ", s: "s", ʃ: "ʃ",
  t: "t", θ: "θ", ʊ: "ʊ", uː: "uː", v: "v", w: "w",
  j: "j", z: "z", ʒ: "ʒ",
  ə: "ʌ", // reduced schwa
  ᵻ: "ɪ", // espeak's "barred i" — reduced /ɪ/
  ʔ: "t", // glottal-stop realization of /t/ (e.g. "cotton")
  ɔː: "ɑː", // /ɔ/ (cot-caught merger)
  ɜː: "ɚ", // NURSE vowel spelled without its rhotic glide (e.g. "world")
  i: "iː", // unstressed short "happY" vowel (e.g. word-final "-y" in "very")
  // espeak shortens a long vowel's citation form (no "ː") in some unstressed/less-prominent
  // syllables (e.g. "stronger" -> "stɹɔŋɡɚ", not "...ɔːŋ...") — same vowel, same target.
  ɑ: "ɑː",
  u: "uː",
  ɔ: "ɑː",
  ɜ: "ɚ",
  ɐ: "ʌ", // another reduced/near-schwa vowel espeak uses in unstressed syllables (e.g. "along")
  oː: "ɑː", // NORTH/FORCE vowel before /r/ (e.g. "more") — monophthongal, not the OW diphthong
};

/** Sorted longest-symbol-first so multi-character IPA symbols (diphthongs, affricates, long
 * vowels) match before any single-character symbol that happens to be their prefix. */
const IPA_SYMBOLS = Object.keys(IPA_TO_CANONICAL).sort((a, b) => b.length - a.length);

/** Combining vertical line below (U+0329) — espeak's syllabicity diacritic, e.g. "cotton" ->
 * "kˈɑːʔn̩". Rewritten to an explicit preceding schwa before tokenizing, matching how espeak
 * already spells syllabic L directly as schwa + consonant (e.g. "little" -> "lˈɪɾəl") rather than
 * a diacritic. */
const SYLLABIC_MARK = /(.)̩/gu;

function tokenizeIpa(ipa: string): string[] {
  const cleaned = ipa.replace(/[ˈˌ]/gu, "").replace(SYLLABIC_MARK, "ə$1");
  const phones: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    if (cleaned[i] === " ") {
      i += 1;
      continue;
    }
    const symbol = IPA_SYMBOLS.find((s) => cleaned.startsWith(s, i));
    if (!symbol) {
      throw new Error(`No canonical-phone mapping for IPA symbol in "${cleaned}" at index ${i}`);
    }
    phones.push(IPA_TO_CANONICAL[symbol]!);
    i += symbol.length;
  }
  return phones;
}

/**
 * G2P's the turn's transcript into a word-aligned canonical IPA phone sequence (wav2vec2's own
 * vocabulary), used as the "expected" reference the pronunciation-scoring service diffs the actual
 * audio against. `phonemizer` is called once per word — not once per transcript — so a numeral or
 * other multi-token expansion (e.g. "1995" -> "nineteen hundred ninety five") still resolves to
 * exactly one `CanonicalWord`, keeping phones word-index-aligned with the transcript for the
 * caller.
 */
export async function g2p(transcript: string): Promise<CanonicalWord[]> {
  const words = transcript.match(WORD_PATTERN) ?? [];
  const canonicalWords: CanonicalWord[] = [];
  for (const word of words) {
    const [ipa] = await phonemize(word, "en-us");
    canonicalWords.push({ word, phones: tokenizeIpa(ipa ?? "") });
  }
  return canonicalWords;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/server && npx vitest run src/g2p.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git commit -- apps/server/src/g2p.ts apps/server/src/g2p.test.ts -m "Emit wav2vec2's own IPA vocabulary from g2p.ts instead of ARPAbet"
```

---

### Task 2: `pronunciationRevisionDetector.test.ts` — update the hardcoded ARPAbet literal

**Files:**
- Test: `apps/server/src/pronunciationRevisionDetector.test.ts`

**Interfaces:**
- Consumes: `g2p` from Task 1 (already changed) — `detectAsrSmoothedDeviations` itself (`apps/server/src/pronunciationRevisionDetector.ts`) does plain positional diffing over whatever `g2p()` returns and needs no code change.

- [ ] **Step 1: Run the suite to confirm it currently fails**

Run: `cd apps/server && npx vitest run src/pronunciationRevisionDetector.test.ts`
Expected: FAIL on `"flags a word Flux revised..."` — `expectedPhoneme`/`spokenPhoneme` are asserted as `"V"`/`"B"` but Task 1's `g2p()` now returns lowercase IPA `"v"`/`"b"` for "very"/"berry" (verified: `g2p("very")` -> `[v, ɛ, ɹ, iː]`, `g2p("berry")` -> `[b, ɛ, ɹ, iː]`, differing only at index 0).

- [ ] **Step 2: Update the literal**

In `apps/server/src/pronunciationRevisionDetector.test.ts`, replace the first test:

```typescript
  it("flags a word Flux revised to a phonetically close real word by EndOfTurn", async () => {
    const result = await detectAsrSmoothedDeviations("I had a very good day", [
      "I had a berry good day",
    ]);

    expect(result).toEqual([
      {
        word: "very",
        op: "sub",
        expectedPhoneme: "v",
        spokenPhoneme: "b",
        source: "transcript_revision",
      },
    ]);
  });
```

(The other 5 tests have no ARPAbet literals and are unchanged.)

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd apps/server && npx vitest run src/pronunciationRevisionDetector.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 4: Commit**

```bash
git commit -- apps/server/src/pronunciationRevisionDetector.test.ts -m "Update pronunciationRevisionDetector test fixture to wav2vec2 IPA"
```

---

### Task 3: `handler.py` — drop the comparison-scoring pass

**Files:**
- Modify: `apps/pronunciation-service/handler.py`
- Test: `apps/pronunciation-service/tests/test_handler.py`

**Interfaces:**
- Consumes: `Recognizer`, `decode_audio`, `load_waveform`, `score_pronunciation` from `pipeline.py` (unchanged); `CanonicalWord`, `ScoreResponse` from `schemas.py` (unchanged).
- Produces: `handle_score_request(recognizer: Recognizer, audio_bytes: bytes, canonical_phones_json: str, authorization: str | None, expected_token: str) -> ScoreResponse` (drops the `comparison_recognizer` parameter) — consumed by `modal_app.py` in Task 4.

- [ ] **Step 1: Update the failing test file**

Replace `apps/pronunciation-service/tests/test_handler.py` in full:

```python
import json
from pathlib import Path

import pytest

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from schemas import PronunciationEditOp, ScoreResponse

CANONICAL_JSON = json.dumps([{"word": "hi", "phones": ["h", "aɪ"]}])


# `object()` stands in for the recognizer argument in tests that only exercise the auth/parsing
# short-circuits, which raise before `recognizer` is ever touched — it deliberately doesn't
# satisfy the structural `Recognizer` protocol, hence the ty ignore below.


def test_handle_score_request_rejects_a_missing_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            CANONICAL_JSON,
            None,
            "secret-token",
        )


def test_handle_score_request_rejects_a_wrong_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            CANONICAL_JSON,
            "Bearer wrong-token",
            "secret-token",
        )


def test_handle_score_request_rejects_malformed_canonical_phones_json():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            "not json",
            "Bearer secret-token",
            "secret-token",
        )


def test_handle_score_request_rejects_canonical_phones_missing_required_fields():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            json.dumps([{"word": "hi"}]),
            "Bearer secret-token",
            "secret-token",
        )


def test_handle_score_request_returns_edit_ops_on_success(monkeypatch):
    monkeypatch.setattr("handler.decode_audio", lambda _audio_bytes: Path("/tmp/turn.wav"))
    monkeypatch.setattr("handler.load_waveform", lambda _wav_path: object())
    monkeypatch.setattr(
        "handler.score_pronunciation",
        lambda _recognizer, _waveform, _words: [
            PronunciationEditOp(
                word="hi", wordIndex=0, op="sub", expectedPhoneme="aɪ", spokenPhoneme="eɪ"
            )
        ],
    )

    result = handle_score_request(
        object(),  # ty: ignore[invalid-argument-type]
        b"audio",
        CANONICAL_JSON,
        "Bearer secret-token",
        "secret-token",
    )

    assert isinstance(result, ScoreResponse)
    assert len(result.editOps) == 1
    assert result.editOps[0].op == "sub"
    assert result.editOps[0].expectedPhoneme == "aɪ"
    assert result.editOps[0].spokenPhoneme == "eɪ"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_handler.py -v`
Expected: FAIL — `handle_score_request()` still requires a `comparison_recognizer` positional argument, so every call raises `TypeError`.

- [ ] **Step 3: Update `handler.py`**

Replace `apps/pronunciation-service/handler.py` in full:

```python
import json

from pydantic import ValidationError

from pipeline import Recognizer, decode_audio, load_waveform, score_pronunciation
from schemas import CanonicalWord, ScoreResponse


class UnauthorizedError(Exception):
    pass


class InvalidRequestError(Exception):
    pass


def handle_score_request(
    recognizer: Recognizer,
    audio_bytes: bytes,
    canonical_phones_json: str,
    authorization: str | None,
    expected_token: str,
) -> ScoreResponse:
    """Runs the full `/score` request: auth check, request parsing, the decode/score pipeline
    against `recognizer`, and response construction. Framework-agnostic — the caller
    (`modal_app.py`) translates the exceptions raised here to HTTP status codes.
    """
    if authorization != f"Bearer {expected_token}":
        raise UnauthorizedError("invalid or missing bearer token")

    try:
        raw = json.loads(canonical_phones_json)
        words = [CanonicalWord(**word) for word in raw]
    except (json.JSONDecodeError, TypeError, ValidationError) as exc:
        raise InvalidRequestError(str(exc)) from exc

    wav_path = decode_audio(audio_bytes)
    try:
        waveform = load_waveform(wav_path)
        edit_ops = score_pronunciation(recognizer, waveform, words)
    finally:
        wav_path.unlink(missing_ok=True)

    return ScoreResponse(editOps=edit_ops)
```

`import logging` and the module-level `logger` are dropped along with the comparison block — it was the only thing in this file that ever logged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_handler.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git commit -- apps/pronunciation-service/handler.py apps/pronunciation-service/tests/test_handler.py -m "Drop comparison-scoring pass from handle_score_request"
```

---

### Task 4: `modal_app.py` — one recognizer, one download function

**Files:**
- Modify: `apps/pronunciation-service/modal_app.py`

**Interfaces:**
- Consumes: `handle_score_request(recognizer, audio_bytes, canonical_phones_json, authorization, expected_token)` from Task 3; `Wav2Vec2XlsrRecognizer` from `models.py` (unchanged in this task, `HuperRecognizer` deleted in Task 5).

No test file — `modal_app.py` has no unit tests today (Modal's `@app.cls`/`@modal.asgi_app` decorators aren't unit-testable without a live Modal container; this precedent is unchanged by the cutover). Verified via the type checker and linter instead.

- [ ] **Step 1: Update `modal_app.py`**

Replace `apps/pronunciation-service/modal_app.py` in full:

```python
import os

import modal
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from models import Wav2Vec2XlsrRecognizer
from schemas import ScoreResponse


def _download_recognizer() -> None:
    # Both imports below are only installed inside the Modal image, not the local venv.
    from huggingface_hub import hf_hub_download  # ty: ignore[unresolved-import]
    from transformers import (  # ty: ignore[unresolved-import]
        Wav2Vec2FeatureExtractor,
        Wav2Vec2ForCTC,
    )

    repo_id = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
    Wav2Vec2FeatureExtractor.from_pretrained(repo_id)
    Wav2Vec2ForCTC.from_pretrained(repo_id)
    hf_hub_download(repo_id, "vocab.json")


image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.14.0",
        "torchaudio==2.11.0",
        "soundfile==0.14.0",
        "transformers==5.16.1",
        "huggingface-hub==1.30.0",
        "fastapi==0.141.1",
        "python-multipart==0.0.32",
        "pydantic==2.13.5",
    )
    .add_local_python_source("handler", "models", "pipeline", "schemas", copy=True)
    .run_function(_download_recognizer)
)

app = modal.App("kalli-pronunciation-service", image=image)
auth_secret = modal.Secret.from_name("pronunciation-service-auth")


@app.cls(gpu="T4", secrets=[auth_secret], min_containers=0)
class PronunciationService:
    @modal.enter()
    def load(self) -> None:
        self.recognizer = Wav2Vec2XlsrRecognizer()

    @modal.asgi_app()
    def web(self) -> FastAPI:
        # @modal.fastapi_endpoint has no path parameter - it always serves at the URL root, which
        # doesn't match the already-shipped TS adapter's fixed `POST {url}/score` contract. A
        # manually-built FastAPI app under @modal.asgi_app lets /score be an explicit route instead
        # of changing that contract to fit the decorator's default.
        web_app = FastAPI()

        @web_app.post("/score")
        async def score(
            audio: UploadFile = File(...),
            canonical_phones: str = Form(...),
            authorization: str | None = Header(None),
        ) -> ScoreResponse:
            try:
                return handle_score_request(
                    self.recognizer,
                    await audio.read(),
                    canonical_phones,
                    authorization,
                    os.environ["PRONUNCIATION_SERVICE_TOKEN"],
                )
            except UnauthorizedError as exc:
                raise HTTPException(status_code=401, detail=str(exc)) from exc
            except InvalidRequestError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except Exception as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc

        return web_app
```

This drops: the `arpabet_to_ipa` import and its startup vocab-coverage assert (redundant now — see the spec's Error handling section, the same `ValueError` propagates to the catch-all `except Exception` below instead of being silently swallowed); `_download_comparison_recognizer` and its call; `HuperRecognizer`'s download function and image dependency; and the `logging.basicConfig`/`getLogger("handler").setLevel(...)` setup, which existed solely to guarantee `handler.py`'s comparison-scoring `logger.info` line wasn't dropped — `handler.py` has no logging left after Task 3.

- [ ] **Step 2: Verify — this will fail until Task 5 deletes `HuperRecognizer`**

Run: `cd apps/pronunciation-service && uv run ty check .`
Expected: at this point still PASS — `models.py` still defines both classes, `modal_app.py` just no longer imports `HuperRecognizer`. Also run `uv run pytest` (all existing tests) and `uv run ruff check .` — expect PASS on both (no test imports `modal_app.py`'s deleted names).

- [ ] **Step 3: Commit**

```bash
git commit -- apps/pronunciation-service/modal_app.py -m "Serve only wav2vec2-xlsr-53 from modal_app.py"
```

---

### Task 5: `models.py` — delete `HuperRecognizer`

**Files:**
- Modify: `apps/pronunciation-service/models.py`
- Modify: `apps/pronunciation-service/pipeline.py` (one-line docstring fix)

**Interfaces:**
- Produces: `Wav2Vec2XlsrRecognizer` (unchanged signature, docstring loses its comparison-only framing) — already consumed by `modal_app.py` (Task 4).

No test file — neither recognizer class has unit coverage (verified via manual smoke test against real audio and the live deploy, same precedent `HuperRecognizer` set). Verified via the full test suite, linter, and type checker.

- [ ] **Step 1: Update `models.py`**

Replace `apps/pronunciation-service/models.py` in full:

```python
class Wav2Vec2XlsrRecognizer:
    """Wraps facebook/wav2vec2-xlsr-53-espeak-cv-ft — loads only the feature extractor and CTC
    model, not the full Wav2Vec2Processor, to avoid that class's Wav2Vec2PhonemeCTCTokenizer
    pulling in the `phonemizer` package and an `espeak-ng` binary this use case never needs (only
    score_pronunciation's log-probs-based scoring is used here, never phonemizer's text-to-phoneme
    encoding).
    """

    # DX/flap tolerance for /d/ and /t/, in this model's lowercase IPA vocabulary — ɾ is the flap
    # symbol (see g2p.ts's IPA_TO_CANONICAL table).
    acceptable_realizations: dict[str, set[str]] = {
        "d": {"ɾ"},
        "t": {"ɾ"},
    }

    def __init__(self, repo_id: str = "facebook/wav2vec2-xlsr-53-espeak-cv-ft") -> None:
        import json

        import torch
        from huggingface_hub import hf_hub_download  # ty: ignore[unresolved-import]
        from transformers import (  # ty: ignore[unresolved-import]
            Wav2Vec2FeatureExtractor,
            Wav2Vec2ForCTC,
        )

        self.feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(repo_id)
        self.model = Wav2Vec2ForCTC.from_pretrained(repo_id)
        self.model.eval()
        assert self.model.config.pad_token_id == 0, (
            "score_pronunciation's forced_align call hardcodes blank=0 — this recognizer's "
            "pad/blank token must be id 0 for that to be correct"
        )
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)

        vocab_path = hf_hub_download(repo_id, "vocab.json")
        with open(vocab_path) as f:
            self.label2id: dict[str, int] = json.load(f)
        self.id2label: dict[int, str] = {id_: label for label, id_ in self.label2id.items()}

        # Derived from the model's own config rather than hardcoding the special tokens' literal
        # string content. vocab.json's ids 0-3 turned out to be the distinct strings "<pad>",
        # "<s>", "</s>", "<unk>" (392 total entries, no collapse) — reading them back out through
        # id2label is correct regardless, so no assumption about their literal spelling is baked
        # in here. unk_token_id isn't a Wav2Vec2Config field, so it's read off the model config
        # with a default of None (mirrors HuPER's non_phone_tokens including "<UNK>").
        non_phone_ids = {
            self.model.config.pad_token_id,
            self.model.config.bos_token_id,
            self.model.config.eos_token_id,
            getattr(self.model.config, "unk_token_id", None),
        }
        self.non_phone_tokens: frozenset[str] = frozenset(
            self.id2label[id_] for id_ in non_phone_ids if id_ in self.id2label
        )

    def log_probs(self, waveform):
        """Returns log-softmax'd per-frame class log-probabilities for a 16kHz mono waveform,
        shape (1, T, C)."""
        import torch
        import torch.nn.functional as F

        inputs = self.feature_extractor(waveform, sampling_rate=16000, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with torch.no_grad():
            logits = self.model(**inputs).logits
        return F.log_softmax(logits, dim=-1).cpu()
```

- [ ] **Step 2: Fix the stale docstring reference in `pipeline.py`**

In `apps/pronunciation-service/pipeline.py`, in the `Recognizer` Protocol's docstring, change:

```python
    """What score_pronunciation needs from a phone-recognition model — satisfied structurally by
    models.py's HuperRecognizer and Wav2Vec2XlsrRecognizer, with no inheritance relationship
    required."""
```

to:

```python
    """What score_pronunciation needs from a phone-recognition model — satisfied structurally by
    models.py's Wav2Vec2XlsrRecognizer, with no inheritance relationship required."""
```

- [ ] **Step 3: Verify**

Run: `cd apps/pronunciation-service && uv run pytest && uv run ruff check . && uv run ty check .`
Expected: PASS on all three (nothing imports `HuperRecognizer` anymore after Task 4).

- [ ] **Step 4: Commit**

```bash
git commit -- apps/pronunciation-service/models.py apps/pronunciation-service/pipeline.py -m "Delete HuperRecognizer"
```

---

### Task 6: Delete `arpabet_to_ipa.py`

**Files:**
- Delete: `apps/pronunciation-service/arpabet_to_ipa.py`
- Delete: `apps/pronunciation-service/tests/test_arpabet_to_ipa.py`

**Interfaces:** none — nothing imports `arpabet_to_ipa` after Tasks 3 and 4.

- [ ] **Step 1: Delete both files**

```bash
trash apps/pronunciation-service/arpabet_to_ipa.py apps/pronunciation-service/tests/test_arpabet_to_ipa.py
```

- [ ] **Step 2: Verify**

Run: `cd apps/pronunciation-service && uv run pytest && uv run ruff check . && uv run ty check .`
Expected: PASS on all three.

- [ ] **Step 3: Commit**

```bash
git add -A apps/pronunciation-service/arpabet_to_ipa.py apps/pronunciation-service/tests/test_arpabet_to_ipa.py
git commit -m "Delete arpabet_to_ipa.py — no more ARPAbet round-trip"
```

---

### Task 7: Doc updates — `schemas.py` and `README.md`

**Files:**
- Modify: `apps/pronunciation-service/schemas.py`
- Modify: `apps/pronunciation-service/README.md`

**Interfaces:** none — doc/comment-only changes, no behavior change.

- [ ] **Step 1: Update `schemas.py`'s `CanonicalWord` docstring**

In `apps/pronunciation-service/schemas.py`, change:

```python
class CanonicalWord(BaseModel):
    """One transcript word and its canonical ARPAbet phones, matching `apps/server/src/g2p.ts`'s
    `CanonicalWord` shape exactly."""
```

to:

```python
class CanonicalWord(BaseModel):
    """One transcript word and its canonical wav2vec2-xlsr-53-espeak-cv-ft IPA phones, matching
    `apps/server/src/g2p.ts`'s `CanonicalWord` shape exactly."""
```

- [ ] **Step 2: Rewrite `README.md`**

Replace `apps/pronunciation-service/README.md` in full:

```markdown
# apps/pronunciation-service

Modal-hosted pronunciation-scoring service, using `facebook/wav2vec2-xlsr-53-espeak-cv-ft` and
Goodness-of-Pronunciation scoring. See
`docs/superpowers/specs/2026-09-05-pronunciation-service-modal-design.md` (original service
scaffolding), `docs/superpowers/specs/2026-09-08-gop-pronunciation-scoring-design.md` (the scoring
approach), and `docs/superpowers/specs/2026-09-10-wav2vec2-cutover-design.md` (why this is the
served recognizer instead of `huper29/huper_recognizer`) for the design.

## Local development

```bash
uv sync
uv run pytest
uv run ruff check .
uv run ty check .
```

## Deploying

```bash
uv run modal deploy modal_app.py
```

Run it via `uv run` — `modal_app.py` imports `fastapi` at module load time (needed locally to define
the app before it ships to the container), so it must run inside this project's `uv`-managed venv,
not a bare `modal` install.

Prints a URL ending in `.modal.run` — set that as `PRONUNCIATION_SERVICE_URL` in `apps/server`'s
Fly secrets (`fly secrets set PRONUNCIATION_SERVICE_URL=...`).

## Secrets

- `pronunciation-service-auth` (Modal secret, holds `PRONUNCIATION_SERVICE_TOKEN`): create with
  `uv run modal secret create pronunciation-service-auth PRONUNCIATION_SERVICE_TOKEN=<token>`. The
  same token value must also be set as `PRONUNCIATION_SERVICE_TOKEN` in `apps/server`'s Fly secrets
  — this service and `apps/server` share one static bearer token, checked on every `/score` request.
```

- [ ] **Step 3: Verify**

Run: `cd apps/pronunciation-service && uv run pytest && uv run ruff check .`
Expected: PASS on both (doc-only change).

- [ ] **Step 4: Commit**

```bash
git commit -- apps/pronunciation-service/schemas.py apps/pronunciation-service/README.md -m "Update docs to reflect wav2vec2 as the sole recognizer"
```

---

### Task 8: Delete dead `_debug_predict.py`

**Files:**
- Delete: `apps/pronunciation-service/_debug_predict.py`

**Interfaces:** none — this file is already dead. It imports `MODEL_DIR` from `modal_app.py` (no longer defined there — removed in an earlier migration) and `HuperCorrector` from `models.py` (already removed in that same earlier migration, before this plan). It has been untracked cruft in every git status this session; noticed while touching this area, unrelated to the wav2vec2 cutover itself.

- [ ] **Step 1: Delete the file**

```bash
trash apps/pronunciation-service/_debug_predict.py
```

- [ ] **Step 2: Verify**

Run: `cd apps/pronunciation-service && uv run pytest && uv run ruff check . && uv run ty check .`
Expected: PASS on all three (the file was never imported by anything that runs).

- [ ] **Step 3: Commit**

```bash
git add -A apps/pronunciation-service/_debug_predict.py
git commit -m "Delete dead _debug_predict.py"
```
