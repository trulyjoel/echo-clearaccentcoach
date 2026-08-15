import type { ClientToServerMessage, PersistedError, ServerToClientMessage } from "@kalli/types";
import { useAuth } from "@clerk/react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, getApiBaseUrl } from "./api.js";
import { ConversationThread } from "./ConversationThread.js";
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
  type TurnCorrections,
} from "./conversationTurns.js";
import { CATEGORY_LABELS } from "./errorCategoryLabels.js";

type SessionState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "active"; sessionId: string; turns: Turn[] }
  | { status: "ended"; turns: Turn[] }
  | { status: "error"; message: string };

const PRIMARY_BUTTON_CLASS =
  "self-start rounded-md bg-lavender-600 px-4 py-2 font-medium text-white " +
  "hover:bg-lavender-700";
const OUTLINE_BUTTON_CLASS =
  "rounded-md border border-lavender-300 px-3 py-1 text-sm text-lavender-700 " +
  "hover:bg-lavender-100";
const SECONDARY_BUTTON_CLASS =
  "self-start rounded-md border border-lavender-300 px-4 py-2 font-medium " +
  "text-lavender-700 hover:bg-lavender-100";
const ALERT_CLASS = "rounded-md bg-red-50 px-3 py-2 text-sm text-red-700";
const CORRECTION_ENTRY_CLASS =
  "flex flex-col gap-2 rounded-md border bg-white p-3 shadow-sm transition-colors";
const CATEGORY_BADGE_CLASS =
  "rounded-full bg-lavender-100 px-2 py-0.5 text-xs font-medium text-lavender-800";

/** Fetches an authenticated audio endpoint and plays the response, revoking the blob URL after. */
async function fetchAndPlayAudio(path: string, token: string | null): Promise<void> {
  const response = await apiFetch(path, token);
  const objectUrl = URL.createObjectURL(await response.blob());
  const audio = new Audio(objectUrl);
  audio.addEventListener("ended", () => URL.revokeObjectURL(objectUrl), { once: true });
  await audio.play();
}

/** PATCHes the bookmark toggle endpoint and returns the clip's new bookmarked state. */
async function toggleBookmark(errorId: string, token: string | null): Promise<boolean> {
  const response = await apiFetch(`/api/errors/${errorId}/bookmark`, token, { method: "PATCH" });
  const body = (await response.json()) as { bookmarked: boolean };
  return body.bookmarked;
}

