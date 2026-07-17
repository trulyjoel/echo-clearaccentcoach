import { createAnthropic } from "@ai-sdk/anthropic";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  generateReply(history: ConversationMessage[]): Promise<string>;
}

const CALLIE_SYSTEM_PROMPT =
  "You are Callie, a warm, encouraging conversational English coach. Have a natural, " +
  "freeform back-and-forth with the learner — ask follow-up questions, keep replies " +
  "conversational and brief (a sentence or two), and keep the conversation moving.";

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
  async generateReply(history: ConversationMessage[]): Promise<string> {
    const { text } = await generateText({
      model: getClient()(getModelId()),
      system: CALLIE_SYSTEM_PROMPT,
      messages: history,
    });
    return text;
  }
}

let provider: LLMProvider | undefined;

/** Returns the swappable LLM provider used for both the reply pass and (later) analysis pass. */
export function getLLMProvider(): LLMProvider {
  provider ??= new AnthropicLLMProvider();
  return provider;
}
