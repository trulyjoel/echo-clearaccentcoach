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
