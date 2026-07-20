import type { PersistedError } from "@callie/types";
import { describe, expect, it } from "vitest";
import {
  appendAssistantDelta,
  applyTranscript,
  attachTurnErrors,
  deriveCorrections,
  endTurn,
  finalizeAssistantText,
  finalizeAssistantTurn,
  interruptAssistantTurn,
  type Turn,
  userTurnText,
} from "./conversationTurns.js";

function makeError(overrides: Partial<PersistedError> = {}): PersistedError {
  return {
    id: "error-1",
    hasClip: false,
    bookmarked: false,
    category: "word_order",
    original: "go I",
    corrected: "I go",
    explanation: "Subject comes before the verb.",
    ...overrides,
  };
}

describe("applyTranscript", () => {
  it("starts a new live user turn with an interim tail when none is open", () => {
    const turns = applyTranscript([], "hello ther", false);
    expect(turns).toEqual([
      { kind: "user", status: "live", finalizedText: "", interimText: "hello ther" },
    ]);
  });

  it("replaces the interim tail as more of the same fragment arrives", () => {
    const turns = applyTranscript(
      [{ kind: "user", status: "live", finalizedText: "", interimText: "hello ther" }],
      "hello there",
      false,
    );
    expect(userTurnText(turns[0] as never)).toBe("hello there");
  });

  it("finalizes the interim tail into finalizedText and clears the tail", () => {
    const turns = applyTranscript(
      [{ kind: "user", status: "live", finalizedText: "", interimText: "hello ther" }],
      "hello there",
      true,
    );
    expect(turns).toEqual([
      { kind: "user", status: "live", finalizedText: "hello there", interimText: "" },
    ]);
  });

  it("appends a second finalized fragment onto the same still-open turn", () => {
    const turns = applyTranscript(
      [{ kind: "user", status: "live", finalizedText: "hello there", interimText: "" }],
      "how are you",
      true,
    );
    expect(userTurnText(turns[0] as never)).toBe("hello there how are you");
  });

  it("starts a fresh user turn once the previous one closed out", () => {
    const closed: Turn = { kind: "assistant", status: "final", text: "Nice!" };
    const turns = applyTranscript([closed], "next turn", false);
    expect(turns).toEqual([closed, { kind: "user", status: "live", finalizedText: "", interimText: "next turn" }]);
  });
});

describe("endTurn", () => {
  it("finalizes the open user turn and opens a pending assistant turn", () => {
    const turns = endTurn([
      { kind: "user", status: "live", finalizedText: "hello there", interimText: "" },
    ]);
    expect(turns).toEqual([
      { kind: "user", status: "final", finalizedText: "hello there", interimText: "" },
      { kind: "assistant", status: "pending", text: "" },
    ]);
  });

  it("still opens a pending assistant turn when there is no open user turn", () => {
    const turns = endTurn([]);
    expect(turns).toEqual([{ kind: "assistant", status: "pending", text: "" }]);
  });
});

describe("appendAssistantDelta", () => {
  it("transitions a pending turn to streaming with the first delta", () => {
    const turns = appendAssistantDelta([{ kind: "assistant", status: "pending", text: "" }], "Nice ");
    expect(turns).toEqual([{ kind: "assistant", status: "streaming", text: "Nice " }]);
  });

  it("accumulates further deltas onto the streaming turn", () => {
    const turns = appendAssistantDelta(
      [{ kind: "assistant", status: "streaming", text: "Nice " }],
      "job!",
    );
    expect(turns).toEqual([{ kind: "assistant", status: "streaming", text: "Nice job!" }]);
  });

  it("starts a new streaming turn defensively when none is open", () => {
    const turns = appendAssistantDelta([], "Nice job!");
    expect(turns).toEqual([{ kind: "assistant", status: "streaming", text: "Nice job!" }]);
  });

  it("starts a fresh streaming turn rather than appending onto a finalized one", () => {
    const turns = appendAssistantDelta(
      [{ kind: "assistant", status: "final", text: "First reply" }],
      "Second reply",
    );
    expect(turns).toEqual([
      { kind: "assistant", status: "final", text: "First reply" },
      { kind: "assistant", status: "streaming", text: "Second reply" },
    ]);
  });
});

