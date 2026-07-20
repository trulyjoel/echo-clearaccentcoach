import { useEffect, useRef } from "react";
import type { AssistantTurn, Turn } from "./conversationTurns.js";
import { userTurnText } from "./conversationTurns.js";

/** Three bouncing dots shown in Callie's bubble position while her reply is still being generated. */
function TypingIndicator() {
  return (
    <span role="status" aria-label="Callie is typing" className="flex items-center gap-1 px-1 py-1">
      <span className="h-2 w-2 animate-bounce rounded-full bg-lavender-400 [animation-delay:-0.3s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-lavender-400 [animation-delay:-0.15s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-lavender-400" />
    </span>
  );
}

function AssistantBubbleContent({ turn }: { turn: AssistantTurn }) {
  if (turn.status === "pending") return <TypingIndicator />;
  return (
    <>
      {turn.text}
      {turn.status === "interrupted" && (
        <span className="ml-1 text-xs italic text-lavender-500">(cut off)</span>
      )}
    </>
  );
}

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
        <AssistantBubbleContent turn={turn} />
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
