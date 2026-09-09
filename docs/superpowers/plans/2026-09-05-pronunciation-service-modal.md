# Pronunciation Service (Modal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/pronunciation-service/`, a Modal-hosted Python service running the HuPER
Corrector that satisfies the already-shipped TS adapter's HTTP contract (`POST /score`), plus the
small TS-side follow-up (nullable `expectedPhoneme`) the design surfaced as needed.

**Architecture:** A single Modal `@app.cls()` GPU class loads one model
(`edit_seq_speech.inference.PhonemeCorrectionInference`, from `huper29/huper_corrector`, baked into
the image at build time) once via `@modal.enter()`, and exposes one `@modal.fastapi_endpoint`
method. That method is a thin translator: it delegates to `handler.py`'s pure
`handle_score_request` (auth check → parse → call `pipeline.py` → build the response) and converts
its typed exceptions to HTTP status codes. `pipeline.py`'s functions (`decode_audio`,
`run_corrector`, `to_edit_ops`) and `handler.py` have no Modal imports, so all of them are testable
with plain pytest and a fake model object — no GPU, no real checkpoint, no Modal runtime needed to
run the test suite.

**Tech Stack:** Python 3.13, `uv`, `modal`, `fastapi`, `pydantic`, `pytest`, `ruff`, `ty`, `ffmpeg`
(subprocess). TS side: existing stack (TypeScript, Drizzle, Vitest, zod).

**Spec:** `docs/superpowers/specs/2026-09-05-pronunciation-service-modal-design.md`

## Global Constraints

- Python side: `uv` for deps/venv, `ruff check`/`ruff format`, `ty check`, `pytest` — exact pinned
  versions only (no `^`/`~`): `modal==1.5.5`, `fastapi==0.141.1`, `pydantic==2.13.5`,
  `python-multipart==0.0.32`, `pytest==9.1.1`, `ruff==0.16.6`, `ty==0.0.78` (local dev/test venv);
  `torch==2.14.0`, `transformers==5.16.1`, `huggingface-hub==1.30.0` (Modal image only — never
  imported by code that runs outside the container, so not local deps; see Task 2).
- Python tests live under `apps/pronunciation-service/tests/`, mirroring package structure — not
  colocated (`*.test.ts` colocation is TS-specific).
- TS side: ESM only, Node 22 LTS, this repo's existing relative-import style (`./foo.js`, explicit
  `.js` extensions), exact dependency versions, ≤100 lines/function, cyclomatic complexity ≤8,
  100-char line length — all pre-existing repo conventions, unchanged by this plan.
- Mock only external boundaries: on the TS side, HTTP/vendor calls (already the existing pattern).
  On the Python side, the loaded model (`HuperCorrector`/`PhonemeCorrectionInference`) — everything
  else (`decode_audio`, `to_edit_ops`, `handle_score_request`'s auth/parsing logic) runs for real
  against real or fixture inputs.
- No CI/CD automation for `modal deploy` — a documented manual step (Task 8).

---

## Task 1: TS-side follow-up — nullable `expectedPhoneme`

**Files:**
- Modify: `packages/types/src/index.ts:75-82` (`DetectedPronunciationError`)
- Modify: `apps/server/src/db/schema.ts:74-83` (`turnPronunciationErrors`)
- Modify: `apps/server/src/pronunciation.ts` (`editOpSchema`)
- Modify: `apps/server/src/llm.ts:215-229` (`buildPronunciationErrorContext`)
- Test: `apps/server/src/db/schema.test.ts`
- Test: `apps/server/src/pronunciation.test.ts`
- Test: `apps/server/src/llm.test.ts`
- Create: a new Drizzle migration under `apps/server/drizzle/` (via `pnpm db:generate`)

**Interfaces:**
- Produces: `DetectedPronunciationError.expectedPhoneme: string | null` — consumed downstream by
  the Modal service's response contract (Task 3's `PronunciationEditOp.expectedPhoneme`), which an
  `ins` op reports as `None`.

- [ ] **Step 1: Widen the shared type**

Edit `packages/types/src/index.ts`, in `DetectedPronunciationError`:

```ts
export interface DetectedPronunciationError {
  word: string;
  op: PronunciationEditOpKind;
  /** The canonical phoneme, or `null` for an inserted phone with no canonical counterpart. */
  expectedPhoneme: string | null;
  /** The phoneme actually realized in the audio, or `null` for a deletion (nothing was spoken in
   * its place). */
  spokenPhoneme: string | null;
  source: PronunciationErrorSource;
}
```

- [ ] **Step 2: Write the failing schema test**

Add to `apps/server/src/db/schema.test.ts`, inside `describe("turnPronunciationErrors", ...)`,
after the existing `"allows a null spokenPhoneme for a deletion"` test:

```ts
  it("allows a null expectedPhoneme for an insertion", async () => {
    const [session] = await db.insert(sessions).values({ clerkUserId: "test-user-schema-3" }).returning();
    if (!session) throw new Error("Failed to insert session");
    const [turn] = await db
      .insert(turns)
      .values({ sessionId: session.id, transcript: "I like it a lot", reply: "..." })
      .returning();
    if (!turn) throw new Error("Failed to insert turn");

    const [error] = await db
      .insert(turnPronunciationErrors)
      .values({
        turnId: turn.id,
        word: "like",
        op: "ins",
        expectedPhoneme: null,
        spokenPhoneme: "AH",
        source: "audio",
      })
      .returning();

    expect(error?.expectedPhoneme).toBeNull();
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/server && pnpm exec vitest run src/db/schema.test.ts`
Expected: FAIL — Postgres rejects the insert (`expected_phoneme` is `NOT NULL`).

