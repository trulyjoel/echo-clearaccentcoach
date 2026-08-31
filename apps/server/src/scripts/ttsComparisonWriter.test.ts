import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeDataUriAudio, writeAudioToFile } from "./ttsComparisonWriter.js";

describe("writeAudioToFile", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("concatenates streamed chunks into a single file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tts-comparison-test-"));
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5]);
    }
    const filePath = path.join(dir, "out.mp3");

    await writeAudioToFile(chunks(), filePath);

    expect(await readFile(filePath)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });
});

describe("decodeDataUriAudio", () => {
  it("decodes the base64 payload of a data URI", () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const dataUri = `data:audio/wav;base64,${bytes.toString("base64")}`;

    expect(decodeDataUriAudio(dataUri)).toEqual(bytes);
  });

  it("throws a clear error when given a string that isn't a data URI", () => {
    expect(() => decodeDataUriAudio("not a data uri")).toThrow("data URI");
  });
});
