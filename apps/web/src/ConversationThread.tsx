import { useEffect, useRef } from "react";
import type { AssistantTurn, Turn, UserTurn } from "./conversationTurns.js";
import { userTurnText } from "./conversationTurns.js";
import { matchFlaggedSpans, splitIntoSegments } from "./inlineErrorMatch.js";

const TYPING_DOT_CLASS = "h-2 w-2 animate-bounce rounded-full bg-lavender-400";
const FLAGGED_SPAN_CLASS =
  "cursor-pointer underline decoration-wavy decoration-2 decoration-red-400 underline-offset-4";
const USER_BUBBLE_CLASS =
  "max-w-[75%] rounded-2xl rounded-br-sm bg-violet-600 px-4 py-2 text-white";
const ASSISTANT_BUBBLE_CLASS =
  "max-w-[75%] rounded-2xl rounded-bl-sm bg-lavender-100 px-4 py-2 text-lavender-900";

/** Three bouncing dots shown in Kalli's bubble position while her reply is still generating. */
function TypingIndicator() {
  return (
    <span role="status" aria-label="Kalli is typing" className="flex items-center gap-1 px-1 py-1">
      <span className={`${TYPING_DOT_CLASS} [animation-delay:-0.3s]`} />
      <span className={`${TYPING_DOT_CLASS} [animation-delay:-0.15s]`} />
      <span className={TYPING_DOT_CLASS} />
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

/**
 * Renders a user turn's text with a wavy underline on any span whose flagged error text was
 * found verbatim — in addition to (not instead of) that error's entry in the corrections panel.
 */
function UserBubbleContent({
  turn,
  onFlaggedSpanClick,
}: {
  turn: UserTurn;
  onFlaggedSpanClick?: ((errorId: string) => void) | undefined;
}) {
  const text = userTurnText(turn);
  const matches = matchFlaggedSpans(text, turn.errors ?? []);
  if (matches.length === 0) return <>{text}</>;

  return (
    <>
      {splitIntoSegments(text, matches).map((segment, index) =>
        segment.error ? (
          <span
            key={index}
            className={FLAGGED_SPAN_CLASS}
            title={`${segment.error.corrected} — ${segment.error.explanation}`}
            onClick={() => onFlaggedSpanClick?.(segment.error!.id)}
          >
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function TurnBubble({
  turn,
  onFlaggedSpanClick,
}: {
  turn: Turn;
  onFlaggedSpanClick?: ((errorId: string) => void) | undefined;
}) {
  if (turn.kind === "user") {
    return (
      <div className="flex justify-end">
        <p className={USER_BUBBLE_CLASS}>
          <UserBubbleContent turn={turn} onFlaggedSpanClick={onFlaggedSpanClick} />
        </p>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <p className={ASSISTANT_BUBBLE_CLASS}>
        <AssistantBubbleContent turn={turn} />
      </p>
    </div>
  );
}

/** Renders the full session history as a scrolling thread of speech bubbles. */
export function ConversationThread({
  turns,
  onFlaggedSpanClick,
}: {
  turns: readonly Turn[];
  onFlaggedSpanClick?: ((errorId: string) => void) | undefined;
}) {
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
        <TurnBubble key={index} turn={turn} onFlaggedSpanClick={onFlaggedSpanClick} />
      ))}
    </div>
  );
}