- [ ] **Step 4: Drop the NOT NULL constraint and generate the migration**

Edit `apps/server/src/db/schema.ts`, in `turnPronunciationErrors`:

```ts
  expectedPhoneme: text("expected_phoneme"),
```

(remove `.notNull()` — it's currently `text("expected_phoneme").notNull()`)

Run: `cd apps/server && pnpm db:generate`
Expected: a new file appears under `apps/server/drizzle/` altering `expected_phoneme` to drop
`NOT NULL`. Safe with no backfill: `turn_pronunciation_errors` has zero rows in any environment
today (`PRONUNCIATION_SERVICE_URL` is unset, nothing has ever inserted into it).

Run: `pnpm db:migrate`
Expected: migration applies cleanly against the local dev/test databases.

- [ ] **Step 5: Run the schema test to verify it passes**

Run: `pnpm exec vitest run src/db/schema.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Write the failing pronunciation-adapter test**

Add to `apps/server/src/pronunciation.test.ts`, after the existing multipart-POST test:

```ts
  it("round-trips a null expectedPhoneme for an insertion", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    global.fetch = vi.fn(async () =>
      jsonResponse({
        editOps: [
          { word: "like", wordIndex: 0, op: "ins", expectedPhoneme: null, spokenPhoneme: "AH" },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES);

    expect(result).toEqual([
      { word: "like", wordIndex: 0, op: "ins", expectedPhoneme: null, spokenPhoneme: "AH" },
    ]);
  });
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm exec vitest run src/pronunciation.test.ts`
Expected: FAIL — `editOpSchema` rejects `expectedPhoneme: null` (currently `z.string().max(50)`,
not nullable).

- [ ] **Step 8: Widen the zod schema**

Edit `apps/server/src/pronunciation.ts`, in `editOpSchema`:

```ts
const editOpSchema = z.object({
  word: z.string().max(200),
  wordIndex: z.number().int().nonnegative(),
  op: z.enum(PRONUNCIATION_EDIT_OPS),
  expectedPhoneme: z.string().max(50).nullable(),
  spokenPhoneme: z.string().max(50).nullable(),
});
```

Also update the `PronunciationEditOp` interface immediately above it (same file) so its
`expectedPhoneme: string` becomes `expectedPhoneme: string | null`.

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm exec vitest run src/pronunciation.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 10: Write the failing prompt-builder test**

Add to `apps/server/src/llm.test.ts`, inside `describe("generateReply with pronunciation errors", ...)`,
after the existing `"phrases a transcript-revision-sourced error more tentatively..."` test:

```ts
  it("phrases a null expectedPhoneme as 'expected nothing here' for an insertion", async () => {
    aiTestState.streamTextCalls.length = 0;
    const provider = getLLMProvider();

    const stream = provider.generateReply(
      [{ role: "user", content: "he likesa it" }],
      [],
      [{ word: "likes", op: "ins", expectedPhoneme: null, spokenPhoneme: "AH", source: "audio" }],
      SAMPLE_SYSTEM_PROMPT,
    );
    for await (const _ of stream.textStream) {
      // drain
    }

    const call = aiTestState.streamTextCalls.at(-1);
    const lastMessage = call?.messages?.at(-1);
    const content = lastMessage?.content;
    const text = (content as { text: string }[]).map((part) => part.text).join("");
    expect(text).toContain("expected nothing here");
  });
```

- [ ] **Step 11: Run the test to verify it fails**

Run: `pnpm exec vitest run src/llm.test.ts`
Expected: FAIL — the template literal renders `null` as the string `"null"`, producing
`"expected /null/, ..."`, not `"expected nothing here"`.

- [ ] **Step 12: Update `buildPronunciationErrorContext`**

Edit `apps/server/src/llm.ts`:

```ts
function buildPronunciationErrorContext(errors: DetectedPronunciationError[]): string {
  if (errors.length === 0) return "";
  const errorList = errors
    .map((error) => {
      const spoken = error.spokenPhoneme ?? "(nothing)";
      const expected =
        error.expectedPhoneme === null ? "expected nothing here" : `expected /${error.expectedPhoneme}/`;
      const evidence =
        error.source === "audio"
          ? `${expected}, said /${spoken}/`
          : `${expected}, may have said /${spoken}/ (inferred from the transcript revising ` +
            `itself mid-turn, not confirmed against the audio)`;
      return `- "${error.word}": ${evidence} (${error.op})`;
    })
    .join("\n");
  return `\n\nFlagged pronunciation errors in the message above:\n${errorList}`;
}
```

- [ ] **Step 13: Run the test to verify it passes**

Run: `pnpm exec vitest run src/llm.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 14: Typecheck and lint**

Run: `pnpm --filter @kalli/server typecheck && pnpm --filter @kalli/server exec oxlint src/db/schema.ts src/pronunciation.ts src/llm.ts`
Run: `pnpm --filter @kalli/types typecheck` (or the repo's equivalent full typecheck — `packages/types` has no build step of its own beyond `tsc`)
Expected: no errors.

- [ ] **Step 15: Commit**

```bash
git add packages/types/src/index.ts apps/server/src/db/schema.ts apps/server/drizzle/ \
  apps/server/src/pronunciation.ts apps/server/src/llm.ts apps/server/src/db/schema.test.ts \
  apps/server/src/pronunciation.test.ts apps/server/src/llm.test.ts
git commit -m "Make expectedPhoneme nullable for pronunciation insertion errors"
```

---

## Task 2: Python project scaffold

**Files:**
- Create: `apps/pronunciation-service/pyproject.toml`
- Create: `apps/pronunciation-service/.python-version`
- Create: `apps/pronunciation-service/tests/__init__.py` (empty — see note below)

**Interfaces:** None yet — this task only sets up tooling so later tasks' `uv run pytest`/
`ruff check`/`ty check` commands work.

- [ ] **Step 1: Create the directory and Python version file**

```bash
mkdir -p apps/pronunciation-service/tests
```

Write `apps/pronunciation-service/.python-version`:

```
3.13
```

- [ ] **Step 2: Write `pyproject.toml`**

```toml
[project]
name = "pronunciation-service"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = [
    "modal==1.5.5",
    "fastapi==0.141.1",
    "pydantic==2.13.5",
    "python-multipart==0.0.32",
]

[dependency-groups]
dev = [
    "pytest==9.1.1",
    "ruff==0.16.6",
    "ty==0.0.78",
]

[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]

[tool.ruff]
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[tool.ty.rules]
```

Note on why `torch`/`transformers`/`huggingface-hub` aren't listed here: they're only ever imported
inside `models.py`'s `HuperCorrector`, which is only exercised for real inside the Modal container
(built with those packages via `modal_app.py`'s own `Image.pip_install`, see Task 8). No test in
this plan imports `models.py` for real — `handler.py`'s tests use a fake `HuperCorrector`-shaped
stub — so the local dev venv never needs them. `tests/pythonpath = ["."]` lets `import pipeline`/
`import schemas`/etc. resolve from the project root without needing `__init__.py` files at the top
level.

- [ ] **Step 3: Install and verify the toolchain runs**

Run: `cd apps/pronunciation-service && uv sync`
Expected: creates `.venv/` and `uv.lock`, no errors.

Run: `uv run ruff check .`
Expected: passes (nothing to lint yet beyond this file).

Run: `uv run ty check .`
Expected: passes (nothing to check yet).

Run: `uv run pytest`
Expected: "no tests ran" (or equivalent) — no test files exist yet.

- [ ] **Step 4: Commit**

```bash
git add apps/pronunciation-service/pyproject.toml apps/pronunciation-service/.python-version \
  apps/pronunciation-service/uv.lock
git commit -m "Scaffold apps/pronunciation-service Python project"
```

---

## Task 3: `schemas.py` — wire-format models

**Files:**
- Create: `apps/pronunciation-service/schemas.py`
- Test: `apps/pronunciation-service/tests/test_schemas.py`

**Interfaces:**
- Produces: `CanonicalWord(word: str, phones: list[str])`, `PronunciationEditOp(word: str,
  wordIndex: int, op: Literal["sub", "del", "ins"], expectedPhoneme: str | None, spokenPhoneme: str
  | None)`, `ScoreResponse(editOps: list[PronunciationEditOp])` — consumed by Task 5
  (`to_edit_ops`'s return type) and Task 7 (`handler.py`).

- [ ] **Step 1: Write the failing tests**

```python
# apps/pronunciation-service/tests/test_schemas.py
import pytest
from pydantic import ValidationError

from schemas import CanonicalWord, PronunciationEditOp, ScoreResponse


def test_canonical_word_round_trips():
    word = CanonicalWord(word="like", phones=["L", "AY", "K"])
    assert word.word == "like"
    assert word.phones == ["L", "AY", "K"]


def test_pronunciation_edit_op_allows_null_expected_phoneme_for_insertion():
    op = PronunciationEditOp(
        word="like", wordIndex=0, op="ins", expectedPhoneme=None, spokenPhoneme="AH"
    )
    assert op.expectedPhoneme is None


def test_pronunciation_edit_op_rejects_unknown_op():
    with pytest.raises(ValidationError):
        PronunciationEditOp(
            word="like", wordIndex=0, op="bogus", expectedPhoneme="L", spokenPhoneme="R"
        )


def test_score_response_serializes_edit_ops_list():
    response = ScoreResponse(
        editOps=[
            PronunciationEditOp(
                word="like", wordIndex=0, op="sub", expectedPhoneme="L", spokenPhoneme="R"
            )
        ]
    )
    assert response.model_dump() == {
        "editOps": [
            {
                "word": "like",
                "wordIndex": 0,
                "op": "sub",
                "expectedPhoneme": "L",
                "spokenPhoneme": "R",
            }
        ]
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_schemas.py -v`
Expected: FAIL with "No module named 'schemas'"

- [ ] **Step 3: Implement `schemas.py`**

```python
# apps/pronunciation-service/schemas.py
from typing import Literal

from pydantic import BaseModel


class CanonicalWord(BaseModel):
    """One transcript word and its canonical ARPAbet phones, matching `apps/server/src/g2p.ts`'s
    `CanonicalWord` shape exactly."""

    word: str
    phones: list[str]


class PronunciationEditOp(BaseModel):
    """One detected pronunciation deviation, matching the wire contract
    `apps/server/src/pronunciation.ts` already validates against."""

    word: str
    wordIndex: int
    op: Literal["sub", "del", "ins"]
    expectedPhoneme: str | None
    spokenPhoneme: str | None


class ScoreResponse(BaseModel):
    editOps: list[PronunciationEditOp]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_schemas.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Lint and typecheck**

Run: `uv run ruff check schemas.py tests/test_schemas.py && uv run ty check schemas.py tests/test_schemas.py`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/pronunciation-service/schemas.py apps/pronunciation-service/tests/test_schemas.py
git commit -m "Add pronunciation-service wire-format schemas"
```

---

## Task 4: `pipeline.py` — `decode_audio`

**Files:**
- Create: `apps/pronunciation-service/pipeline.py`
- Create: `apps/pronunciation-service/tests/fixtures/sample.webm` (small fixture clip)
- Test: `apps/pronunciation-service/tests/test_pipeline.py`

**Interfaces:**
- Produces: `decode_audio(webm_bytes: bytes) -> Path` — consumed by Task 7 (`handler.py`).

**Note on the fixture:** `tests/fixtures/sample.webm` needs to be a short (under 1 second is fine)
real WebM/Opus-encoded clip. Generate one locally before writing the test, e.g.:
`ffmpeg -f lavfi -i "sine=frequency=440:duration=0.5" -c:a libopus apps/pronunciation-service/tests/fixtures/sample.webm`
(requires `ffmpeg` installed locally, matching what Task 6 installs in the container).

- [ ] **Step 1: Generate the fixture**

```bash
mkdir -p apps/pronunciation-service/tests/fixtures
ffmpeg -f lavfi -i "sine=frequency=440:duration=0.5" -c:a libopus \
  apps/pronunciation-service/tests/fixtures/sample.webm
```

- [ ] **Step 2: Write the failing test**

```python
# apps/pronunciation-service/tests/test_pipeline.py
import wave
from pathlib import Path

from pipeline import decode_audio

FIXTURE = Path(__file__).parent / "fixtures" / "sample.webm"


def test_decode_audio_produces_16khz_mono_wav():
    webm_bytes = FIXTURE.read_bytes()

    wav_path = decode_audio(webm_bytes)
    try:
        with wave.open(str(wav_path), "rb") as wav_file:
            assert wav_file.getframerate() == 16000
            assert wav_file.getnchannels() == 1
    finally:
        wav_path.unlink(missing_ok=True)


def test_decode_audio_raises_on_corrupt_input():
    import pytest

    with pytest.raises(RuntimeError, match="ffmpeg decode failed"):
        decode_audio(b"not a real audio file")
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -v`
Expected: FAIL with "No module named 'pipeline'"

- [ ] **Step 4: Implement `decode_audio` in `pipeline.py`**

```python
# apps/pronunciation-service/pipeline.py
import subprocess
import tempfile
from pathlib import Path


def decode_audio(webm_bytes: bytes) -> Path:
    """Decodes a WebM/Opus turn recording to a 16kHz mono WAV file at a temp path.

    The caller is responsible for deleting the returned path once done with it.
    """
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", str(tmp_path)],
        input=webm_bytes,
        capture_output=True,
    )
    if result.returncode != 0:
        tmp_path.unlink(missing_ok=True)
        stderr = result.stderr.decode(errors="replace")
        raise RuntimeError(f"ffmpeg decode failed: {stderr}")
    return tmp_path
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_pipeline.py -v`
Expected: PASS (2 tests) — requires `ffmpeg` on the local `PATH` (install via your OS package
manager, e.g. `brew install ffmpeg`, if `uv run pytest` reports `FileNotFoundError` for `ffmpeg`).

- [ ] **Step 6: Lint and typecheck**

Run: `uv run ruff check pipeline.py tests/test_pipeline.py && uv run ty check pipeline.py tests/test_pipeline.py`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/pronunciation-service/pipeline.py apps/pronunciation-service/tests/test_pipeline.py \
  apps/pronunciation-service/tests/fixtures/sample.webm
git commit -m "Add pronunciation-service audio decode"
```

---

## Task 5: `pipeline.py` — `to_edit_ops`

**Files:**
- Modify: `apps/pronunciation-service/pipeline.py`
- Test: `apps/pronunciation-service/tests/test_pipeline.py`

**Interfaces:**
- Consumes: `CanonicalWord`, `PronunciationEditOp` from Task 3 (`schemas.py`).
- Produces: `to_edit_ops(log: list[dict], canonical_phones: list[CanonicalWord]) ->
  list[PronunciationEditOp]` — consumed by Task 7 (`handler.py`).

This is the core, fully-grounded mapping logic: `log` is confirmed (from
`correction/inference.py` and the model's `vocab.json`, see the design spec) to be one dict per
canonical phone position, in the same order as the phones fed to `predict()`, each shaped
`{"src": str, "op": "KEEP" | "DEL" | "SUB:<PHONE>" | "SUB:<PAD>", "ins": "<NONE>" | "NONE" |
"<PAD>" | "<PHONE>"}`.

- [ ] **Step 1: Write the failing tests**

```python
# apps/pronunciation-service/tests/test_pipeline.py
# (add below the existing decode_audio tests)
from pipeline import to_edit_ops
from schemas import CanonicalWord

CANONICAL = [
    CanonicalWord(word="he", phones=["HH", "IY"]),
    CanonicalWord(word="likes", phones=["L", "AY", "K", "S"]),
]


def test_to_edit_ops_maps_a_clean_substitution():
    log = [
        {"src": "HH", "op": "KEEP", "ins": "<NONE>"},
        {"src": "IY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "L", "op": "SUB:R", "ins": "<NONE>"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert len(result) == 1
    assert result[0].word == "likes"
    assert result[0].wordIndex == 1
    assert result[0].op == "sub"
    assert result[0].expectedPhoneme == "L"
    assert result[0].spokenPhoneme == "R"


def test_to_edit_ops_maps_a_deletion_with_null_spoken_phoneme():
    log = [
        {"src": "HH", "op": "DEL", "ins": "<NONE>"},
        {"src": "IY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "L", "op": "KEEP", "ins": "<NONE>"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert len(result) == 1
    assert result[0].word == "he"
    assert result[0].wordIndex == 0
    assert result[0].op == "del"
    assert result[0].expectedPhoneme == "HH"
    assert result[0].spokenPhoneme is None


def test_to_edit_ops_maps_an_insertion_with_null_expected_phoneme():
    log = [
        {"src": "HH", "op": "KEEP", "ins": "<NONE>"},
        {"src": "IY", "op": "KEEP", "ins": "AH"},
        {"src": "L", "op": "KEEP", "ins": "<NONE>"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert len(result) == 1
    assert result[0].word == "he"
    assert result[0].op == "ins"
    assert result[0].expectedPhoneme is None
    assert result[0].spokenPhoneme == "AH"


def test_to_edit_ops_produces_two_entries_for_a_substitution_with_a_trailing_insertion():
    log = [
        {"src": "HH", "op": "KEEP", "ins": "<NONE>"},
        {"src": "IY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "L", "op": "SUB:R", "ins": "AH"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert len(result) == 2
    assert {(op.op, op.wordIndex) for op in result} == {("sub", 1), ("ins", 1)}


def test_to_edit_ops_ignores_pad_positions():
    log = [
        {"src": "HH", "op": "SUB:<PAD>", "ins": "<PAD>"},
        {"src": "IY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "L", "op": "KEEP", "ins": "<NONE>"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert result == []


def test_to_edit_ops_raises_on_log_length_mismatch():
    import pytest

    with pytest.raises(ValueError, match="does not match"):
        to_edit_ops([{"src": "HH", "op": "KEEP", "ins": "<NONE>"}], CANONICAL)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -v -k to_edit_ops`
Expected: FAIL with "cannot import name 'to_edit_ops' from 'pipeline'"

- [ ] **Step 3: Implement `to_edit_ops` in `pipeline.py`**

Add to `apps/pronunciation-service/pipeline.py` (alongside the existing `decode_audio`, add the
import at the top of the file):

```python
from schemas import CanonicalWord, PronunciationEditOp

_NO_INSERTION = {"<NONE>", "NONE", "<PAD>"}


def to_edit_ops(log: list[dict], canonical_phones: list[CanonicalWord]) -> list[PronunciationEditOp]:
    """Maps the Corrector's per-position edit log onto the wire-format edit-op list.

    `log` must have exactly one entry per canonical phone, in the same order the phones were
    flattened into the `text` passed to `predict()`.
    """
    positions = [
        (word.word, word_index)
        for word_index, word in enumerate(canonical_phones)
        for _ in word.phones
    ]
    if len(positions) != len(log):
        raise ValueError(
            f"log length {len(log)} does not match canonical phone count {len(positions)}"
        )

    ops: list[PronunciationEditOp] = []
    for (word_text, word_index), entry in zip(positions, log, strict=True):
        op = entry["op"]
        src = entry["src"]
        ins = entry["ins"]

        if op == "DEL":
            ops.append(
                PronunciationEditOp(
                    word=word_text, wordIndex=word_index, op="del",
                    expectedPhoneme=src, spokenPhoneme=None,
                )
            )
        elif op.startswith("SUB:") and op != "SUB:<PAD>":
            ops.append(
                PronunciationEditOp(
                    word=word_text, wordIndex=word_index, op="sub",
                    expectedPhoneme=src, spokenPhoneme=op.removeprefix("SUB:"),
                )
            )

        if ins not in _NO_INSERTION:
            ops.append(
                PronunciationEditOp(
                    word=word_text, wordIndex=word_index, op="ins",
                    expectedPhoneme=None, spokenPhoneme=ins,
                )
            )
    return ops
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_pipeline.py -v`
Expected: PASS (8 tests total in the file)

- [ ] **Step 5: Lint and typecheck**

Run: `uv run ruff check pipeline.py tests/test_pipeline.py && uv run ty check pipeline.py tests/test_pipeline.py`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/pronunciation-service/pipeline.py apps/pronunciation-service/tests/test_pipeline.py
git commit -m "Add pronunciation-service edit-op mapping"
```

---

## Task 6: `models.py` and `run_corrector`

**Files:**
- Create: `apps/pronunciation-service/models.py`
- Modify: `apps/pronunciation-service/pipeline.py` (add `run_corrector`)
- Test: `apps/pronunciation-service/tests/test_pipeline.py`

**Interfaces:**
- Produces: `HuperCorrector` (class with `checkpoint_path: str, vocab_path: str` constructor and a
  `predict(wav_path: str, text: str) -> tuple[list[str], list[dict]]` method) and
  `run_corrector(corrector: HuperCorrector, wav_path: Path, canonical_phones: list[CanonicalWord])
  -> list[dict]` — both consumed by Task 7 (`handler.py`), which supplies a real `HuperCorrector` in
  production and a duck-typed fake in tests.

- [ ] **Step 1: Write the failing test for `run_corrector`**

```python
# apps/pronunciation-service/tests/test_pipeline.py
# (add below the to_edit_ops tests)
from pipeline import run_corrector


class FakeCorrector:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def predict(self, wav_path: str, text: str) -> tuple[list[str], list[dict]]:
        self.calls.append((wav_path, text))
        return (["HH", "IY"], [{"src": "HH", "op": "KEEP", "ins": "<NONE>"}])


def test_run_corrector_joins_canonical_phones_into_a_space_separated_string():
    fake = FakeCorrector()
    canonical = [
        CanonicalWord(word="he", phones=["HH", "IY"]),
        CanonicalWord(word="likes", phones=["L", "AY", "K", "S"]),
    ]

    log = run_corrector(fake, Path("/tmp/turn.wav"), canonical)

    assert fake.calls == [("/tmp/turn.wav", "HH IY L AY K S")]
    assert log == [{"src": "HH", "op": "KEEP", "ins": "<NONE>"}]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -v -k run_corrector`
Expected: FAIL with "cannot import name 'run_corrector' from 'pipeline'"

- [ ] **Step 3: Implement `run_corrector` in `pipeline.py`**

Add to `apps/pronunciation-service/pipeline.py` (the `Path` and `Protocol` imports go at the top
alongside the existing ones):

```python
from typing import Protocol


class Corrector(Protocol):
    def predict(self, wav_path: str, text: str) -> tuple[list[str], list[dict]]: ...


def run_corrector(
    corrector: Corrector, wav_path: Path, canonical_phones: list[CanonicalWord]
) -> list[dict]:
    """Runs the Corrector against a turn's decoded audio and canonical phones, returning the
    per-position edit log (discards `final_phonemes`, which nothing downstream needs)."""
    text = " ".join(phone for word in canonical_phones for phone in word.phones)
    _final_phonemes, log = corrector.predict(str(wav_path), text)
    return log
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_pipeline.py -v -k run_corrector`
Expected: PASS (1 test)

- [ ] **Step 5: Implement `models.py`**

```python
# apps/pronunciation-service/models.py
class HuperCorrector:
    """Thin wrapper around `edit_seq_speech.inference.PhonemeCorrectionInference`.

    The import is deferred to `__init__` (rather than module level) because `edit_seq_speech` is
    bundled inside the `huper29/huper_corrector` Hugging Face repo and only present in the built
    Modal container image — never in the local dev/test venv (see Task 2's note).
    """

    def __init__(self, checkpoint_path: str, vocab_path: str) -> None:
        # ty: ignore[unresolved-import] -- bundled in the HF repo, present only in the Modal image
        from edit_seq_speech.inference import PhonemeCorrectionInference

        self._infer = PhonemeCorrectionInference(checkpoint_path=checkpoint_path, vocab_path=vocab_path)

    def predict(self, wav_path: str, text: str) -> tuple[list[str], list[dict]]:
        return self._infer.predict(wav_path, text)
```

- [ ] **Step 6: Lint and typecheck**

Run: `uv run ruff check models.py pipeline.py tests/test_pipeline.py`
Run: `uv run ty check models.py pipeline.py tests/test_pipeline.py`
Expected: `ruff` passes cleanly. `ty` may report an unresolved-import diagnostic for
`edit_seq_speech.inference` inside `models.py` (expected — that package doesn't exist locally). If
so, check `ty check`'s own diagnostic output for the exact rule name and confirm the inline
`# ty: ignore[...]` comment already in the code above matches it; adjust the bracketed rule name if
`ty`'s actual output names it differently.

- [ ] **Step 7: Commit**

```bash
git add apps/pronunciation-service/models.py apps/pronunciation-service/pipeline.py \
  apps/pronunciation-service/tests/test_pipeline.py
git commit -m "Add pronunciation-service Corrector wrapper and run_corrector"
```

---

## Task 7: `handler.py` — request orchestration

**Files:**
- Create: `apps/pronunciation-service/handler.py`
- Test: `apps/pronunciation-service/tests/test_handler.py`

**Interfaces:**
- Consumes: `HuperCorrector`-shaped objects (duck-typed via Task 6's `Corrector` protocol),
  `decode_audio`/`run_corrector`/`to_edit_ops` from Task 4/5/6 (`pipeline.py`), `CanonicalWord`/
  `ScoreResponse` from Task 3 (`schemas.py`).
- Produces: `UnauthorizedError`, `InvalidRequestError` (exception classes), `handle_score_request(
  corrector, audio_bytes: bytes, canonical_phones_json: str, authorization: str | None,
  expected_token: str) -> ScoreResponse` — consumed by Task 8 (`modal_app.py`).

This is the layer that makes auth/parsing/orchestration testable without Modal or FastAPI: it has
no imports from either.

- [ ] **Step 1: Write the failing tests**

```python
# apps/pronunciation-service/tests/test_handler.py
import json

import pytest

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from schemas import ScoreResponse


class FakeCorrector:
    def predict(self, wav_path: str, text: str) -> tuple[list[str], list[dict]]:
        # One canonical phone in, matching a single-word "hi" -> ["HH", "AY"] request below.
        return (["HH", "AY"], [
            {"src": "HH", "op": "KEEP", "ins": "<NONE>"},
            {"src": "AY", "op": "SUB:EY", "ins": "<NONE>"},
        ])


CANONICAL_JSON = json.dumps([{"word": "hi", "phones": ["HH", "AY"]}])


def test_handle_score_request_rejects_a_missing_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(FakeCorrector(), b"audio", CANONICAL_JSON, None, "secret-token")


def test_handle_score_request_rejects_a_wrong_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(
            FakeCorrector(), b"audio", CANONICAL_JSON, "Bearer wrong-token", "secret-token"
        )


def test_handle_score_request_rejects_malformed_canonical_phones_json():
    with pytest.raises(InvalidRequestError):
        handle_score_request(FakeCorrector(), b"audio", "not json", "Bearer secret-token", "secret-token")


def test_handle_score_request_rejects_canonical_phones_missing_required_fields():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            FakeCorrector(), b"audio", json.dumps([{"word": "hi"}]), "Bearer secret-token", "secret-token"
        )


def test_handle_score_request_returns_edit_ops_on_success(monkeypatch):
    monkeypatch.setattr("handler.decode_audio", lambda _audio_bytes: __import__("pathlib").Path("/tmp/turn.wav"))

    result = handle_score_request(
        FakeCorrector(), b"audio", CANONICAL_JSON, "Bearer secret-token", "secret-token"
    )

    assert isinstance(result, ScoreResponse)
    assert len(result.editOps) == 1
    assert result.editOps[0].op == "sub"
    assert result.editOps[0].expectedPhoneme == "AY"
    assert result.editOps[0].spokenPhoneme == "EY"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_handler.py -v`
Expected: FAIL with "No module named 'handler'"

- [ ] **Step 3: Implement `handler.py`**

```python
# apps/pronunciation-service/handler.py
import json

from pydantic import ValidationError

from pipeline import Corrector, decode_audio, run_corrector, to_edit_ops
from schemas import CanonicalWord, ScoreResponse


class UnauthorizedError(Exception):
    pass


class InvalidRequestError(Exception):
    pass


def handle_score_request(
    corrector: Corrector,
    audio_bytes: bytes,
    canonical_phones_json: str,
    authorization: str | None,
    expected_token: str,
) -> ScoreResponse:
    """Runs the full `/score` request: auth check, request parsing, the decode/correct/map
    pipeline, and response construction. Framework-agnostic — the caller (`modal_app.py`)
    translates the exceptions raised here to HTTP status codes.
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
        log = run_corrector(corrector, wav_path, words)
    finally:
        wav_path.unlink(missing_ok=True)

    edit_ops = to_edit_ops(log, words)
    return ScoreResponse(editOps=edit_ops)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_handler.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Lint and typecheck**

Run: `uv run ruff check handler.py tests/test_handler.py && uv run ty check handler.py tests/test_handler.py`
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `uv run pytest -v`
Expected: PASS (all tests across `test_schemas.py`, `test_pipeline.py`, `test_handler.py`)

- [ ] **Step 7: Commit**

```bash
git add apps/pronunciation-service/handler.py apps/pronunciation-service/tests/test_handler.py
git commit -m "Add pronunciation-service request handler"
```

---

## Task 8: `modal_app.py`, deployment, and secret wiring

**Files:**
- Create: `apps/pronunciation-service/modal_app.py`
- Create: `apps/pronunciation-service/README.md`
- Modify: `apps/server/.env.example` (document `PRONUNCIATION_SERVICE_TOKEN`)
- Modify: `apps/server/src/pronunciation.ts` (send the bearer token header)
- Test: `apps/server/src/pronunciation.test.ts` (assert the header is sent)

**Interfaces:**
- Consumes: `HuperCorrector` (Task 6), `handle_score_request`/`UnauthorizedError`/
  `InvalidRequestError` (Task 7), `ScoreResponse` (Task 3).
- No new interfaces produced — this is the deployment entry point.

- [ ] **Step 1: Write the failing TS test for the auth header**

Add to `apps/server/src/pronunciation.test.ts`, replacing the existing multipart-POST test's
assertions with an added header check (add this as a new assertion in that same test, right after
`expect(capturedUrl)...`):

```ts
    expect(capturedHeaders?.get("authorization")).toBe("Bearer test-token");
```

And capture headers alongside the existing `capturedForm`/`capturedUrl` in that test's mock:

```ts
    let capturedHeaders: Headers | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedForm = init?.body as FormData;
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse({
        editOps: [
          { word: "like", wordIndex: 0, op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" },
        ],
      });
    }) as unknown as typeof fetch;
```

Also set the new env var at the top of that test, alongside `PRONUNCIATION_SERVICE_URL`:

```ts
    process.env["PRONUNCIATION_SERVICE_TOKEN"] = "test-token";
```

And restore it in the existing `afterEach` (add alongside the existing URL restore):

```ts
  const originalToken = process.env["PRONUNCIATION_SERVICE_TOKEN"];
  // ...
  afterEach(() => {
    global.fetch = originalFetch;
    process.env["PRONUNCIATION_SERVICE_URL"] = originalUrl;
    process.env["PRONUNCIATION_SERVICE_TOKEN"] = originalToken;
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && pnpm exec vitest run src/pronunciation.test.ts`
Expected: FAIL — no `Authorization` header is sent today.

- [ ] **Step 3: Send the bearer token from `pronunciation.ts`**

Edit `apps/server/src/pronunciation.ts`, adding a `getServiceToken` function next to the existing
`getServiceUrl`, and using it in `scoreTurn`:

```ts
function getServiceToken(): string {
  const token = process.env["PRONUNCIATION_SERVICE_TOKEN"];
  if (!token) {
    throw new Error("PRONUNCIATION_SERVICE_TOKEN is required (see apps/server/.env.example)");
  }
  return token;
}
```

In `HttpPronunciationProvider.scoreTurn`, add the header to the existing `fetch` call:

```ts
    const response = await fetch(`${getServiceUrl()}/score`, {
      method: "POST",
      body: form,
      headers: { Authorization: `Bearer ${getServiceToken()}` },
      signal: AbortSignal.timeout(SCORE_TURN_TIMEOUT_MS),
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/pronunciation.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Document the new env var**

Edit `apps/server/.env.example`, right after the existing `PRONUNCIATION_SERVICE_URL` line:

```
PRONUNCIATION_SERVICE_TOKEN=
```

- [ ] **Step 6: Typecheck and lint the TS change**

Run: `cd apps/server && pnpm typecheck && pnpm exec oxlint src/pronunciation.ts src/pronunciation.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit the TS auth wiring**

```bash
git add apps/server/src/pronunciation.ts apps/server/src/pronunciation.test.ts apps/server/.env.example
git commit -m "Send a bearer token to the pronunciation-scoring service"
```

- [ ] **Step 8: Write `modal_app.py`**

```python
# apps/pronunciation-service/modal_app.py
import os

import modal
from fastapi import File, Form, Header, HTTPException, UploadFile

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from models import HuperCorrector
from schemas import ScoreResponse

MODEL_DIR = "/model"


def _download_corrector() -> None:
    from huggingface_hub import snapshot_download

    snapshot_download("huper29/huper_corrector", local_dir=MODEL_DIR)


image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.14.0",
        "transformers==5.16.1",
        "huggingface-hub==1.30.0",
        "fastapi==0.141.1",
        "python-multipart==0.0.32",
        "pydantic==2.13.5",
    )
    .run_function(_download_corrector)
)

app = modal.App("kalli-pronunciation-service", image=image)
auth_secret = modal.Secret.from_name("pronunciation-service-auth")


@app.cls(gpu="T4", secrets=[auth_secret], min_containers=0)
class PronunciationService:
    @modal.enter()
    def load(self) -> None:
        self.corrector = HuperCorrector(
            checkpoint_path=f"{MODEL_DIR}/model.safetensors",
            vocab_path=f"{MODEL_DIR}/edit_seq_speech/config/vocab.json",
        )

    @modal.fastapi_endpoint(method="POST")
    async def score(
        self,
        audio: UploadFile = File(...),
        canonical_phones: str = Form(...),
        authorization: str | None = Header(None),
    ) -> ScoreResponse:
        try:
            return handle_score_request(
                self.corrector,
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
```

- [ ] **Step 9: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check modal_app.py && uv run ty check modal_app.py`
Expected: `ruff` passes. `ty` will likely report unresolved imports for `modal` and `fastapi`'s
runtime specifics or for `HuperCorrector`'s deferred import chain — resolve real issues; for
anything genuinely only resolvable inside the deployed container (matching Task 6's precedent), add
a justified inline ignore the same way.

- [ ] **Step 10: Create the Modal secret**

Run: `modal secret create pronunciation-service-auth PRONUNCIATION_SERVICE_TOKEN=<a-generated-random-token>`
Expected: secret created in your Modal workspace. Save the same token value for Step 12.

- [ ] **Step 11: Deploy**

Run: `cd apps/pronunciation-service && modal deploy modal_app.py`
Expected: deploy succeeds and prints a URL ending in `.modal.run`. If the deploy fails because
`handler`/`models`/`pipeline`/`schemas` can't be found inside the container, check Modal's current
guidance on including local Python modules in an Image (e.g. `Image.add_local_python_source`) and
add the needed call to the `image` definition in `modal_app.py`.

Note the printed URL — it's the value for `PRONUNCIATION_SERVICE_URL` in Step 12.

- [ ] **Step 12: Wire the deployed service into `apps/server`**

Run (against your Fly app):

```bash
fly secrets set PRONUNCIATION_SERVICE_URL=<the-modal-url-from-step-11> \
  PRONUNCIATION_SERVICE_TOKEN=<the-same-token-from-step-10> \
  --app <your-fly-app-name>
```

- [ ] **Step 13: Manually verify end-to-end**

Have a live Kalli conversation (or replay a recorded turn) and confirm a deliberately mispronounced
word surfaces a pronunciation correction through the existing pipeline — this is the first point
this plan's work is exercised against the real deployed service rather than fakes.

- [ ] **Step 14: Write `README.md`**

```markdown
# apps/pronunciation-service

Modal-hosted HuPER Corrector service. See
`docs/superpowers/specs/2026-09-05-pronunciation-service-modal-design.md` for the design.

## Local development

```bash
uv sync
uv run pytest
uv run ruff check .
uv run ty check .
```

## Deploying

```bash
modal deploy modal_app.py
```

Prints a URL ending in `.modal.run` — set that as `PRONUNCIATION_SERVICE_URL` in `apps/server`'s
Fly secrets (`fly secrets set PRONUNCIATION_SERVICE_URL=...`).

## Secrets

- `pronunciation-service-auth` (Modal secret, holds `PRONUNCIATION_SERVICE_TOKEN`): create with
  `modal secret create pronunciation-service-auth PRONUNCIATION_SERVICE_TOKEN=<token>`. The same
  token value must also be set as `PRONUNCIATION_SERVICE_TOKEN` in `apps/server`'s Fly secrets —
  this service and `apps/server` share one static bearer token, checked on every `/score` request.
```

- [ ] **Step 15: Commit**

```bash
git add apps/pronunciation-service/modal_app.py apps/pronunciation-service/README.md
git commit -m "Add pronunciation-service Modal app and deployment docs"
```
