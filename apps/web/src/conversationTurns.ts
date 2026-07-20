import type { PersistedError } from "@callie/types";

export interface UserTurn {
  kind: "user";
  status: "live" | "final";
  /** Finalized transcript fragments for this turn, joined as they arrive. */
  finalizedText: string;
  /** The still-arriving, not-yet-finalized tail. Always "" once the turn is `final`. */
  interimText: string;
  errors?: PersistedError[];
  errorsCreatedAt?: string;
}

export interface AssistantTurn {
  kind: "assistant";
  status: "pending" | "streaming" | "final" | "interrupted";
  text: string;
}

export type Turn = UserTurn | AssistantTurn;

/** The text a user turn should render, combining what's finalized so far with the live tail. */
export function userTurnText(turn: UserTurn): string {
  return [turn.finalizedText, turn.interimText].filter(Boolean).join(" ");
}

function lastTurn(turns: readonly Turn[]): Turn | undefined {
  return turns[turns.length - 1];
}

/**
 * Applies a `transcript` message: extends the currently-open (live) user turn, or starts a new
 * one if the previous turn already closed out (or none exists yet). A turn stays `live` across
 * multiple finalized fragments — only `endTurn` (on `end_of_turn`) closes it out, since Deepgram
 * can finalize several utterance chunks within one still-ongoing conversational turn.
 */
export function applyTranscript(turns: readonly Turn[], text: string, isFinal: boolean): Turn[] {
  const last = lastTurn(turns);
  const open = last?.kind === "user" && last.status === "live" ? last : undefined;
  const finalizedText = isFinal
    ? [open?.finalizedText, text].filter(Boolean).join(" ")
    : (open?.finalizedText ?? "");
  const updated: UserTurn = {
    kind: "user",
    status: "live",
    finalizedText,
    interimText: isFinal ? "" : text,
  };
  return open ? [...turns.slice(0, -1), updated] : [...turns, updated];
}

/**
 * Applies `end_of_turn`: closes out the currently-open user turn (if any) and opens Callie's
 * next turn as a pending typing indicator, since her turn starts the instant the user's ends.
 */
export function endTurn(turns: readonly Turn[]): Turn[] {
  const last = lastTurn(turns);
  const closed: Turn[] =
    last?.kind === "user" && last.status === "live"
      ? [...turns.slice(0, -1), { ...last, status: "final" as const }]
      : turns.slice();
  const pending: AssistantTurn = { kind: "assistant", status: "pending", text: "" };
  return [...closed, pending];
}

/** Appends a streamed reply chunk, starting Callie's turn if a delta arrives with none open. */
export function appendAssistantDelta(turns: readonly Turn[], delta: string): Turn[] {
  const last = lastTurn(turns);
  if (last?.kind === "assistant" && last.status !== "final" && last.status !== "interrupted") {
    const updated: AssistantTurn = {
      kind: "assistant",
      status: "streaming",
      text: last.text + delta,
    };
    return [...turns.slice(0, -1), updated];
  }
  return [...turns, { kind: "assistant", status: "streaming", text: delta }];
}

/** Replaces Callie's in-progress reply text with the authoritative full string once it arrives. */
export function finalizeAssistantText(turns: readonly Turn[], text: string): Turn[] {
  const last = lastTurn(turns);
  if (last?.kind !== "assistant") return turns.slice();
  return [...turns.slice(0, -1), { ...last, text }];
}

/** Marks Callie's in-progress turn complete, once its audio finishes playing. */
export function finalizeAssistantTurn(turns: readonly Turn[]): Turn[] {
  const last = lastTurn(turns);
  if (last?.kind !== "assistant" || last.status === "final") return turns.slice();
  return [...turns.slice(0, -1), { ...last, status: "final" }];
}

/**
 * Marks Callie's in-progress turn cut short by barge-in or a pipeline error, keeping whatever
 * text had streamed so far (rather than discarding it) so the conversation history still reads
 * coherently.
 */
export function interruptAssistantTurn(turns: readonly Turn[]): Turn[] {
  const last = lastTurn(turns);
  if (last?.kind !== "assistant" || last.status === "final") return turns.slice();
  return [...turns.slice(0, -1), { ...last, status: "interrupted" }];
}

/**
 * Attaches a turn's detected errors to the most recently opened user turn. Safe under the
 * backend's single-in-flight-turn invariant: an interrupted turn never emits `turn_errors`, so
 * whichever user turn is last in the list is unambiguously the only one still eligible.
 */
export function attachTurnErrors(
  turns: readonly Turn[],
  errors: PersistedError[],
  createdAt: string,
): Turn[] {
  let lastUserIndex = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.kind === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) return turns.slice();
  const target = turns[lastUserIndex] as UserTurn;
  const updated: UserTurn = { ...target, errors, errorsCreatedAt: createdAt };
  return [...turns.slice(0, lastUserIndex), updated, ...turns.slice(lastUserIndex + 1)];
}

export interface TurnCorrections {
  createdAt: string;
  errors: PersistedError[];
}

/** Derives the corrections panel's list directly from the turn list — no separate state. */
export function deriveCorrections(turns: readonly Turn[]): TurnCorrections[] {
  const corrections: TurnCorrections[] = [];
  for (const turn of turns) {
    if (turn.kind === "user" && turn.errors && turn.errors.length > 0 && turn.errorsCreatedAt) {
      corrections.push({ createdAt: turn.errorsCreatedAt, errors: turn.errors });
    }
  }
  return corrections;
}
