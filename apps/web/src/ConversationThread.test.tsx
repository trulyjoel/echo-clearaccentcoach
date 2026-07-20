import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationThread } from "./ConversationThread.js";
import type { Turn } from "./conversationTurns.js";

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

  it("left-aligns Callie's turns in a neutral lavender tint", () => {
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
      <ConversationThread
        turns={[{ kind: "assistant", status: "final", text: "Nice job!" }]}
      />,
    );

    expect(log.scrollTop).toBe(400);
  });
});
