import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ElevenLabsTTSProvider,
  getDeepInfraApiKey,
  sanitizeForSpeech,
  synthesizeKokoro,
} from "../tts.js";
import { decodeDataUriAudio, writeAudioToFile } from "./ttsComparisonWriter.js";

/** A representative Kalli reply: warm tone, a corrected-phrase quote (exercises
 * `sanitizeForSpeech`), and a contraction (exercises the apostrophe-preserving path). */
const KALLI_TEST_PHRASE =
  "That's a great try! Quick correction though — instead of saying " +
  '"I have went to the store," you\'d say "I went to the store." ' +
  "Want to practice that one more time?";

const KOKORO_VOICE_CANDIDATES = ["af_heart", "af_bella", "af_nicole", "af_sky"];

/**
 * Chatterbox (unlike Kokoro) has no named preset voices — DeepInfra's only voice-selection
 * mechanism for it is cloning from a reference clip via `/v1/voices/add`. Absent reference audio,
 * the comparable axis of variation is delivery style on its single built-in voice, tuned via
 * `exaggeration` (emotional intensity) and `cfg` (classifier-free-guidance weight, which trades
 * off pacing/stability against expressiveness). Defaults and ranges per Resemble AI's own tuning
 * guide (github.com/resemble-ai/chatterbox): both default to 0.5; raising `exaggeration` while
 * lowering `cfg` produces more dramatic, slower delivery.
 *
 * Uses the base `ResembleAI/chatterbox` model rather than `chatterbox-turbo` — Resemble's docs for
 * the standalone Turbo Python package state `exaggeration`/`cfg_weight` are ignored on Turbo, and
 * the base model is the one their docs specifically call out for "CFG & Exaggeration tuning."
 */
const CHATTERBOX_VOICE_CANDIDATES = [
  { label: "default", exaggeration: 0.5, cfg: 0.5 },
  { label: "expressive", exaggeration: 0.8, cfg: 0.3 },
  { label: "flat", exaggeration: 0.3, cfg: 0.6 },
];

/**
 * Calls DeepInfra's native, non-streaming inference endpoint (`/v1/inference/{model}`) rather than
 * the ElevenLabs-compatible streaming one Kokoro uses. Both CSM-1B and Chatterbox-turbo were found
 * to have broken/unreliable behavior on that streaming endpoint — CSM-1B streamed audible
 * decoder-reset clicks at every internal segment boundary, and Chatterbox-turbo's stream simply
 * never delivered a single byte (confirmed reproducible, not a cold start). The native endpoint
 * generates the whole utterance in one server-side pass for both models instead, verified clean
 * (single correct wav header, no chunking artifacts, no amplitude discontinuities). Its response
 * is a JSON blob with the audio as a `data:audio/wav;base64,...` URI, not raw streamed bytes.
 */
async function synthesizeDeepInfraNonStreaming(
  text: string,
  modelId: string,
  extraParams: Record<string, number | string> = {},
): Promise<{ audio: Buffer; model: string }> {
  const response = await fetch(`https://api.deepinfra.com/v1/inference/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `bearer ${getDeepInfraApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: sanitizeForSpeech(text), ...extraParams }),
  });
  if (!response.ok) {
    throw new Error(
      `DeepInfra ${modelId} inference failed: ${response.status} ${await response.text()}`,
    );
  }
  const result = (await response.json()) as { audio: string };
  return { audio: decodeDataUriAudio(result.audio), model: modelId };
}

async function main(): Promise<void> {
  const outputDir = path.join(import.meta.dirname, "..", "..", "tts-comparison");
  await mkdir(outputDir, { recursive: true });

  const elevenLabs = await new ElevenLabsTTSProvider().synthesize(KALLI_TEST_PHRASE);
  await writeAudioToFile(elevenLabs.audio, path.join(outputDir, "elevenlabs.mp3"));
  console.log(`Wrote elevenlabs.mp3 (${elevenLabs.model})`);

  for (const voiceId of KOKORO_VOICE_CANDIDATES) {
    const { audio, model } = await synthesizeKokoro(KALLI_TEST_PHRASE, voiceId);
    await writeAudioToFile(audio, path.join(outputDir, `kokoro-${voiceId}.mp3`));
    console.log(`Wrote kokoro-${voiceId}.mp3 (${model})`);
  }

  const csm = await synthesizeDeepInfraNonStreaming(KALLI_TEST_PHRASE, "sesame/csm-1b");
  await writeFile(path.join(outputDir, "csm-1b.wav"), csm.audio);
  console.log(`Wrote csm-1b.wav (${csm.model})`);

  for (const { label, exaggeration, cfg } of CHATTERBOX_VOICE_CANDIDATES) {
    const chatterbox = await synthesizeDeepInfraNonStreaming(
      KALLI_TEST_PHRASE,
      "ResembleAI/chatterbox",
      {
        exaggeration,
        cfg,
      },
    );
    await writeFile(path.join(outputDir, `chatterbox-${label}.wav`), chatterbox.audio);
    console.log(`Wrote chatterbox-${label}.wav (${chatterbox.model})`);
  }

  // Same base architecture as `ResembleAI/chatterbox`, plus a `language` param (defaults to
  // empty/English-only otherwise) — passed explicitly here since the test phrase is English and
  // an unset language code shouldn't silently determine that.
  const chatterboxMultilingual = await synthesizeDeepInfraNonStreaming(
    KALLI_TEST_PHRASE,
    "ResembleAI/chatterbox-multilingual",
    { exaggeration: 0.5, cfg: 0.5, language: "en" },
  );
  await writeFile(
    path.join(outputDir, "chatterbox-multilingual-en.wav"),
    chatterboxMultilingual.audio,
  );
  console.log(`Wrote chatterbox-multilingual-en.wav (${chatterboxMultilingual.model})`);

  console.log(`\nAll candidates written to ${outputDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
