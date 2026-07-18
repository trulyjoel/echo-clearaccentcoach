import { createAnthropic } from "@ai-sdk/anthropic";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { DetectedError, L1, SupportedL1 } from "@callie/types";
import { ERROR_CATEGORIES } from "@callie/types";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { L1_INTERFERENCE_HINTS } from "./l1Hints.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AnalysisResult {
  errors: DetectedError[];
  usage: TokenUsage;
}

export interface ReplyResult {
  text: string;
  usage: TokenUsage;
}

export interface LLMProvider {
  /** Pass 1: tags a turn's transcript with grammar errors, biased by the learner's L1. */
  analyzeErrors(transcript: string, l1: L1): Promise<AnalysisResult>;
  /** Pass 2: generates a reply, weaving in a correction for the most relevant error, if any. */
  generateReply(history: ConversationMessage[], errors: DetectedError[]): Promise<ReplyResult>;
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

function isSupportedL1(l1: L1): l1 is SupportedL1 {
  return l1 !== "other";
}

/** Builds pass 1's system prompt, biased toward the learner's L1 interference patterns. */
export function buildAnalysisSystemPrompt(l1: L1): string {
  if (!isSupportedL1(l1)) return ANALYSIS_SYSTEM_PROMPT;
  return (
    `${ANALYSIS_SYSTEM_PROMPT}\n\n` +
    `The learner's native language is ${l1}. Bias your detection toward interference patterns ` +
    `known to be common for ${l1} speakers: ${L1_INTERFERENCE_HINTS[l1]} These hints inform ` +
    "detection — keep categorizing every detected error using only the five categories above."
  );
}

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

function toTokenUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): TokenUsage {
  return { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
}

class AnthropicLLMProvider implements LLMProvider {
  async analyzeErrors(transcript: string, l1: L1): Promise<AnalysisResult> {
    const { object, usage } = await generateObject({
      model: getClient()(getModelId()),
      schema: errorAnalysisSchema,
      system: buildAnalysisSystemPrompt(l1),
      prompt: transcript,
    });
    return { errors: object.errors, usage: toTokenUsage(usage) };
  }

  async generateReply(
    history: ConversationMessage[],
    errors: DetectedError[],
  ): Promise<ReplyResult> {
    const { text, usage } = await generateText({
      model: getClient()(getModelId()),
      system: buildReplySystemPrompt(errors),
      messages: history,
    });
    return { text, usage: toTokenUsage(usage) };
  }
}

let provider: LLMProvider | undefined;

/** Returns the swappable LLM provider used for both the analysis pass and the reply pass. */
export function getLLMProvider(): LLMProvider {
  provider ??= new AnthropicLLMProvider();
  return provider;
}
