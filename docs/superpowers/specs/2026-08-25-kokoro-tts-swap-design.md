# Add Kokoro (via DeepInfra) as a cost-reduction alternative to ElevenLabs TTS

## Problem

Kalli's spoken replies are synthesized exclusively through ElevenLabs (`eleven_flash_v2_5`, ~$0.05
per 1,000 characters). Deepgram STT was already migrated to a cheaper model (Nova-3 → Flux) as a
cost reduction; TTS is the next-largest per-session vendor cost and the next target.

## Goals

- Make Kokoro-82M (served via DeepInfra, ~$0.65–0.80 per 1,000,000 characters — roughly 65-75x
  cheaper) the default TTS backend.
- Keep ElevenLabs fully working and selectable via a manual environment-variable toggle, so it can
  be flipped back to instantly if Kokoro's quality or reliability turns out to be a problem in
  production. This is a deliberate exception to "replace, don't deprecate" — the toggle is the
  explicit ask, not a speculative feature.
- No changes to the streaming architecture: audio must keep arriving as incremental chunks so the
  existing sentence-pipelined playback (`apps/server/src/routes/session.ts`) and the browser's
  `MediaSource`-based player (`apps/web/src/Session.tsx`) both keep working unmodified.

## Non-goals

- No self-hosting of Kokoro. A dedicated GPU machine (needed for consistent low-latency inference)
  would either sit idle-but-billed or cold-start on every request — DeepInfra's hosted, GPU-backed
  endpoint gets ~99% of the cost reduction with none of that operational burden. Revisit only if
  usage grows enough to justify dedicated infra.
- No automatic runtime fallback (e.g. retry on ElevenLabs if Kokoro errors mid-session). The toggle
  is a manual, deploy-time operational switch, not a request-level failover — that's meaningfully
  more complexity (partial-failure handling mid-stream) for a case (DeepInfra outage) that hasn't
  happened and isn't the ask.
- No changes to `apps/web` — the swap is entirely server-side, and DeepInfra's `mp3` output format
  matches what the browser's `MediaSource` `audio/mpeg` buffer already expects.

## Provider selection

A new `TTS_PROVIDER` environment variable, `"kokoro"` (default) or `"elevenlabs"`. `getTTSProvider()`
in `apps/server/src/tts.ts` reads it once and instantiates the matching class, same lazy-singleton
pattern as today:

```ts
function getTTSProvider(): TTSProvider {
  if (!provider) {
    provider =
      (process.env["TTS_PROVIDER"] ?? "kokoro") === "elevenlabs"
        ? new ElevenLabsTTSProvider()
        : new KokoroTTSProvider();
  }
  return provider;
}
```

Both provider classes live in `tts.ts`, same as `ElevenLabsTTSProvider` does today. The
`@elevenlabs/elevenlabs-js` dependency stays in `package.json`.

## Interface change: providers report their own model

Today, `session.ts` imports a hardcoded `ELEVENLABS_MODEL` constant to log usage
(`recordUsage(sessionId, { elevenlabsCharacters, elevenlabsModel: ELEVENLABS_MODEL })`). With two
providers behind a runtime toggle, that constant is wrong whenever `TTS_PROVIDER=elevenlabs` isn't
the active choice. `LLMProvider` (`apps/server/src/llm.ts`) already solves the equivalent problem by
returning `model` alongside each call's result instead of exposing a static constant. `TTSProvider`
adopts the same shape:

```ts
export interface TTSProvider {
  /** Synthesizes `text` to speech, streamed as audio chunks as they're produced. */
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }>;
}
```

`session.ts`'s `consumeAudio` changes from:

```ts
await recordUsage(sessionId, { elevenlabsCharacters: sentence.length, elevenlabsModel: ELEVENLABS_MODEL });
const audioChunks = await getTTSProvider().synthesize(sentence);
for await (const chunk of audioChunks) { ... }
```

to:

```ts
const { audio, model } = await getTTSProvider().synthesize(sentence);
await recordUsage(sessionId, { ttsCharacters: sentence.length, ttsModel: model });
for await (const chunk of audio) { ... }
```

(Recording usage before consuming the stream stays as-is — characters are billed by both vendors
once the call is made, not once the stream is fully read.)

## `KokoroTTSProvider`

A thin `fetch`-based client — no new SDK dependency, since DeepInfra has no official JS client and
the request is a single streaming `POST`:

```ts
export const KOKORO_MODEL = "hexgrad/Kokoro-82M";

/** Calls DeepInfra's Kokoro endpoint for a specific voice — factored out so the voice-comparison
 * script (see below) can request multiple candidate voices without duplicating the request shape. */
export async function synthesizeKokoro(
  text: string,
  voiceId: string,
): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
  const response = await fetch(
    `https://api.deepinfra.com/v1/text-to-speech/${voiceId}/stream?output_format=mp3`,
    {
      method: "POST",
      headers: {
        "xi-api-key": getDeepInfraApiKey(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: sanitizeForSpeech(text), model_id: KOKORO_MODEL }),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`DeepInfra TTS request failed: ${response.status} ${await response.text()}`);
  }
  return { audio: response.body, model: KOKORO_MODEL };
}

