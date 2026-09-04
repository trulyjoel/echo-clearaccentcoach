# Audio emphasis for missed short words in corrections

Status: ready-for-human — see `issues/` for per-ticket status; all five original tickets are
closed (implemented or superseded), plus one new ticket (06) not anticipated by this spec.

> **Implemented 2026-09-03 with a different mechanism than this spec describes below.** The TTS
> provider changed from ElevenLabs to Inworld during design. A live listening comparison (see
> `issues/02`'s Comments) found that capitalizing the marked word (e.g. "the" → "THE") on
> Inworld's full model reads clearly on its own — no weak-to-strong-form respelling table, no
> `<break>` pause markup. The marker protocol below (`«word»`) and the plain/speech dual-view
> design are otherwise unchanged; read `issues/01`–`06`'s Comments sections for what actually
> shipped rather than treating the Mechanism/Components sections below as current.

## Problem

When a learner drops a short function word (e.g. "I want to speak well for meeting" instead of
"...for the meeting"), Kalli's spoken correction currently repeats the corrected phrase at normal
conversational pace. Short function words (articles, some prepositions) get spoken with a reduced
vowel by default and pass by too fast for the learner to register them as the point of the
correction — reported symptom: "the TTS sentence runs along too fast, 'word the before meeting'."

This follows directly from two things established in the prior debugging session (`apps/server/src/tts.ts`):

- `eleven_flash_v2_5` (the TTS model in use) disables text normalization by default for latency,
  and reads text literally rather than inferring prosody.
- `sanitizeForSpeech()` already strips double-quote characters from TTS-bound text for a related
  reason — literal punctuation being read/mispronounced.

## Goals

- Make Kalli's spoken correction audibly distinct for short, easily-swallowed corrected words —
  primarily articles and common prepositions — without a model swap or added TTS latency budget
  beyond a single short pause per correction.
- Keep the mechanism category-agnostic: driven by "is the corrected word short and easy to miss,"
  not hardcoded to `article_usage`.
- Keep the correction phrasing natural — repeat the corrected phrase in its real grammatical
  context (already established by the "sound human" prompt work), not a "the little word 'X'"
  meta-mention. (Meta-mention was tried and rejected during design: forcing a strong-form
  pronunciation on a word named in isolation reads as a substitution error, not emphasis — strong
  forms are a contrastive-stress phenomenon that only sounds natural in situ.)

## Non-goals

- No visual echo of the emphasis in the chat bubble (e.g. bolding the word) in this pass. The
  `reply_text_delta` stream stays plain text, identical to today. Revisit as a follow-up once
  audio-only emphasis has been heard/validated.
- No broad weak-form dictionary. The initial `strongForms` table covers three unambiguous,
  ELT-documented pairs (`a`, `the`, `to`) rather than guessing respellings for every preposition.
- No phoneme-tag / SSML pronunciation control. Ruled out during design: phoneme tags aren't
  supported on `eleven_flash_v2_5` (only `eleven_flash_v2`/`eleven_turbo_v2`/deprecated
  `eleven_monolingual_v1`), and operate at the wrong granularity anyway — they tune a word's
  internal syllable pronunciation, not whether a monosyllabic function word stands out in a
  sentence.

## Mechanism

Two techniques, layered:

1. **Weak-form → strong-form respelling.** English function words have a reduced "weak form"
   pronunciation in fluent speech (e.g. "the" → /ðə/, "thuh") and a full "strong form" used for
   contrastive emphasis (/ðiː/, "thee"). Respelling the word in the TTS-bound text (e.g. `the` →
   `thee`) nudges ElevenLabs toward the strong form. This only sounds natural when the word is
   spoken in its real grammatical slot, not named/quoted in isolation — hence the phrasing
   requirement in Goals.
2. **A short SSML pause** (`<break time='0.3s'/>`) immediately before the word, for isolation
   regardless of how well the respelling lands. `eleven_flash_v2_5` supports SSML break tags (all
   models except `eleven_v3` do); ElevenLabs' own guidance is to use them sparingly, which this
   satisfies — at most one per correction, matching the existing "pick the single most relevant
   error" instruction already in `buildReplySystemPrompt`.

**Important interaction:** the break tag's attribute must use single quotes
(`time='0.3s'`), not double quotes. `sanitizeForSpeech()` strips double-quote characters from
TTS-bound text; double-quoted SSML attributes would be corrupted into `<break time=0.3s/>` by that
same pass, since the break tag gets injected upstream of `synthesize()` and both text and markup
flow through `sanitizeForSpeech` together. Single quotes are valid XML/SSML syntax and are left
untouched by that regex (which only targets `"`/`"`/`"`, not `'`, since apostrophes are
load-bearing for contractions).

## Marker protocol

The model can't reliably be told "emphasize the word 'the' in your reply" via prose instruction
alone — "the" is the most common word in English and will often appear more than once in the same
reply (e.g. "Don't forget the little word 'the'" has two). Post-hoc text search for which
occurrence to emphasize is inherently ambiguous. Instead, the model marks the exact occurrence
itself, inline, using a plain sentinel: `«word»`.

- `buildReplySystemPrompt` gains an instruction + one few-shot example: when the corrected word is
  a short, easy-to-miss function word, repeat the corrected phrase naturally in context and wrap
  only that word, e.g. `You'd say "speak well for «the» meeting."`
- A resolver consumes the raw delta stream and, for each occurrence of `«word»`, produces two
  outputs:
  - **plain**: `word` (marker stripped) — used everywhere the current plain reply text is used.
  - **speech**: `<break time='0.3s'/>` + (`getStrongForm(word)` if present in the table, else
    `word` unchanged) — used only for the TTS-bound sentence text.
  - Unmarked text passes through unchanged in both outputs.

## Data flow change in `session.ts`

Today, `streamReplyWithPipelinedTTS`'s `replyText` accumulator (built directly from raw deltas) is
used for three things: `conversationHistory` (fed back into the LLM on the next turn),
the final `reply_text` message, and `persistTurn`'s DB write. If any of those ever contained a raw
`«the»` marker, it would leak into stored conversation history and the transcript — and worse,
get fed back to the model as part of its own prior turn, teaching it to emit markers more broadly
than intended.

Fix: `replyText` accumulates the **plain** form only. The **speech** form is used solely to feed
`splitSentences`/`sentenceQueue`, the same way it already handles raw deltas today — this is a
substitution of what feeds the sentence splitter, not a new pipeline stage.

```
for await (const delta of replyStream.textStream) {
  if (aborted()) break;
  const { plain, speechText } = markerResolver.feed(delta);
  replyText += plain;
  if (plain) send({ type: "reply_text_delta", text: plain });
  const { sentences, remainder } = splitSentences(sentenceBuffer + speechText);
  sentenceBuffer = remainder;
  for (const sentence of sentences) sentenceQueue.push(sentence);
}
// after the loop: markerResolver.flush() covers a stream that ends mid-marker (treat the
// unterminated "«" and anything after it as literal plain text, mirroring how sentenceBuffer's
// trailing remainder is already flushed as a final sentence).
```

## Components

- **`apps/server/src/strongForms.ts`** (new) — `getStrongForm(word: string): string | undefined`,
  case-insensitive lookup against a small table: `{ a: "ay", the: "thee", to: "too" }`. Preserves
  the input word's capitalization pattern in the result (initial-capital in → initial-capital out,
  e.g. `The` → `Thee`), since a marked word can land at a sentence start.
