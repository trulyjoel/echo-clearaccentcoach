import type { ClientToServerMessage, PersistedError, ServerToClientMessage } from "@callie/types";
import { useAuth } from "@clerk/react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, getApiBaseUrl } from "./api.js";
import { CATEGORY_LABELS } from "./errorCategoryLabels.js";

interface TurnCorrections {
  turnId: string;
  createdAt: string;
  errors: PersistedError[];
}

type SessionState =
  | { status: "idle" }
  | { status: "starting" }
  | {
      status: "active";
      sessionId: string;
      finalized: string[];
      interim: string;
      corrections: TurnCorrections[];
    }
  | { status: "ended"; finalized: string[]; corrections: TurnCorrections[] }
  | { status: "error"; message: string };

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

function CorrectionsPanel({
  corrections,
  getToken,
  onBookmarkToggled,
}: {
  corrections: TurnCorrections[];
  getToken: () => Promise<string | null>;
  onBookmarkToggled: (errorId: string, bookmarked: boolean) => void;
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
    <aside aria-label="Corrections">
      {playbackError && <p role="alert">{playbackError}</p>}
      {bookmarkError && <p role="alert">{bookmarkError}</p>}
      <ul>
        {corrections.flatMap((correction) =>
          correction.errors.map((error) => (
            <li key={error.id}>
              <time dateTime={correction.createdAt}>
                {new Date(correction.createdAt).toLocaleTimeString()}
              </time>
              <strong>{CATEGORY_LABELS[error.category]}</strong>
              <p>
                <span>{error.original}</span> → <span>{error.corrected}</span>
              </p>
              <p>{error.explanation}</p>
              {error.hasClip && (
                <button onClick={() => void play(`/api/errors/${error.id}/clip`)}>
                  Play my clip
                </button>
              )}
              <button onClick={() => void play(`/api/errors/${error.id}/target-audio`)}>
                Play target
              </button>
              {error.hasClip && (
                <button onClick={() => void bookmark(error.id)}>
                  {error.bookmarked ? "Un-bookmark clip" : "Bookmark clip"}
                </button>
              )}
            </li>
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
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const replyAudioRef = useRef<ReplyAudioSession | undefined>(undefined);

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
          setState({
            status: "active",
            sessionId: message.sessionId,
            finalized: [],
            interim: "",
            corrections: [],
          });
          return;
        case "transcript":
          setState((prev) => {
            if (prev.status !== "active") return prev;
            return message.isFinal
              ? { ...prev, finalized: [...prev.finalized, message.text], interim: "" }
              : { ...prev, interim: message.text };
          });
          return;
        case "end_of_turn":
          return;
        case "turn_errors":
          setState((prev) => {
            if (prev.status !== "active" && prev.status !== "ended") return prev;
            const correction: TurnCorrections = {
              turnId: message.turnId,
              createdAt: message.createdAt,
              errors: message.errors,
            };
            return { ...prev, corrections: [...prev.corrections, correction] };
          });
          return;
        case "reply_text":
          // The server can't tell when audible playback actually finishes (it only streams
          // bytes) — this tells it, so a barge-in mid-playback (after streaming is long done)
          // is still recognized instead of a new reply starting on top of this one.
          createReplyAudioSession(replyAudioRef, () => {
            const wsMessage: ClientToServerMessage = { type: "reply_playback_ended" };
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify(wsMessage));
            }
          });
          return;
        case "reply_audio_end": {
          const session = replyAudioRef.current;
          if (session) enqueue(session, () => finishReplyAudioStream(session));
          return;
        }
        case "reply_interrupted": {
          const session = replyAudioRef.current;
          if (session) {
            session.interrupted = true;
            session.audio.pause();
            URL.revokeObjectURL(session.url);
          }
          replyAudioRef.current = undefined;
          return;
        }
        case "session_ended":
          cleanupMedia();
          setState((prev) => ({
            status: "ended",
            finalized: prev.status === "active" ? prev.finalized : [],
            corrections: prev.status === "active" ? prev.corrections : [],
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
        corrections: prev.corrections.map((correction) => ({
          ...correction,
          errors: correction.errors.map((error) =>
            error.id === errorId ? { ...error, bookmarked } : error,
          ),
        })),
      };
    });
  }, []);

  useEffect(() => {
    return () => {
      cleanupMedia();
      wsRef.current?.close();
    };
  }, [cleanupMedia]);

  return (
    <section>
      {state.status === "idle" && (
        <button onClick={() => void startSession()}>Start session</button>
      )}
      {state.status === "starting" && <p>Connecting...</p>}
      {state.status === "error" && (
        <>
          <p role="alert">{state.message}</p>
          <button onClick={() => void startSession()}>Try again</button>
        </>
      )}
      {state.status === "active" && (
        <>
          <button onClick={stopSession}>Stop session</button>
          {serverError && <p role="alert">{serverError}</p>}
          <p>{[...state.finalized, state.interim].filter(Boolean).join(" ")}</p>
          <CorrectionsPanel
            corrections={state.corrections}
            getToken={getToken}
            onBookmarkToggled={handleBookmarkToggled}
          />
        </>
      )}
      {state.status === "ended" && (
        <>
          <p>Session ended.</p>
          <p>{state.finalized.join(" ")}</p>
          <CorrectionsPanel
            corrections={state.corrections}
            getToken={getToken}
            onBookmarkToggled={handleBookmarkToggled}
          />
          <button onClick={() => void startSession()}>Start new session</button>
        </>
      )}
    </section>
  );
}
