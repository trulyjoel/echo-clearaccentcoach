import { PRONUNCIATION_EDIT_OPS } from "@kalli/types";
import type { PronunciationEditOpKind } from "@kalli/types";
import { z } from "zod";
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

/** The pronunciation service is a separate, not-yet-built system reachable only over HTTP — its
 * response is untrusted input, not a value this codebase controls the shape of. String fields are
 * bounded because they flow unvalidated into the reply LLM's prompt via
 * `llm.ts`'s `buildPronunciationErrorContext`. */
const editOpSchema = z.object({
  word: z.string().max(200),
  wordIndex: z.number().int().nonnegative(),
  op: z.enum(PRONUNCIATION_EDIT_OPS),
  expectedPhoneme: z.string().max(50),
  spokenPhoneme: z.string().max(50).nullable(),
});

const scoreTurnResponseSchema = z.object({
  editOps: z.array(editOpSchema),
});

const SCORE_TURN_TIMEOUT_MS = 10_000;

class HttpPronunciationProvider implements PronunciationProvider {
  async scoreTurn(audio: Buffer, canonicalPhones: CanonicalWord[]): Promise<PronunciationEditOp[]> {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/webm" }), "turn.webm");
    form.append("canonical_phones", JSON.stringify(canonicalPhones));

    const response = await fetch(`${getServiceUrl()}/score`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(SCORE_TURN_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Pronunciation service request failed: ${response.status} ${body}`);
    }
    const parsed = scoreTurnResponseSchema.parse(await response.json());
    return parsed.editOps;
  }
}

let provider: PronunciationProvider | undefined;

/** Returns the swappable pronunciation-scoring provider used by the turn pipeline. */
export function getPronunciationProvider(): PronunciationProvider {
  provider ??= new HttpPronunciationProvider();
  return provider;
}
