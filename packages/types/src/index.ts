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

export const SESSION_END_REASONS = ["user_ended", "disconnected", "error"] as const;

export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * Sent from server to client over the /api/session WebSocket.
 *
 * The reply's synthesized audio is not part of this union — it's streamed as raw binary
 * frames between `reply_text` and `reply_audio_end`, mirroring how the client streams mic
 * audio up as binary frames alongside its own JSON control messages.
 */
export type ServerToClientMessage =
  | { type: "session_started"; sessionId: string }
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "end_of_turn" }
  | { type: "reply_text"; text: string }
  | { type: "reply_audio_end" }
  | { type: "session_ended"; reason: SessionEndReason }
  | { type: "error"; message: string };

/** Sent from client to server over the /api/session WebSocket (JSON text frames only — audio is sent as raw binary frames). */
export type ClientToServerMessage = { type: "end_session" };
