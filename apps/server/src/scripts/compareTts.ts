import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decodeDataUriAudio,
  ElevenLabsTTSProvider,
  getDeepInfraApiKey,
  sanitizeForSpeech,
  synthesizeKokoro,
} from "../tts.js";
import { writeAudioToFile } from "./ttsComparisonWriter.js";

/** A representative Kalli reply: warm tone, a corrected-phrase quote (exercises
 * `sanitizeForSpeech`), and a contraction (exercises the apostrophe-preserving path). */
const KALLI_TEST_PHRASE =
  "That's a great try! Quick correction though — instead of saying " +
  '"I have went to the store," you\'d say "I went to the store." ' +
  "Want to practice that one more time?";

/** Same phrase with two of Chatterbox-Turbo's paralinguistic tags inserted at natural spots — a
 * warm chuckle acknowledging the attempt, and a throat-clear marking the transition into the
 * correction (a real thing teachers do) — to hear the tag feature in Kalli's actual voice. */
const KALLI_TEST_PHRASE_WITH_TAGS =
  "That's a great try! [chuckle] [clear throat] Quick correction though — instead of saying " +
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
 * All 9 of Qwen3-TTS's preset speakers, at default expressiveness (no `instruct` steering) — the
 * comparison axis here is base voice/timbre, not delivery style. None are English-native (all are
 * Chinese/Japanese/Korean-native per Qwen's docs) but the model claims cross-lingual output, so
 * `language: "English"` is passed explicitly to test that claim rather than assume it.
 */
const QWEN_VOICE_CANDIDATES = [
  "Vivian",
  "Serena",
  "Uncle_Fu",
  "Dylan",
  "Eric",
  "Ryan",
  "Aiden",
  "Ono_Anna",
  "Sohee",
];

/**
 * Orpheus is Llama-based and pitched specifically as "empathetic" TTS — the candidate axis here is
 * base expressiveness, not an explicit control knob like Chatterbox's `exaggeration`/`cfg`. Like
 * Qwen3-TTS, its `voice` field is enum-validated server-side; the allowed set was confirmed by
 * probing the live endpoint with an invalid value rather than trusting third-party docs (DeepInfra
 * hosts 7, not the 8 Canopy's own upstream docs list — "zoe" isn't accepted here).
 */
const ORPHEUS_VOICE_CANDIDATES = ["tara", "leah", "mia", "zac"];

/**
 * Confirmed voice enum via the same live-probe technique: `mimo_default`, four Chinese-named
 * voices, and four English-named ones (`Mia`, `Chloe`, `Milo`, `Dean`) — only the English-named
 * ones plus the default are tested here, since the others are presumably tuned for Chinese.
 *
 * As of this writing, DeepInfra returns "New accounts need established payment history to access
 * this model" for every request to this model on this account, regardless of a valid body — a
 * per-account gate on DeepInfra's side, not a bug in this script. It's listed here anyway so the
 * candidates are ready to run once that gate clears (or on an account with payment history).
 */
const MIMO_VOICE_CANDIDATES = ["mimo_default", "Mia", "Chloe", "Milo", "Dean"];

/**
 * Chatterbox-Turbo's distinguishing feature is paralinguistic tags — inline text markers
 * (`[chuckle]`, `[sigh]`, etc.) performed in-voice rather than a numeric expressiveness knob.
 * `plain` is the untagged phrase (a direct A/B against the base `chatterbox` candidates above,
 * same model family, no tags). `tags` exercises the feature via `KALLI_TEST_PHRASE_WITH_TAGS`.
 * `tags-exaggeration` layers `exaggeration`/`cfg` on top of the tagged phrase — DeepInfra's hosted
 * endpoint schema-validates those fields on Turbo (confirmed live), which contradicts Resemble's
 * own docs stating the standalone Turbo package ignores them; this candidate exists to hear
 * whether they audibly do anything here, not to assume either doc is right.
 */
const CHATTERBOX_TURBO_CANDIDATES: {
  label: string;
  text: string;
  exaggeration?: number;
  cfg?: number;
}[] = [
  { label: "plain", text: KALLI_TEST_PHRASE },
  { label: "tags", text: KALLI_TEST_PHRASE_WITH_TAGS },
  { label: "tags-exaggeration", text: KALLI_TEST_PHRASE_WITH_TAGS, exaggeration: 0.8, cfg: 0.3 },
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
 *
 * The text-input field name isn't consistent across models on this endpoint — CSM-1B and Chatterbox
 * take `text`, but Qwen3-TTS returns a pydantic "missing" error on `text` and expects `input`
 * instead (confirmed by probing the live endpoint). `textField` lets each call site match its
 * model's actual schema rather than guessing one shared name.
 */
async function synthesizeDeepInfraNonStreaming(
  text: string,
  modelId: string,
  extraParams: Record<string, number | string> = {},
  textField: "text" | "input" = "text",
): Promise<{ audio: Buffer; model: string }> {
  const response = await fetch(`https://api.deepinfra.com/v1/inference/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `bearer ${getDeepInfraApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ [textField]: sanitizeForSpeech(text), ...extraParams }),
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

  for (const { label, text, exaggeration, cfg } of CHATTERBOX_TURBO_CANDIDATES) {
    const extraParams: Record<string, number> = {};
    if (exaggeration !== undefined) extraParams["exaggeration"] = exaggeration;
    if (cfg !== undefined) extraParams["cfg"] = cfg;
    const turbo = await synthesizeDeepInfraNonStreaming(
      text,
      "ResembleAI/chatterbox-turbo",
      extraParams,
    );
    await writeFile(path.join(outputDir, `chatterbox-turbo-${label}.wav`), turbo.audio);
    console.log(`Wrote chatterbox-turbo-${label}.wav (${turbo.model})`);
  }

  for (const speaker of QWEN_VOICE_CANDIDATES) {
    const qwen = await synthesizeDeepInfraNonStreaming(
      KALLI_TEST_PHRASE,
      "Qwen/Qwen3-TTS",
      { speaker, language: "English" },
      "input",
    );
    const label = speaker.toLowerCase();
    await writeFile(path.join(outputDir, `qwen-${label}.wav`), qwen.audio);
    console.log(`Wrote qwen-${label}.wav (${qwen.model})`);
  }

  for (const voice of ORPHEUS_VOICE_CANDIDATES) {
    const orpheus = await synthesizeDeepInfraNonStreaming(
      KALLI_TEST_PHRASE,
      "canopylabs/orpheus-3b-0.1-ft",
      { voice },
      "input",
    );
    await writeFile(path.join(outputDir, `orpheus-${voice}.wav`), orpheus.audio);
    console.log(`Wrote orpheus-${voice}.wav (${orpheus.model})`);
  }

  for (const voice of MIMO_VOICE_CANDIDATES) {
    const mimo = await synthesizeDeepInfraNonStreaming(
      KALLI_TEST_PHRASE,
      "XiaomiMiMo/MiMo-V2.5-tts",
      {
        voice,
      },
    );
    const label = voice.toLowerCase();
    await writeFile(path.join(outputDir, `mimo-${label}.wav`), mimo.audio);
    console.log(`Wrote mimo-${label}.wav (${mimo.model})`);
  }

  console.log(`\nAll candidates written to ${outputDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
