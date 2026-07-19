export interface AuthMeResponse {
  userId: string;
}

/** Native languages with dedicated interference-pattern hints (ticket 09). Other L1s use "other". */
export const SUPPORTED_L1S = ["spanish", "mandarin", "vietnamese", "korean", "arabic"] as const;

export type SupportedL1 = (typeof SUPPORTED_L1S)[number];

export type L1 = SupportedL1 | "other";

export const L1_VALUES = [...SUPPORTED_L1S, "other"] as const;

export interface OnboardingStatusResponse {
  l1: L1 | null;
  consentGivenAt: string | null;
}

export interface OnboardingRequest {
  l1: L1;
  consent: boolean;
}

export const SESSION_END_REASONS = ["user_ended", "disconnected", "error", "max_duration"] as const;

export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** The generic (non-L1-specific) error taxonomy pass 1 tags each detected error with. */
export const ERROR_CATEGORIES = [
  "word_order",
  "verb_tense_aspect",
  "subject_verb_agreement",
  "article_usage",
  "preposition_choice",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface DetectedError {
  category: ErrorCategory;
  original: string;
  corrected: string;
  explanation: string;
}

/** A `DetectedError` once persisted, addressable for clip/target-audio playback (ticket 12). */
export interface PersistedError extends DetectedError {
  id: string;
  /** Whether a stored audio clip exists for this error's turn (ticket 11). */
  hasClip: boolean;
  /** Whether the clip is exempted from the 90-day expiry (ticket 13). Meaningless if !hasClip. */
  bookmarked: boolean;
}

/** A past session as listed in the error-history view (ticket 14). */
export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  endReason: SessionEndReason | null;
  turnCount: number;
  errorCount: number;
}

/** A `DetectedError` plus its id and timestamp, for a past session's error list (ticket 14). */
export interface HistoryErrorEntry extends DetectedError {
  id: string;
  createdAt: string;
}

export interface SessionErrorsResponse {
  session: SessionSummary;
  errors: HistoryErrorEntry[];
}

/** How often each error category occurred across a user's sessions (ticket 14). */
export interface CategoryFrequency {
  category: ErrorCategory;
  count: number;
}

/**
 * Sent from server to client over the /api/session WebSocket.
 *
 * The reply's synthesized audio is not part of this union — it's streamed as raw binary
 * frames alongside `reply_text_delta`/`reply_text`, mirroring how the client streams mic
 * audio up as binary frames alongside its own JSON control messages. Audio for a reply's first
 * completed sentence can begin streaming before that reply's `reply_text` (the full, final
 * string) is sent — the client opens its playback session on the first `reply_text_delta`
 * instead (ticket 17).
 *
 * `reply_interrupted` is sent instead of `reply_audio_end` when a reply's playback is cut short:
 * `reason: "barge_in"` for the user talking over it, `reason: "error"` for a mid-stream pipeline
 * failure (LLM generation or TTS synthesis). Either way the client should stop playing/discard
 * that reply's audio; the `reason` lets it distinguish the two for display purposes.
 */
export type ServerToClientMessage =
  | { type: "session_started"; sessionId: string }
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "end_of_turn" }
  | { type: "turn_errors"; turnId: string; createdAt: string; errors: PersistedError[] }
  | { type: "reply_text_delta"; text: string }
  | { type: "reply_text"; text: string }
  | { type: "reply_audio_end" }
  | { type: "reply_interrupted"; reason: "barge_in" | "error" }
  | { type: "session_ended"; reason: SessionEndReason }
  | { type: "error"; message: string };

/**
 * Sent from client to server over the /api/session WebSocket (JSON text frames only — audio is
 * sent as raw binary frames).
 *
 * `reply_playback_ended` is sent when the client's buffered reply audio finishes playing (or
 * fails to start playing) — the server has no other way to know when audible playback ends,
 * since it only streams the audio bytes and has no visibility into client-side playback.
 */
export type ClientToServerMessage = { type: "end_session" } | { type: "reply_playback_ended" };
