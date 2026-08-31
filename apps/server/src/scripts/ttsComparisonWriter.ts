import { writeFile } from "node:fs/promises";

async function drainToBuffer(audio: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Drains a streamed audio source and writes it to `filePath` as a single file, for local
 * listening comparisons. */
export async function writeAudioToFile(
  audio: AsyncIterable<Uint8Array>,
  filePath: string,
): Promise<void> {
  await writeFile(filePath, await drainToBuffer(audio));
}

/** Decodes a `data:<mime>;base64,<data>` URI into its raw bytes — the shape DeepInfra's
 * non-streaming CSM-1B inference endpoint returns its audio in. */
export function decodeDataUriAudio(dataUri: string): Buffer {
  const base64 = dataUri.split(",")[1];
  if (!dataUri.startsWith("data:") || !base64) {
    throw new Error(
      `Expected a data URI (data:<mime>;base64,<data>), got: ${dataUri.slice(0, 40)}`,
    );
  }
  return Buffer.from(base64, "base64");
}
