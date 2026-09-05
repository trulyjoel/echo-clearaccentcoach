import type { PronunciationEditOpKind } from "@kalli/types";
import type { CanonicalWord } from "./g2p.js";

/** One detected pronunciation deviation for a word at a specific position in the turn's
 * transcript, as returned by the pronunciation-scoring service. */
export interface PronunciationEditOp {
  word: string;
  wordIndex: number;
  op: PronunciationEditOpKind;
  expectedPhoneme: string;
  spokenPhoneme: string | null;
}

export interface PronunciationProvider {
  /** Scores a turn's audio against its canonical (target-accent) phone sequence, returning every
   * detected deviation. */
  scoreTurn(audio: Buffer, canonicalPhones: CanonicalWord[]): Promise<PronunciationEditOp[]>;
}

function getServiceUrl(): string {
  const url = process.env["PRONUNCIATION_SERVICE_URL"];
  if (!url) {
    throw new Error("PRONUNCIATION_SERVICE_URL is required (see apps/server/.env.example)");
  }
  return url;
}

interface ScoreTurnResponseBody {
  editOps: PronunciationEditOp[];
}

class HttpPronunciationProvider implements PronunciationProvider {
  async scoreTurn(audio: Buffer, canonicalPhones: CanonicalWord[]): Promise<PronunciationEditOp[]> {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/webm" }), "turn.webm");
    form.append("canonical_phones", JSON.stringify(canonicalPhones));

    const response = await fetch(`${getServiceUrl()}/score`, { method: "POST", body: form });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Pronunciation service request failed: ${response.status} ${body}`);
    }
    const parsed = (await response.json()) as ScoreTurnResponseBody;
    return parsed.editOps;
  }
}

let provider: PronunciationProvider | undefined;

/** Returns the swappable pronunciation-scoring provider used by the turn pipeline. */
export function getPronunciationProvider(): PronunciationProvider {
  provider ??= new HttpPronunciationProvider();
  return provider;
}
