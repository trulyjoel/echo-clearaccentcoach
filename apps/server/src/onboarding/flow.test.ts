import { describe, expect, it } from "vitest";
import type { OnboardingExtraction } from "./extract.js";
import { startOnboarding, submitAnswer, submitConfirmation } from "./flow.js";

function confident(overrides: Partial<OnboardingExtraction> = {}): OnboardingExtraction {
  return { value: null, l1: null, proficiency: null, confident: true, ...overrides };
}

function unclear(overrides: Partial<OnboardingExtraction> = {}): OnboardingExtraction {
  return { value: null, l1: null, proficiency: null, confident: false, ...overrides };
}

describe("startOnboarding", () => {
  it("starts on the name field, asking for it", () => {
    const { state, say } = startOnboarding();

    expect(state.field).toBe("name");
    expect(state.phase).toBe("asking");
    expect(say).toContain("call you");
  });
});

describe("submitAnswer — confident on the first try", () => {
  it("moves to the confirming phase and reads the value back", () => {
    const { state } = startOnboarding();

    const result = submitAnswer(state, confident({ value: "Maria" }));

    expect(result.done).toBe(false);
    if (result.done) throw new Error("unreachable");
    expect(result.state.phase).toBe("confirming");
    expect(result.state.pendingValue).toBe("Maria");
    expect(result.say).toContain("Maria");
  });
});

describe("submitAnswer — low confidence twice", () => {
  it("rephrases once, then accepts the best-effort value and moves on without confirming", () => {
    const { state } = startOnboarding();

    const first = submitAnswer(state, unclear());
    expect(first.done).toBe(false);
    if (first.done) throw new Error("unreachable");
    expect(first.state.attempts).toBe(1);
    expect(first.state.field).toBe("name");

    const second = submitAnswer(first.state, unclear({ value: "sort of Maria" }));
    expect(second.done).toBe(false);
    if (second.done) throw new Error("unreachable");
    expect(second.state.field).toBe("l1");
    expect(second.state.collected.name).toBe("sort of Maria");
  });

  it("falls back to the fixed default when the second attempt has no value either", () => {
    let { state } = startOnboarding();
    for (const field of ["name", "l1", "proficiency"] as const) {
      const first = submitAnswer(state, unclear());
      if (first.done) throw new Error("unreachable");
      state = first.state;
      const second = submitAnswer(state, unclear());
      if (second.done) throw new Error("unreachable");
      state = second.state;
      expect(state.field).not.toBe(field);
    }

    expect(state.field).toBe("context");
    const first = submitAnswer(state, unclear());
    if (first.done) throw new Error("unreachable");
    const second = submitAnswer(first.state, unclear());
    if (second.done) throw new Error("unreachable");
    expect(second.state.collected.context).toBe("general everyday communication");
  });
});

describe("submitConfirmation — confirm then reject then accept", () => {
  it("commits the value and advances on yes", () => {
    const { state } = startOnboarding();
    const asked = submitAnswer(state, confident({ value: "Maria" }));
    if (asked.done) throw new Error("unreachable");

    const result = submitConfirmation(asked.state, true);

    expect(result.done).toBe(false);
    if (result.done) throw new Error("unreachable");
    expect(result.state.field).toBe("l1");
    expect(result.state.collected.name).toBe("Maria");
  });

  it("re-asks once on the first rejection, then accepts on the second rejection", () => {
    const { state } = startOnboarding();
    const asked = submitAnswer(state, confident({ value: "Maria" }));
    if (asked.done) throw new Error("unreachable");

    const rejected = submitConfirmation(asked.state, false);
    expect(rejected.done).toBe(false);
    if (rejected.done) throw new Error("unreachable");
    expect(rejected.state.phase).toBe("asking");
    expect(rejected.state.field).toBe("name");
    expect(rejected.state.attempts).toBe(1);

    const reAsked = submitAnswer(rejected.state, confident({ value: "Mari" }));
    if (reAsked.done) throw new Error("unreachable");
    const rejectedAgain = submitConfirmation(reAsked.state, false);

    expect(rejectedAgain.done).toBe(false);
    if (rejectedAgain.done) throw new Error("unreachable");
    expect(rejectedAgain.state.field).toBe("l1");
    expect(rejectedAgain.state.collected.name).toBe("Mari");
  });
});

