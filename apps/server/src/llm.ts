import { createAnthropic } from "@ai-sdk/anthropic";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { DetectedError } from "./errorTaxonomy.js";
import { ERROR_CATEGORIES } from "./errorTaxonomy.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  /** Pass 1: tags a turn's transcript with grammar errors across the generic taxonomy. */
  analyzeErrors(transcript: string): Promise<DetectedError[]>;
  /** Pass 2: generates a reply, weaving in a correction for the most relevant error, if any. */
  generateReply(history: ConversationMessage[], errors: DetectedError[]): Promise<string>;
}

const CALLIE_SYSTEM_PROMPT =
  "You are Callie, a warm, encouraging conversational English coach. Have a natural, " +
  "freeform back-and-forth with the learner — ask follow-up questions, keep replies " +
  "conversational and brief (a sentence or two), and keep the conversation moving.";

const ANALYSIS_SYSTEM_PROMPT =
  "You are an English grammar analyst reviewing a language learner's spoken utterance. " +
  "Identify grammar errors, tagging each with exactly one of these categories: " +
  `${ERROR_CATEGORIES.join(", ")}. For each error, give the original text, the corrected ` +
  "text, and a brief explanation aimed at the learner. Only flag genuine errors — return an " +
  "empty list if the utterance is grammatically correct.";

const errorAnalysisSchema = z.object({
  errors: z.array(
    z.object({
      category: z.enum(ERROR_CATEGORIES),
      original: z.string(),
      corrected: z.string(),
      explanation: z.string(),
    }),
  ),
});

/** Builds pass 2's system prompt, instructing it to weave in at most one correction. */
function buildReplySystemPrompt(errors: DetectedError[]): string {
  if (errors.length === 0) {
    return (
      `${CALLIE_SYSTEM_PROMPT}\n\n` +
      "The learner's last message had no detected errors — reply naturally, with no correction."
    );
  }
  const errorList = errors
    .map(
      (error) =>
        `- [${error.category}] "${error.original}" -> "${error.corrected}": ${error.explanation}`,
    )
    .join("\n");
  return (
    `${CALLIE_SYSTEM_PROMPT}\n\n` +
    `The learner's last message had these errors:\n${errorList}\n\n` +
    "Pick the single most relevant one and weave a brief, natural spoken correction into your " +
    "reply. Don't list every error or lecture — keep the conversation moving."
  );
}

function getApiKey(): string {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

function getModelId(): string {
  return process.env["LLM_MODEL"] ?? "claude-sonnet-5";
}

let client: AnthropicProvider | undefined;

function getClient(): AnthropicProvider {
  client ??= createAnthropic({ apiKey: getApiKey() });
  return client;
}

class AnthropicLLMProvider implements LLMProvider {
  async analyzeErrors(transcript: string): Promise<DetectedError[]> {
    const { object } = await generateObject({
      model: getClient()(getModelId()),
      schema: errorAnalysisSchema,
      system: ANALYSIS_SYSTEM_PROMPT,
      prompt: transcript,
    });
    return object.errors;
  }

  async generateReply(history: ConversationMessage[], errors: DetectedError[]): Promise<string> {
    const { text } = await generateText({
      model: getClient()(getModelId()),
      system: buildReplySystemPrompt(errors),
      messages: history,
    });
    return text;
  }
}

let provider: LLMProvider | undefined;

/** Returns the swappable LLM provider used for both the analysis pass and the reply pass. */
export function getLLMProvider(): LLMProvider {
  provider ??= new AnthropicLLMProvider();
  return provider;
}
