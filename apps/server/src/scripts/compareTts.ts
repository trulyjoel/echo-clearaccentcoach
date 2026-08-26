import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ElevenLabsTTSProvider, synthesizeKokoro } from "../tts.js";
import { writeAudioToFile } from "./ttsComparisonWriter.js";

/** A representative Kalli reply: warm tone, a corrected-phrase quote (exercises
 * `sanitizeForSpeech`), and a contraction (exercises the apostrophe-preserving path). */
const KALLI_TEST_PHRASE =
  "That's a great try! Quick correction though — instead of saying " +
  '"I have went to the store," you\'d say "I went to the store." ' +
  "Want to practice that one more time?";

const KOKORO_VOICE_CANDIDATES = ["af_heart", "af_bella", "af_nicole", "af_sky"];

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

  console.log(`\nAll candidates written to ${outputDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
