import type { ClientToServerMessage, ServerToClientMessage } from "@callie/types";
import { useAuth } from "@clerk/react";
import { useCallback, useEffect, useRef, useState } from "react";

type SessionState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "active"; sessionId: string; finalized: string[]; interim: string }
  | { status: "ended"; finalized: string[] }
  | { status: "error"; message: string };

function buildSessionUrl(token: string | null): string {
  const apiUrl = import.meta.env["VITE_API_URL"] ?? "";
  const base = apiUrl || window.location.origin;
  const wsBase = base.replace(/^http/, "ws");
  return token
    ? `${wsBase}/api/session?token=${encodeURIComponent(token)}`
    : `${wsBase}/api/session`;
}

export function Session() {
  const { getToken } = useAuth();
  const [state, setState] = useState<SessionState>({ status: "idle" });
  const [serverError, setServerError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);

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
          setState({ status: "active", sessionId: message.sessionId, finalized: [], interim: "" });
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
        case "session_ended":
          cleanupMedia();
          setState((prev) => ({
            status: "ended",
            finalized: prev.status === "active" ? prev.finalized : [],
          }));
          return;
        case "error":
          setServerError(message.message);
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
        handleServerMessage(JSON.parse(event.data as string) as ServerToClientMessage);
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
        </>
      )}
      {state.status === "ended" && (
        <>
          <p>Session ended.</p>
          <p>{state.finalized.join(" ")}</p>
          <button onClick={() => void startSession()}>Start new session</button>
        </>
      )}
    </section>
  );
}
