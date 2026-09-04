import type { L1, ProficiencyLevel } from "@kalli/types";
import type { OnboardingExtraction, OnboardingField } from "./extract.js";

export type OnboardingPhase = "asking" | "confirming";

export interface OnboardingProfile {
  name: string | null;
  l1: L1 | null;
  proficiency: ProficiencyLevel | null;
  context: string | null;
  goals: string | null;
}

export interface OnboardingState {
  field: OnboardingField;
  phase: OnboardingPhase;
  /** Extraction attempts spent on the current field: 0 on the first try, 1 after one rephrase. */
  attempts: number;
  /** `name` field only — set once the spell-out fallback has been invoked for it. */
  spelling: boolean;
  pendingValue: string | null;
  pendingL1: L1 | null;
  pendingProficiency: ProficiencyLevel | null;
  collected: OnboardingProfile;
}

export type OnboardingResult =
  | { done: false; state: OnboardingState; say: string }
  | {
      done: true;
      profile: { name: string; l1: L1; proficiency: ProficiencyLevel; context: string; goals: string };
    };

const FIELD_ORDER: readonly OnboardingField[] = ["name", "l1", "proficiency", "context", "goals"];

const FIELD_DEFAULTS: Record<OnboardingField, string> = {
  name: "there",
  l1: "other",
  proficiency: "intermediate",
  context: "general everyday communication",
  goals: "general accent reduction",
};

const INITIAL_STATE: OnboardingState = {
  field: "name",
  phase: "asking",
  attempts: 0,
  spelling: false,
  pendingValue: null,
  pendingL1: null,
  pendingProficiency: null,
  collected: { name: null, l1: null, proficiency: null, context: null, goals: null },
};

function askQuestion(state: OnboardingState): string {
  switch (state.field) {
    case "name":
      return "Hey, I'm Kalli! Before we get started, what should I call you?";
    case "l1":
      return "Nice to meet you! What's your native language?";
    case "proficiency":
      return "And how would you describe your English right now — beginner, intermediate, or advanced?";
    case "context":
      return "What's your English mostly for these days — work, travel, moving somewhere new, everyday life?";
    case "goals": {
      const context = state.collected.context ?? "that";
      return (
        `Since it's mostly for ${context}, what would you like to focus on — pronunciation, ` +
        "grammar, sounding more natural, whatever comes to mind?"
      );
    }
  }
}

function rephraseLine(state: OnboardingState): string {
  if (state.field === "name" && state.spelling) return "Could you spell that for me?";
  return "Sorry, could you say that again?";
}

function confirmationLine(state: OnboardingState): string {
  if (state.field === "name" && state.spelling && state.pendingValue) {
    const letters = state.pendingValue.split("").join(", ");
    return `Got it — ${letters}. Is that right?`;
  }
  if (state.field === "l1") return `Got it, ${state.pendingL1 ?? "that"} — is that right?`;
  if (state.field === "proficiency") {
    return `Got it, ${state.pendingProficiency ?? "that"} — is that right?`;
  }
  return `Got it, ${state.pendingValue ?? "that"} — is that right?`;
}

function resolveFieldValue(
  field: OnboardingField,
  extraction: Pick<OnboardingExtraction, "value" | "l1" | "proficiency">,
): string {
  if (field === "l1") return extraction.l1 ?? FIELD_DEFAULTS.l1;
  if (field === "proficiency") return extraction.proficiency ?? FIELD_DEFAULTS.proficiency;
  return extraction.value ?? FIELD_DEFAULTS[field];
}

/**
 * `value` is always already a valid enum member for `"l1"`/`"proficiency"` — `resolveFieldValue`
 * only ever produces it from `extraction.l1`/`extraction.proficiency` (already typed to the enum)
 * or from `FIELD_DEFAULTS.l1`/`FIELD_DEFAULTS.proficiency` (literal enum members) — so the casts
 * below are narrowing back to what the value already was, not asserting something unverified.
 */
function withCollectedField(
  collected: OnboardingProfile,
  field: OnboardingField,
  value: string,
): OnboardingProfile {
  switch (field) {
    case "name":
      return { ...collected, name: value };
    case "l1":
      return { ...collected, l1: value as L1 };
    case "proficiency":
      return { ...collected, proficiency: value as ProficiencyLevel };
    case "context":
      return { ...collected, context: value };
    case "goals":
      return { ...collected, goals: value };
  }
}

function commitAndAdvance(
  state: OnboardingState,
  extraction: Pick<OnboardingExtraction, "value" | "l1" | "proficiency">,
): OnboardingResult {
  const value = resolveFieldValue(state.field, extraction);
  const collected = withCollectedField(state.collected, state.field, value);
  const currentIndex = FIELD_ORDER.indexOf(state.field);
  const nextField = FIELD_ORDER[currentIndex + 1];

  if (!nextField) {
    const { name, l1, proficiency, context, goals } = collected;
    if (!name || !l1 || !proficiency || !context || !goals) {
      throw new Error("Onboarding finished with an incomplete profile");
    }
    return { done: true, profile: { name, l1, proficiency, context, goals } };
  }

  const nextState: OnboardingState = {
    field: nextField,
    phase: "asking",
    attempts: 0,
    spelling: false,
    pendingValue: null,
    pendingL1: null,
    pendingProficiency: null,
    collected,
  };
  return { done: false, state: nextState, say: askQuestion(nextState) };
}

function handleLowConfidence(
  state: OnboardingState,
  extraction: OnboardingExtraction,
): OnboardingResult {
  if (state.attempts === 0) {
    const nextState: OnboardingState = {
      ...state,
      attempts: 1,
      spelling: state.field === "name",
    };
    return { done: false, state: nextState, say: rephraseLine(nextState) };
  }
  return commitAndAdvance(state, extraction);
}

/** Starts a fresh onboarding flow — the first thing an onboarding-mode session speaks. */
export function startOnboarding(): { state: OnboardingState; say: string } {
  return { state: INITIAL_STATE, say: askQuestion(INITIAL_STATE) };
}

/** Advances the flow after a turn during the `"asking"` phase. */
export function submitAnswer(
  state: OnboardingState,
  extraction: OnboardingExtraction,
): OnboardingResult {
  if (!extraction.confident) return handleLowConfidence(state, extraction);

  const nextState: OnboardingState = {
    ...state,
    phase: "confirming",
    pendingValue: extraction.value,
    pendingL1: extraction.l1,
    pendingProficiency: extraction.proficiency,
  };
  return { done: false, state: nextState, say: confirmationLine(nextState) };
}

/** Advances the flow after a turn during the `"confirming"` phase. */
export function submitConfirmation(state: OnboardingState, confirmed: boolean): OnboardingResult {
  const pending = { value: state.pendingValue, l1: state.pendingL1, proficiency: state.pendingProficiency };

  if (confirmed) return commitAndAdvance(state, pending);

  if (state.attempts === 0) {
    const nextState: OnboardingState = {
      ...state,
      phase: "asking",
      attempts: 1,
      spelling: state.field === "name",
      pendingValue: null,
      pendingL1: null,
      pendingProficiency: null,
    };
    return { done: false, state: nextState, say: rephraseLine(nextState) };
  }

  // Second rejection: accept the pending value anyway rather than looping forever — the same
  // hard cap on rounds per field as the low-confidence path.
  return commitAndAdvance(state, pending);
}