- **`apps/server/src/emphasisMarkers.ts`** (new) — the stateful resolver described above. Exposes
  a `createMarkerResolver()` factory returning `{ feed(delta: string): { plain: string; speechText:
  string }, flush(): { plain: string; speechText: string } }`, so each turn gets its own resolver
  instance (mirrors how `sentenceBuffer` is a fresh local per turn today).
- **`apps/server/src/llm.ts`** — `buildReplySystemPrompt` gains the marker instruction and one
  few-shot example, following the same "vary the phrasing, don't create a new tic" discipline
  applied to the existing correction examples.
- **`apps/server/src/routes/session.ts`** — `streamReplyWithPipelinedTTS` wires the resolver into
  the delta loop as shown above.
- **`apps/server/src/tts.ts`** — no functional change; `sanitizeForSpeech`'s existing double-quote
  stripping is verified (via test) to leave single-quoted break tags intact.

## Testing

- `strongForms.test.ts` — table lookup, case-insensitivity, capitalization preserved in the
  result, unknown word returns `undefined`.
- `emphasisMarkers.test.ts` — unmarked text passes through unchanged; a marker fully contained in
  one delta resolves correctly; a marker split across multiple deltas (e.g. `«th` then `e»`)
  resolves correctly; an unterminated marker at stream end flushes as literal plain text; a marked
  word not present in `strongForms` still gets the break tag without respelling.
- `tts.test.ts` — extend with a case asserting `sanitizeForSpeech` leaves `<break time='0.3s'/>`
  intact (regression guard for the quote-collision interaction above).
- `llm.test.ts` — assert the new few-shot example is present in `buildReplySystemPrompt`'s output,
  consistent with existing coverage.
- No test asserts on actual audio output or perceived naturalness — that's inherently a listening
  judgment, not something a unit test can verify. Same limitation noted in the prior TTS fix.

## Follow-ups (explicitly deferred)

- Visual echo of the emphasized word in the chat bubble (Non-goals).
- Expanding `strongForms` beyond `a`/`the`/`to` once these have been heard in practice.
