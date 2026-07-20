import { useEffect, useRef } from "react";
import { type Turn, userTurnText } from "./conversationTurns.js";

function TurnBubble({ turn }: { turn: Turn }) {
  if (turn.kind === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[75%] rounded-2xl rounded-br-sm bg-violet-600 px-4 py-2 text-white">
          {userTurnText(turn)}
        </p>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <p className="max-w-[75%] rounded-2xl rounded-bl-sm bg-lavender-100 px-4 py-2 text-lavender-900">
        {turn.text}
      </p>
    </div>
  );
}

/** Renders the full session history as a scrolling thread of speech bubbles. */
export function ConversationThread({ turns }: { turns: readonly Turn[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [turns]);

  return (
    <div
      ref={containerRef}
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-4"
    >
      {/* Index is a stable key here: turns only ever append, never reorder or get removed. */}
      {turns.map((turn, index) => (
        <TurnBubble key={index} turn={turn} />
      ))}
    </div>
  );
}
