import { createAnthropic } from "@ai-sdk/anthropic";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { DetectedError, L1, SupportedL1 } from "@kalli/types";
import { ERROR_CATEGORIES } from "@kalli/types";
import { generateObject, streamText } from "ai";
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
  model: string;
}

/**
 * Pass 2's streamed output (ticket 17). `textStream` yields deltas as the model generates them;
 * `usage` resolves once the stream finishes. There's no `text` field — callers that need the full
 * reply text accumulate it from `textStream` themselves, since they're consuming it anyway (to
 * detect sentence boundaries, forward deltas to the client, etc.).
 */
export interface ReplyStream {
  textStream: AsyncIterable<string>;
  usage: Promise<TokenUsage>;
  model: string;
}

export interface LLMProvider {
  /** Pass 1: tags a turn's transcript with grammar errors, biased by the learner's L1. */
  analyzeErrors(transcript: string, l1: L1): Promise<AnalysisResult>;
  /** Pass 2: streams a reply, weaving in a correction for the most relevant error, if any. */
  generateReply(history: ConversationMessage[], errors: DetectedError[]): ReplyStream;
}

const KALLI_SYSTEM_PROMPT =
  "You are Kalli, a warm, encouraging conversational English coach. Have a natural, " +
  "freeform back-and-forth with the learner — ask follow-up questions, keep replies " +
  "conversational and brief (a sentence or two), and keep the conversation moving. Sound like " +
  "a real person, not a scripted assistant — skip stock openers like \"Of course!\" or \"Happy " +
  "to help!\" and don't pose either/or menus of questions.";

const NO_ERROR_EXAMPLE =
  'Example — Learner: "Can you help me with my grammar?" Kalli: "Sure — just talk normally ' +
  'and I\'ll jump in when something\'s off."';

const ERROR_PRESENT_EXAMPLES =
  'Example — Learner: "I saw movie last night." Kalli: "What\'d you watch? Small thing — ' +
  '\'I saw a movie.\'"\n' +
  'Example — Learner: "I am living here since three years." Kalli: "Three years, that\'s a ' +
  'while — you\'d say \'I\'ve been living here for three years\' though."';

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
export function buildReplySystemPrompt(errors: DetectedError[]): string {
  if (errors.length === 0) {
    return (
      `${KALLI_SYSTEM_PROMPT}\n\n` +
      "The learner's last message had no detected errors — reply naturally, with no " +
      `correction.\n\n${NO_ERROR_EXAMPLE}`
    );
  }
  const errorList = errors
    .map(
      (error) =>
        `- [${error.category}] "${error.original}" -> "${error.corrected}": ${error.explanation}`,
    )
    .join("\n");
  return (
    `${KALLI_SYSTEM_PROMPT}\n\n` +
    `The learner's last message had these errors:\n${errorList}\n\n` +
    "Pick the single most relevant one and weave a brief, natural spoken correction into your " +
    `reply. Don't list every error or lecture — keep the conversation moving.\n\n` +
    ERROR_PRESENT_EXAMPLES
  );
}

function getApiKey(): string {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

function getReplyModelId(): string {
  return process.env["LLM_MODEL"] ?? "claude-sonnet-5";
}

/**
 * Pass 1 is structured error-tagging against a fixed taxonomy, a lighter task than pass 2's
 * conversational reply generation — defaults to a faster/cheaper model instead of sharing pass
 * 2's, since baseline testing found it a likely source of several seconds of turn latency.
 */
function getAnalysisModelId(): string {
  return process.env["ANALYSIS_LLM_MODEL"] ?? "claude-haiku-4-5-20251001";
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
    const model = getAnalysisModelId();
    const { object, usage } = await generateObject({
      model: getClient()(model),
      schema: errorAnalysisSchema,
      system: buildAnalysisSystemPrompt(l1),
      prompt: transcript,
    });
    return { errors: object.errors, usage: toTokenUsage(usage), model };
  }

  generateReply(history: ConversationMessage[], errors: DetectedError[]): ReplyStream {
    const model = getReplyModelId();
    const result = streamText({
      model: getClient()(model),
      system: buildReplySystemPrompt(errors),
      messages: history,
    });
    const usage = Promise.resolve(result.usage).then(toTokenUsage);
    return { textStream: result.textStream, usage, model };
  }
}

let provider: LLMProvider | undefined;

/** Returns the swappable LLM provider used for both the analysis pass and the reply pass. */
export function getLLMProvider(): LLMProvider {
  provider ??= new AnthropicLLMProvider();
  return provider;
}