function CorrectionEntry({
  error,
  createdAt,
  highlighted,
  onPlay,
  onBookmark,
}: {
  error: PersistedError;
  createdAt: string;
  highlighted: boolean;
  onPlay: (path: string) => void;
  onBookmark: (errorId: string) => void;
}) {
  return (
    <li
      id={`correction-${error.id}`}
      className={`${CORRECTION_ENTRY_CLASS} ${
        highlighted ? "border-lavender-500 ring-2 ring-lavender-400" : "border-lavender-200"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={CATEGORY_BADGE_CLASS}>{CATEGORY_LABELS[error.category]}</span>
        <time dateTime={createdAt} className="text-xs text-lavender-500">
          {new Date(createdAt).toLocaleTimeString()}
        </time>
      </div>
      <p className="text-sm">
        <span className="text-lavender-500 line-through">{error.original}</span>{" "}
        <span aria-hidden="true">→</span>{" "}
        <span className="font-medium text-lavender-900">{error.corrected}</span>
      </p>
      <p className="text-sm text-lavender-700">{error.explanation}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        {error.hasClip && (
          <button
            className={OUTLINE_BUTTON_CLASS}
            onClick={() => onPlay(`/api/errors/${error.id}/clip`)}
          >
            Play my clip
          </button>
        )}
        <button
          className={OUTLINE_BUTTON_CLASS}
          onClick={() => onPlay(`/api/errors/${error.id}/target-audio`)}
        >
          Play target
        </button>
        {error.hasClip && (
          <button className={OUTLINE_BUTTON_CLASS} onClick={() => onBookmark(error.id)}>
            {error.bookmarked ? "Un-bookmark clip" : "Bookmark clip"}
          </button>
        )}
      </div>
    </li>
  );
}

function CorrectionsPanel({
  corrections,
  getToken,
  onBookmarkToggled,
  highlightedErrorId,
}: {
  corrections: TurnCorrections[];
  getToken: () => Promise<string | null>;
  onBookmarkToggled: (errorId: string, bookmarked: boolean) => void;
  highlightedErrorId?: string | null;
}) {
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);

  async function play(path: string): Promise<void> {
    setPlaybackError(null);
    try {
      await fetchAndPlayAudio(path, await getToken());
    } catch (error) {
      console.error("Failed to play audio", error);
      setPlaybackError("Couldn't play that audio.");
    }
  }

  async function bookmark(errorId: string): Promise<void> {
    setBookmarkError(null);
    try {
      const bookmarked = await toggleBookmark(errorId, await getToken());
      onBookmarkToggled(errorId, bookmarked);
    } catch (error) {
      console.error("Failed to toggle bookmark", error);
      setBookmarkError("Couldn't update the bookmark.");
    }
  }

  return (
    <aside
      aria-label="Corrections"
      className="flex flex-col gap-3 rounded-lg border border-lavender-200 bg-lavender-50 p-4"
    >
      {playbackError && (
        <p role="alert" className={ALERT_CLASS}>
          {playbackError}
        </p>
      )}
      {bookmarkError && (
        <p role="alert" className={ALERT_CLASS}>
          {bookmarkError}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {corrections.flatMap((correction) =>
          correction.errors.map((error) => (
            <CorrectionEntry
              key={error.id}
              error={error}
              createdAt={correction.createdAt}
              highlighted={error.id === highlightedErrorId}
              onPlay={(path) => void play(path)}
              onBookmark={(errorId) => void bookmark(errorId)}
            />
          )),
        )}
      </ul>
    </aside>
  );
}

function buildSessionUrl(token: string | null): string {
  const base = getApiBaseUrl() || window.location.origin;
  const wsBase = base.replace(/^http/, "ws");
  return token
    ? `${wsBase}/api/session?token=${encodeURIComponent(token)}`
    : `${wsBase}/api/session`;
}

/** One in-flight reply's streamed audio: a MediaSource fed chunk-by-chunk as they arrive. */
interface ReplyAudioSession {
  audio: HTMLAudioElement;
  url: string;
  mediaSource: MediaSource;
  sourceBufferReady: Promise<SourceBuffer>;
  /** Chains chunk appends so only one `appendBuffer` call is ever in flight at a time. */
  appendQueue: Promise<void>;
  /** Set on barge-in so appends already queued when it happened stop short of running. */
  interrupted: boolean;
}

/** Waits for a `SourceBuffer`'s current append to finish before letting the next one start. */
function appendChunk(sourceBuffer: SourceBuffer, chunk: ArrayBuffer): Promise<void> {
  return new Promise((resolve) => {
    sourceBuffer.addEventListener(
      "updateend",
      () => {
        resolve();
      },
      { once: true },
    );
    sourceBuffer.appendBuffer(chunk);
  });
}

/** Chains `task` onto `session`'s append queue so it runs after every previously queued one. */
function enqueue(session: ReplyAudioSession, task: () => Promise<void>): void {
  session.appendQueue = session.appendQueue.then(task);
}

/** Creates a fresh streamed-playback session for a reply and starts it playing immediately. */
function createReplyAudioSession(
  replyAudioRef: RefObject<ReplyAudioSession | undefined>,
  notifyPlaybackEnded: () => void,
): void {
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const audio = new Audio(url);
  const sourceBufferReady = new Promise<SourceBuffer>((resolve, reject) => {
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        try {
          resolve(mediaSource.addSourceBuffer("audio/mpeg"));
        } catch (error) {
          reject(error as Error);
        }
      },
      { once: true },
    );
  });
  const session: ReplyAudioSession = {
    audio,
    url,
    mediaSource,
    sourceBufferReady,
    appendQueue: Promise.resolve(),
    interrupted: false,
  };
  replyAudioRef.current = session;

  // Unsupported mimetype, etc. — without this, every chunk append silently hangs forever
  // waiting on a promise that's already rejected.
  sourceBufferReady.catch((error: unknown) => {
    console.error("Failed to open a source buffer for reply audio", error);
    session.interrupted = true;
  });

  audio.addEventListener("ended", () => {
    URL.revokeObjectURL(url);
    if (replyAudioRef.current === session) replyAudioRef.current = undefined;
    notifyPlaybackEnded();
  });
  audio.play().catch((error: unknown) => {
    console.error("Failed to play reply audio", error);
    notifyPlaybackEnded();
  });
}

/** Appends one chunk to `session`'s source buffer, dropping it if the session was interrupted. */
async function appendReplyAudioChunk(session: ReplyAudioSession, chunk: Blob): Promise<void> {
  if (session.interrupted) return;
  const buffer = await chunk.arrayBuffer();
  if (session.interrupted) return;
  const sourceBuffer = await session.sourceBufferReady.catch(() => undefined);
  if (!sourceBuffer || session.interrupted) return;
  await appendChunk(sourceBuffer, buffer);
}

/** Marks a reply's audio stream complete once every queued chunk has been appended. */
async function finishReplyAudioStream(session: ReplyAudioSession): Promise<void> {
  if (session.interrupted) return;
  await session.sourceBufferReady.catch(() => undefined);
  if (session.interrupted) return;
  if (session.mediaSource.readyState === "open") session.mediaSource.endOfStream();
}

export function Session() {
  const { getToken } = useAuth();
  const [state, setState] = useState<SessionState>({ status: "idle" });
  const [serverError, setServerError] = useState<string | null>(null);
  const [highlightedErrorId, setHighlightedErrorId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const replyAudioRef = useRef<ReplyAudioSession | undefined>(undefined);
  /**
   * Whether the next `reply_text_delta` starts a new reply (and thus a new audio session).
   * `replyAudioRef` alone can't signal this: it stays populated after `reply_audio_end` while
   * the previous reply is still audibly playing, well past when the next reply's deltas start
   * arriving (`reply_playback_ended`/barge-in are what eventually clear it).
   */
  const awaitingReplySessionRef = useRef(true);

  const cleanupMedia = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = undefined;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = undefined;
  }, []);

  const handleServerMessage = useCallback(
    (message: ServerToClientMessage) => {
      switch (message.type) {
        case "session_started":
          setState({ status: "active", sessionId: message.sessionId, turns: [] });
          return;
        case "transcript":
          setState((prev) => {
            if (prev.status !== "active") return prev;
            return { ...prev, turns: applyTranscript(prev.turns, message.text, message.isFinal) };
          });
          return;
        case "end_of_turn":
          setState((prev) => {
            if (prev.status !== "active") return prev;
            return { ...prev, turns: endTurn(prev.turns) };
          });
          return;
        case "turn_errors":
          setState((prev) => {
            if (prev.status !== "active" && prev.status !== "ended") return prev;
            return {
              ...prev,
              turns: attachTurnErrors(prev.turns, message.errors, message.createdAt),
            };
          });
          return;
        case "reply_text_delta": {
          // The first delta of a reply is also what starts its audio session — audio can start
          // streaming before the full reply text (and thus `reply_text`) is known (ticket 17),
          // so waiting for `reply_text` here would delay playback back to pre-pipelining timing.
          const isFirstDelta = awaitingReplySessionRef.current;
          if (isFirstDelta) {
            awaitingReplySessionRef.current = false;
            createReplyAudioSession(replyAudioRef, () => {
              const wsMessage: ClientToServerMessage = { type: "reply_playback_ended" };
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify(wsMessage));
              }
            });
          }
          setState((prev) => {
            if (prev.status !== "active") return prev;
            return { ...prev, turns: appendAssistantDelta(prev.turns, message.text) };
          });
          return;
        }
        case "reply_text":
          // The authoritative full text, once generation completes — supersedes whatever the
          // accumulated deltas produced, in case of any drift.
          setState((prev) => {
            if (prev.status !== "active") return prev;
            return { ...prev, turns: finalizeAssistantText(prev.turns, message.text) };
          });
          return;
        case "reply_audio_end": {
          awaitingReplySessionRef.current = true;
          const session = replyAudioRef.current;
          if (session) enqueue(session, () => finishReplyAudioStream(session));
          setState((prev) => {
            if (prev.status !== "active") return prev;
            return { ...prev, turns: finalizeAssistantTurn(prev.turns) };
          });
          return;
        }
        case "reply_interrupted": {
          awaitingReplySessionRef.current = true;
          const session = replyAudioRef.current;
          if (session) {
            session.interrupted = true;
            session.audio.pause();
            URL.revokeObjectURL(session.url);
          }
          replyAudioRef.current = undefined;
          setState((prev) => {
            if (prev.status !== "active") return prev;
            return { ...prev, turns: interruptAssistantTurn(prev.turns) };
          });
          return;
        }
        case "session_ended":
          cleanupMedia();
          setState((prev) => ({
            status: "ended",
            turns: prev.status === "active" ? prev.turns : [],
          }));
          return;
        case "error":
          setServerError(message.message);
          // Before session_started, an error means the server rejected the session outright
          // (no consent, daily cap reached) — show it in place of the generic connection error
          // instead of leaving the UI stuck on "Connecting...".
          setState((prev) =>
            prev.status === "starting" ? { status: "error", message: message.message } : prev,
          );
          return;
      }
    },
    [cleanupMedia],
  );

  const startSession = useCallback(async () => {
    setServerError(null);
    setState({ status: "starting" });

    try {
      const token = await getToken();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ws = new WebSocket(buildSessionUrl(token));
      wsRef.current = ws;

      ws.onopen = () => {
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(event.data);
        };
        recorder.start(250);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof Blob) {
          const chunk = event.data;
          const session = replyAudioRef.current;
          if (session) enqueue(session, () => appendReplyAudioChunk(session, chunk));
          return;
        }
        handleServerMessage(JSON.parse(event.data) as ServerToClientMessage);
      };

      ws.onerror = () => {
        cleanupMedia();
        setState({ status: "error", message: "Connection error." });
      };

      ws.onclose = () => {
        cleanupMedia();
      };
    } catch {
      setState({ status: "error", message: "Couldn't access your microphone." });
    }
  }, [getToken, handleServerMessage, cleanupMedia]);

  const stopSession = useCallback(() => {
    const message: ClientToServerMessage = { type: "end_session" };
    wsRef.current?.send(JSON.stringify(message));
  }, []);

  const handleBookmarkToggled = useCallback((errorId: string, bookmarked: boolean) => {
    setState((prev) => {
      if (prev.status !== "active" && prev.status !== "ended") return prev;
      return {
        ...prev,
        turns: prev.turns.map((turn) =>
          turn.kind === "user" && turn.errors
            ? {
                ...turn,
                errors: turn.errors.map((error) =>
                  error.id === errorId ? { ...error, bookmarked } : error,
                ),
              }
            : turn,
        ),
      };
    });
  }, []);

  const handleFlaggedSpanClick = useCallback((errorId: string) => {
    document.getElementById(`correction-${errorId}`)?.scrollIntoView({ block: "center" });
    setHighlightedErrorId(errorId);
  }, []);

  // Briefly highlights the corrections panel entry a clicked inline span scrolled to, then clears.
  useEffect(() => {
    if (!highlightedErrorId) return;
    const timer = setTimeout(() => setHighlightedErrorId(null), 1500);
    return () => clearTimeout(timer);
  }, [highlightedErrorId]);

  useEffect(() => {
    return () => {
      cleanupMedia();
      wsRef.current?.close();
    };
  }, [cleanupMedia]);

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      {state.status === "idle" && (
        <button className={PRIMARY_BUTTON_CLASS} onClick={() => void startSession()}>
          Start session
        </button>
      )}
      {state.status === "starting" && <p className="text-lavender-700">Connecting...</p>}
      {state.status === "error" && (
        <>
          <p role="alert" className={ALERT_CLASS}>
            {state.message}
          </p>
          <button className={PRIMARY_BUTTON_CLASS} onClick={() => void startSession()}>
            Try again
          </button>
        </>
      )}
      {state.status === "active" && (
        <>
          <button className={SECONDARY_BUTTON_CLASS} onClick={stopSession}>
            Stop session
          </button>
          {serverError && (
            <p role="alert" className={ALERT_CLASS}>
              {serverError}
            </p>
          )}
          <ConversationThread turns={state.turns} onFlaggedSpanClick={handleFlaggedSpanClick} />
          <CorrectionsPanel
            corrections={deriveCorrections(state.turns)}
            getToken={getToken}
            onBookmarkToggled={handleBookmarkToggled}
            highlightedErrorId={highlightedErrorId}
          />
        </>
      )}
      {state.status === "ended" && (
        <>
          <p className="text-lavender-700">Session ended.</p>
          <ConversationThread turns={state.turns} onFlaggedSpanClick={handleFlaggedSpanClick} />
          <CorrectionsPanel
            corrections={deriveCorrections(state.turns)}
            getToken={getToken}
            onBookmarkToggled={handleBookmarkToggled}
            highlightedErrorId={highlightedErrorId}
          />
          <button className={PRIMARY_BUTTON_CLASS} onClick={() => void startSession()}>
            Start new session
          </button>
        </>
      )}
    </section>
  );
}