class KokoroTTSProvider implements TTSProvider {
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    return synthesizeKokoro(text, process.env["DEEPINFRA_VOICE_ID"] ?? "af_heart");
  }
}
```

(`response.body` is a Node `ReadableStream`, which is an `AsyncIterable<Uint8Array>` — no adapter
needed.)

Config:
- `DEEPINFRA_API_KEY` — required when `TTS_PROVIDER=kokoro` (the default).
- `DEEPINFRA_VOICE_ID` — optional, defaults to `af_heart` (a clear American-English female voice,
  the closest available analog to ElevenLabs' "Rachel" default).

`output_format=mp3` is a fixed choice, not configurable — it's required to match the browser's
hardcoded `audio/mpeg` `MediaSource` buffer (`apps/web/src/Session.tsx:235`).

`sanitizeForSpeech` (quote-stripping) is applied to both providers. Its doc comment currently
explains the ElevenLabs-`eleven_flash_v2_5`-specific reason it exists; that gets reworded since we
can't assume Kokoro mispronounces quotes the same way without listening to real output — the
comment will note it's applied by default pending a listening check, not proven necessary for
Kokoro.

## Usage/cost tracking

`elevenlabsCharacters`/`elevenlabsModel` become `ttsCharacters`/`ttsModel` in:
- `apps/server/src/db/schema.ts` (column names, via a hand-written `RENAME COLUMN` migration — the
  drizzle-kit-generated diff would default to drop+add, which would silently zero out historical
  per-session cost data)
- `apps/server/src/usage.ts` (`UsageDelta` fields, `ZERO_COUNTS`, `recordUsage`'s SQL)
- `apps/server/src/routes/session.ts` (the `recordUsage` call site above)

This rename makes sense independent of which provider is active — the columns track "TTS cost for
this session," not "ElevenLabs cost."

## Config file

`.env.example` changes:
- Add `TTS_PROVIDER` (optional, defaults to `kokoro`), `DEEPINFRA_API_KEY`, `DEEPINFRA_VOICE_ID`.
- Keep `ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID`, with their comment updated to note they're only
  read when `TTS_PROVIDER=elevenlabs`.

## Testing

- `tts.test.ts` gets a `KokoroTTSProvider` suite mirroring the existing `ElevenLabsTTSProvider` one:
  mock global `fetch` (instead of the SDK) to assert the request URL/headers/body and that a
  streamed mock response comes back through `synthesize()` unchanged.
- A new test asserts `getTTSProvider()` picks the class matching `TTS_PROVIDER`, and defaults to
  Kokoro when unset.
- `sanitizeForSpeech` tests are unchanged (still exercised by both provider suites).
- `session.test.ts` / `usage.test.ts` (if present) updated for the `ttsCharacters`/`ttsModel` field
  rename — behavior unchanged, just the field names.

## Voice comparison tool

A checked-in script, `apps/server/src/scripts/compareTts.ts`, generates one standard test phrase
through ElevenLabs and through several candidate Kokoro voices, so voice/quality can be judged by
listening rather than guessed at. Reusable beyond this migration — the same script works for
evaluating another TTS vendor later, or re-picking the voice if Kalli's tone changes.

- **Test phrase** lives in the script as `KALLI_TEST_PHRASE`, written to look like a real Kalli
  turn rather than generic filler — warm tone, one corrected-phrase quote (exercises
  `sanitizeForSpeech`), one contraction (exercises the apostrophe-preserving path):

  > "That's a great try! Quick correction though — instead of saying "I have went to the store,"
  > you'd say "I went to the store." Want to practice that one more time?"

- **Candidates**: ElevenLabs using whatever voice `ELEVENLABS_VOICE_ID`/default resolves to, plus a
  fixed list of Kokoro voice IDs to compare: `af_heart`, `af_bella`, `af_nicole`, `af_sky` — American
  English female voices in Kokoro's preset list, picked as plausible analogs to ElevenLabs'
  "Rachel." The script calls `synthesizeKokoro(KALLI_TEST_PHRASE, voiceId)` per candidate and
  `ElevenLabsTTSProvider`'s existing `synthesize()` once, reusing production code paths rather than
  reimplementing request logic.
- **Output**: each candidate's audio is written to `apps/server/tts-comparison/<candidate>.mp3`
  (e.g. `elevenlabs.mp3`, `kokoro-af_heart.mp3`) for local playback. `tts-comparison/` is added to
  `.gitignore` — generated audio never gets committed.
- **Invocation**: `pnpm --filter @kalli/server compare-tts`, added to `apps/server/package.json` as
  `"compare-tts": "tsx --env-file=.env src/scripts/compareTts.ts"`. Requires both
  `DEEPINFRA_API_KEY` and `ELEVENLABS_API_KEY` set locally, regardless of `TTS_PROVIDER` — the
  script talks to both vendors directly, independent of the runtime toggle.

## Rollout

Since the toggle defaults to `kokoro`, deploying this change switches production cost immediately.
Before merging: run `compare-tts` and listen through the candidates to confirm Kokoro quality is
acceptable and pick the closest-matching voice for `DEEPINFRA_VOICE_ID`, since audio quality is
subjective and not something the automated test suite can verify. If quality is unacceptable after
shipping, flipping `TTS_PROVIDER=elevenlabs` in the Fly.io environment is the rollback — no code
change or redeploy needed.
