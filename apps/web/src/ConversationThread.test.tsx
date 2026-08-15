import type { PersistedError } from "@kalli/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./ConversationThread.js";
import type { Turn, UserTurn } from "./conversationTurns.js";
import { makeError } from "./testFixtures.js";

describe("ConversationThread", () => {
  it("renders every turn's text in order", () => {
    const turns: Turn[] = [
      { kind: "user", status: "final", finalizedText: "hello there", interimText: "" },
      { kind: "assistant", status: "final", text: "Nice to meet you!" },
      { kind: "user", status: "live", finalizedText: "", interimText: "how are" },
    ];
    render(<ConversationThread turns={turns} />);

    const bubbles = screen.getAllByText(/hello there|Nice to meet you!|how are/);
    expect(bubbles.map((el) => el.textContent)).toEqual([
      "hello there",
      "Nice to meet you!",
      "how are",
    ]);
  });

  it("right-aligns and fills the user's turns in violet", () => {
    const turns: Turn[] = [
      { kind: "user", status: "final", finalizedText: "hello there", interimText: "" },
    ];
    render(<ConversationThread turns={turns} />);

    const bubble = screen.getByText("hello there");
    expect(bubble).toHaveClass("bg-violet-600");
    expect(bubble.parentElement).toHaveClass("justify-end");
  });

  it("left-aligns Kalli's turns in a neutral lavender tint", () => {
    const turns: Turn[] = [{ kind: "assistant", status: "final", text: "Nice job!" }];
    render(<ConversationThread turns={turns} />);

    const bubble = screen.getByText("Nice job!");
    expect(bubble).toHaveClass("bg-lavender-100");
    expect(bubble.parentElement).toHaveClass("justify-start");
  });

  it("combines a user turn's finalized text and still-arriving tail", () => {
    const turns: Turn[] = [
      { kind: "user", status: "live", finalizedText: "hello there", interimText: "how are" },
    ];
    render(<ConversationThread turns={turns} />);

    expect(screen.getByText("hello there how are")).toBeInTheDocument();
  });

  it("exposes the thread as a live region so a screen reader announces updates", () => {
    render(<ConversationThread turns={[]} />);

    const log = screen.getByRole("log", { name: "Conversation" });
    expect(log).toHaveAttribute("aria-live", "polite");
  });

  it("auto-scrolls to the newest turn as the conversation grows", () => {
    const { rerender } = render(<ConversationThread turns={[]} />);
    const log = screen.getByRole("log", { name: "Conversation" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 400 });

    rerender(
      <ConversationThread turns={[{ kind: "assistant", status: "final", text: "Nice job!" }]} />,
    );

    expect(log.scrollTop).toBe(400);
  });

  describe("Kalli's turn statuses", () => {
    it("shows a typing indicator, and no text, while pending", () => {
      const turns: Turn[] = [{ kind: "assistant", status: "pending", text: "" }];
      render(<ConversationThread turns={turns} />);

      expect(screen.getByRole("status", { name: "Kalli is typing" })).toBeInTheDocument();
    });

    it("shows the accumulated text plainly while streaming", () => {
      const turns: Turn[] = [{ kind: "assistant", status: "streaming", text: "Nice " }];
      render(<ConversationThread turns={turns} />);

      expect(screen.getByText("Nice")).toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Kalli is typing" })).not.toBeInTheDocument();
    });

    it("shows the full text plainly once final", () => {
      const turns: Turn[] = [{ kind: "assistant", status: "final", text: "Nice job!" }];
      render(<ConversationThread turns={turns} />);

      expect(screen.getByText("Nice job!")).toBeInTheDocument();
    });

    it("keeps the streamed-so-far text, visibly marked as cut off, once interrupted", () => {
      const turns: Turn[] = [{ kind: "assistant", status: "interrupted", text: "Nice j" }];
      render(<ConversationThread turns={turns} />);

      const bubble = screen.getByText("Nice j", { exact: false });
      expect(bubble).toHaveTextContent("Nice j");
      expect(bubble).toHaveTextContent("(cut off)");
    });
  });

  describe("inline flagged-error indicator", () => {
    function userTurnWithError(error: PersistedError): UserTurn {
      return {
        kind: "user",
        status: "final",
        finalizedText: "yesterday go I to the store",
        interimText: "",
        errors: [error],
        errorsCreatedAt: "2026-07-18T12:00:00.000Z",
      };
    }

    it("underlines a flagged span found verbatim in the turn's text", () => {
      const error = makeError({ original: "go I" });
      render(<ConversationThread turns={[userTurnWithError(error)]} />);

      const span = screen.getByText("go I");
      expect(span).toHaveClass("decoration-wavy");
    });

    it("does not underline anything when the flagged text isn't found verbatim", () => {
      const error = makeError({ original: "not in the text" });
      render(<ConversationThread turns={[userTurnWithError(error)]} />);

      expect(screen.queryByText("not in the text")).not.toBeInTheDocument();
      expect(screen.getByText("yesterday go I to the store")).toBeInTheDocument();
    });

    it("surfaces the correction and explanation via the span's title on hover", () => {
      const error = makeError({ original: "go I", corrected: "I go", explanation: "Word order." });
      render(<ConversationThread turns={[userTurnWithError(error)]} />);

      expect(screen.getByText("go I")).toHaveAttribute("title", "I go — Word order.");
    });

    it("calls onFlaggedSpanClick with the error's id when the span is clicked", async () => {
      const error = makeError({ original: "go I", id: "error-42" });
      const onFlaggedSpanClick = vi.fn();
      const user = userEvent.setup();
      render(
        <ConversationThread
          turns={[userTurnWithError(error)]}
          onFlaggedSpanClick={onFlaggedSpanClick}
        />,
      );

      await user.click(screen.getByText("go I"));

      expect(onFlaggedSpanClick).toHaveBeenCalledWith("error-42");
    });
  });
});