describe("the l1 and proficiency steps", () => {
  function advanceTo(field: "l1" | "proficiency") {
    let { state } = startOnboarding();
    while (state.field !== field) {
      const result = submitAnswer(state, confident({ value: "x" }));
      if (result.done) throw new Error("unreachable");
      const confirmed = submitConfirmation(result.state, true);
      if (confirmed.done) throw new Error("unreachable");
      state = confirmed.state;
    }
    return state;
  }

  it("collects l1 from the extraction's l1 field, not value", () => {
    const state = advanceTo("l1");
    const asked = submitAnswer(state, confident({ value: "Spanish", l1: "spanish" }));
    if (asked.done) throw new Error("unreachable");
    const confirmed = submitConfirmation(asked.state, true);
    if (confirmed.done) throw new Error("unreachable");

    expect(confirmed.state.collected.l1).toBe("spanish");
  });

  it("collects proficiency from the extraction's proficiency field, not value", () => {
    const state = advanceTo("proficiency");
    const asked = submitAnswer(
      state,
      confident({ value: "intermediate", proficiency: "intermediate" }),
    );
    if (asked.done) throw new Error("unreachable");
    const confirmed = submitConfirmation(asked.state, true);
    if (confirmed.done) throw new Error("unreachable");

    expect(confirmed.state.collected.proficiency).toBe("intermediate");
  });
});

describe("the goals question", () => {
  it("references the just-collected context value", () => {
    let { state } = startOnboarding();
    for (const value of ["Maria", "spanish", "intermediate"]) {
      const asked = submitAnswer(state, confident({ value, l1: "spanish", proficiency: "intermediate" }));
      if (asked.done) throw new Error("unreachable");
      const confirmed = submitConfirmation(asked.state, true);
      if (confirmed.done) throw new Error("unreachable");
      state = confirmed.state;
    }
    expect(state.field).toBe("context");

    const askedContext = submitAnswer(state, confident({ value: "work meetings" }));
    if (askedContext.done) throw new Error("unreachable");
    const confirmedContext = submitConfirmation(askedContext.state, true);
    if (confirmedContext.done) throw new Error("unreachable");

    expect(confirmedContext.state.field).toBe("goals");
    expect(confirmedContext.say).toContain("work meetings");
  });
});

describe("the name field's spell-out fallback", () => {
  it("asks the learner to spell it on the first low-confidence attempt, and reads it back letter by letter", () => {
    const { state } = startOnboarding();

    const first = submitAnswer(state, unclear());
    if (first.done) throw new Error("unreachable");
    expect(first.state.spelling).toBe(true);
    expect(first.say.toLowerCase()).toContain("spell");

    const spelled = submitAnswer(first.state, confident({ value: "Maria" }));
    if (spelled.done) throw new Error("unreachable");
    expect(spelled.state.phase).toBe("confirming");
    expect(spelled.say).toBe("Got it — M, a, r, i, a. Is that right?");
  });
});

describe("full completion", () => {
  it("returns done: true with every field once goals is confirmed", () => {
    let { state } = startOnboarding();
    const answers: Array<[string, Partial<OnboardingExtraction>]> = [
      ["name", { value: "Maria" }],
      ["l1", { value: "Spanish", l1: "spanish" }],
      ["proficiency", { value: "intermediate", proficiency: "intermediate" }],
      ["context", { value: "work meetings" }],
      ["goals", { value: "sounding more natural" }],
    ];

    let result;
    for (const [, extraction] of answers) {
      const asked = submitAnswer(state, confident(extraction));
      if (asked.done) throw new Error("unreachable");
      result = submitConfirmation(asked.state, true);
      if (!result.done) state = result.state;
    }

    expect(result?.done).toBe(true);
    if (!result?.done) throw new Error("unreachable");
    expect(result.profile).toEqual({
      name: "Maria",
      l1: "spanish",
      proficiency: "intermediate",
      context: "work meetings",
      goals: "sounding more natural",
    });
  });
});