describe("finalizeAssistantText", () => {
  it("replaces the accumulated delta text with the authoritative full string", () => {
    const turns = finalizeAssistantText(
      [{ kind: "assistant", status: "streaming", text: "Nice " }],
      "Nice job!",
    );
    expect(turns).toEqual([{ kind: "assistant", status: "streaming", text: "Nice job!" }]);
  });

  it("is a no-op when there is no assistant turn to finalize", () => {
    expect(finalizeAssistantText([], "Nice job!")).toEqual([]);
  });
});

describe("finalizeAssistantTurn", () => {
  it("marks the in-progress assistant turn final", () => {
    const turns = finalizeAssistantTurn([{ kind: "assistant", status: "streaming", text: "Nice job!" }]);
    expect(turns).toEqual([{ kind: "assistant", status: "final", text: "Nice job!" }]);
  });

  it("is a no-op when there is no assistant turn", () => {
    expect(finalizeAssistantTurn([])).toEqual([]);
  });
});

describe("interruptAssistantTurn", () => {
  it("clears the text on barge-in", () => {
    const turns = interruptAssistantTurn(
      [{ kind: "assistant", status: "streaming", text: "Nice job" }],
      "barge_in",
    );
    expect(turns).toEqual([{ kind: "assistant", status: "interrupted", text: "" }]);
  });

  it("keeps the text on a pipeline error", () => {
    const turns = interruptAssistantTurn(
      [{ kind: "assistant", status: "streaming", text: "Oh no" }],
      "error",
    );
    expect(turns).toEqual([{ kind: "assistant", status: "interrupted", text: "Oh no" }]);
  });

  it("tolerates an interrupt signal when no reply is in progress", () => {
    expect(interruptAssistantTurn([], "barge_in")).toEqual([]);
  });
});

describe("attachTurnErrors", () => {
  it("attaches errors to the most recently opened user turn", () => {
    const turns: Turn[] = [
      { kind: "user", status: "final", finalizedText: "go I", interimText: "" },
      { kind: "assistant", status: "pending", text: "" },
    ];
    const errors = [makeError()];
    const result = attachTurnErrors(turns, errors, "2026-07-18T12:00:00.000Z");
    expect(result[0]).toEqual({
      kind: "user",
      status: "final",
      finalizedText: "go I",
      interimText: "",
      errors,
      errorsCreatedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(result[1]).toEqual(turns[1]);
  });

  it("is a no-op when there is no user turn to attach to", () => {
    const turns: Turn[] = [{ kind: "assistant", status: "final", text: "Nice!" }];
    expect(attachTurnErrors(turns, [makeError()], "2026-07-18T12:00:00.000Z")).toEqual(turns);
  });
});

describe("deriveCorrections", () => {
  it("returns one entry per user turn with attached errors, in turn order", () => {
    const errorA = makeError({ id: "error-1", original: "go I" });
    const errorB = makeError({ id: "error-2", original: "I saw dog" });
    const turns: Turn[] = [
      {
        kind: "user",
        status: "final",
        finalizedText: "go I",
        interimText: "",
        errors: [errorA],
        errorsCreatedAt: "2026-07-18T12:00:00.000Z",
      },
      { kind: "assistant", status: "final", text: "Nice try!" },
      {
        kind: "user",
        status: "final",
        finalizedText: "I saw dog",
        interimText: "",
        errors: [errorB],
        errorsCreatedAt: "2026-07-18T12:01:00.000Z",
      },
    ];
    expect(deriveCorrections(turns)).toEqual([
      { createdAt: "2026-07-18T12:00:00.000Z", errors: [errorA] },
      { createdAt: "2026-07-18T12:01:00.000Z", errors: [errorB] },
    ]);
  });

  it("omits user turns with no attached errors", () => {
    const turns: Turn[] = [{ kind: "user", status: "final", finalizedText: "hi", interimText: "" }];
    expect(deriveCorrections(turns)).toEqual([]);
  });
});
