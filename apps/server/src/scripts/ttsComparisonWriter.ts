import { writeFile } from "node:fs/promises";

/** Drains a streamed audio source and writes it to `filePath` as a single file, for local
 * listening comparisons. */
export async function writeAudioToFile(
  audio: AsyncIterable<Uint8Array>,
  filePath: string,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  await writeFile(filePath, Buffer.concat(chunks));
}
