import { mkdir } from "node:fs/promises";
import path from "node:path";
import { synthesizeInworld } from "../tts.js";
import { writeAudioToFile } from "./ttsComparisonWriter.js";

/** One phrase, four ways to mark "the" — a direct listening test of ticket 01's candidate
 * mechanisms against the ElevenLabs-only design in the correction-word-emphasis spec. */
const VARIANTS: { label: string; text: string; model?: string }[] = [
  {
    label: "plain",
    text: "That's a great try! Quick correction though — you'd say I went to the store.",
  },
  {
    label: "capitalized",
    text: "That's a great try! Quick correction though — you'd say I went to THE store.",
  },
  {
    label: "asterisk",
    text: "That's a great try! Quick correction though — you'd say I went to *the* store.",
  },
  {
    label: "ipa",
    text: "That's a great try! Quick correction though — you'd say I went to /ðiː/ store.",
  },
  {
    label: "capitalized-with-break",
    text: "That's a great try! Quick correction though — you'd say I went to <break time=\"0.3s\"/>THE store.",
  },
  // Diagnostic round: isolating whether capitalization does anything at all on this setup, vs.
  // whether "the" specifically is just a bad test case (sentence-final, non-contrastive).
  {
    // Docs' own example word, verbatim — sanity check that capitalization has *any* audible effect
    // on this voice/model before concluding it doesn't work for "the".
    label: "capitalized-content-word-sanity-check",
    text: "That's a great try! But listen — we NEED to fix this before the exam.",
  },
  {
    // Same sentence said twice in one clip, plain then capitalized, so the A/B is back-to-back
    // instead of across two separately-generated files.
    label: "capitalized-back-to-back-pair",
    text:
      "Here's the sentence without emphasis: I went to the store. " +
      "Now with emphasis: I went to THE store.",
  },
  {
    // Strong-form "the" is a contrastive-stress phenomenon (per the correction-word-emphasis
    // spec) — a flat correction sentence may just be the wrong context to hear it land.
    label: "capitalized-contrastive-context",
    text: "That's a great try! I didn't say a store — I said THE store, the one we talked about.",
  },
  {
    // Same capitalized text as the main test, on the full (non-flash) model, in case emphasis is
    // weaker specifically on inworld-tts-2-flash.
    label: "capitalized-full-model",
    text: "That's a great try! Quick correction though — you'd say I went to THE store.",
    model: "inworld-tts-2",
  },
  // Inworld has no real SSML <emphasis> element — <break> is the only SSML tag they document.
  // The closest genuinely different mechanism is scoping a steering instruction tag tightly around
  // the single word via [reset], which only works on the full (non-flash) model.
  {
    label: "scoped-instruction-force",
    text: "That's a great try! Quick correction though — you'd say I went to [say with force] the [reset] store.",
    model: "inworld-tts-2",
  },
  {
    label: "scoped-instruction-emphasize",
    text: "That's a great try! Quick correction though — you'd say I went to [emphasize this word] the [reset] store.",
    model: "inworld-tts-2",
  },
];

async function main(): Promise<void> {
  const outputDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "tts-comparison",
    "inworld-emphasis",
  );
  await mkdir(outputDir, { recursive: true });

  const voiceId = process.env["INWORLD_VOICE_ID"] || "Sarah";
  const filter = process.argv[2];
  const variants = filter ? VARIANTS.filter((v) => v.label.includes(filter)) : VARIANTS;

  for (const { label, text, model } of variants) {
    const originalModel = process.env["INWORLD_MODEL"];
    if (model) process.env["INWORLD_MODEL"] = model;
    const result = await synthesizeInworld(text, voiceId);
    if (model) {
      if (originalModel === undefined) delete process.env["INWORLD_MODEL"];
      else process.env["INWORLD_MODEL"] = originalModel;
    }
    const filePath = path.join(outputDir, `${label}.mp3`);
    await writeAudioToFile(result.audio, filePath);
    console.log(`Wrote ${filePath} (${result.model})`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
