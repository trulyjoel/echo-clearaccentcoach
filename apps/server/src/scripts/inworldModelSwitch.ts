import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { synthesizeInworld } from "../tts.js";
import { writeAudioToFile } from "./ttsComparisonWriter.js";

const execFileAsync = promisify(execFile);

const FLASH = "inworld-tts-2-flash";
const FULL = "inworld-tts-2";

/**
 * A longer, six-sentence stretch of realistic Kalli dialogue — long enough to actually hear each
 * model's baseline character, not just a two-second blip. Sentence 3 carries the emphasized word,
 * matching where a real correction would land in the hybrid-model design.
 */
const DIALOGUE = [
  "That's a great try! Your pronunciation is really coming along this week.",
  "I did notice one small thing worth fixing before we move on.",
  "Quick correction though — you'd say I went to THE store, not I went to store.",
  "It's a small word, but English speakers lean on it more than you'd expect.",
  "Want to try that sentence again, just the two of us going back and forth?",
  "Take your time — there's no rush, and you're doing better than you think.",
];

/**
 * Three renders of the same six sentences, so the comparison isolates one variable at a time:
 * `flash-only`/`full-only` establish each model's baseline character over a longer stretch,
 * `alternating` switches every sentence to stress-test how jarring a mid-reply model change
 * sounds when it happens repeatedly, not just once.
 */
const RUNS: { label: string; modelForIndex: (i: number) => string }[] = [
  { label: "flash-only", modelForIndex: () => FLASH },
  { label: "full-only", modelForIndex: () => FULL },
  { label: "alternating", modelForIndex: (i) => (i % 2 === 0 ? FLASH : FULL) },
];

async function synthesizeRun(
  label: string,
  modelForIndex: (i: number) => string,
  outputDir: string,
  voiceId: string,
): Promise<string> {
  const runDir = path.join(outputDir, label);
  await mkdir(runDir, { recursive: true });

  const originalModel = process.env["INWORLD_MODEL"];
  const partPaths: string[] = [];
  for (const [i, text] of DIALOGUE.entries()) {
    const model = modelForIndex(i);
    process.env["INWORLD_MODEL"] = model;
    const result = await synthesizeInworld(text, voiceId);
    const filePath = path.join(runDir, `${i}.mp3`);
    await writeAudioToFile(result.audio, filePath);
    partPaths.push(filePath);
    console.log(`[${label}] Wrote ${filePath} (${result.model})`);
  }
  if (originalModel === undefined) delete process.env["INWORLD_MODEL"];
  else process.env["INWORLD_MODEL"] = originalModel;

  const concatListPath = path.join(runDir, "concat-list.txt");
  await writeFile(concatListPath, partPaths.map((p) => `file '${p}'`).join("\n"));

  const combinedPath = path.join(outputDir, `${label}.mp3`);
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-c",
    "copy",
    combinedPath,
  ]);
  console.log(`Wrote ${combinedPath}`);
  return combinedPath;
}

async function main(): Promise<void> {
  const outputDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "tts-comparison",
    "inworld-emphasis",
    "model-switch",
  );
  await mkdir(outputDir, { recursive: true });

  const voiceId = process.env["INWORLD_VOICE_ID"] || "Sarah";
  const filter = process.argv[2];
  const runs = filter ? RUNS.filter((r) => r.label.includes(filter)) : RUNS;

  for (const { label, modelForIndex } of runs) {
    await synthesizeRun(label, modelForIndex, outputDir, voiceId);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
