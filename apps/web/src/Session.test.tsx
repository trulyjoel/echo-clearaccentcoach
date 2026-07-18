import type { ServerToClientMessage } from "@callie/types";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session } from "./Session.js";

const { getToken } = vi.hoisted(() => ({ getToken: async () => "test-token" }));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken }),
}));

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  stopped = false;

  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {}

  stop(): void {
    this.stopped = true;
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: Array<string | Blob> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | Blob): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitServerMessage(message: ServerToClientMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  emitBinaryMessage(data: Blob): void {
    this.onmessage?.({ data });
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  played = false;
  paused = false;
  private readonly listeners: Record<string, Array<() => void>> = {};

  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }

  addEventListener(event: string, listener: () => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  play(): Promise<void> {
    this.played = true;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  emit(event: string): void {
    for (const listener of this.listeners[event] ?? []) listener();
  }
}

const fakeTrack = { stop: vi.fn() };
const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
const getUserMedia = vi.fn().mockResolvedValue(fakeStream);

async function startAndOpenSession(): Promise<{
  user: ReturnType<typeof userEvent.setup>;
  ws: FakeWebSocket;
}> {
  const user = userEvent.setup();
  render(<Session />);
  await user.click(screen.getByRole("button", { name: "Start session" }));

  await waitFor(() => {
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
  const ws = FakeWebSocket.instances[0]!;
  ws.open();
  ws.emitServerMessage({ type: "session_started", sessionId: "session-1" });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
  });

  return { user, ws };
}

describe("Session", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    FakeWebSocket.instances = [];
    FakeAudio.instances = [];
    getUserMedia.mockClear().mockResolvedValue(fakeStream);
    fakeTrack.stop.mockClear();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("Audio", FakeAudio);
    URL.createObjectURL = vi.fn(() => "blob:fake-url");
    URL.revokeObjectURL = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a Start session button initially", () => {
    render(<Session />);
    expect(screen.getByRole("button", { name: "Start session" })).toBeInTheDocument();
  });

  it("requests the mic and opens a WebSocket to /api/session on start", async () => {
    const user = userEvent.setup();
    render(<Session />);

    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    expect(FakeWebSocket.instances[0]?.url).toContain("/api/session?token=test-token");
  });

  it("starts recording once the socket opens and forwards audio chunks over the socket", async () => {
    const { ws } = await startAndOpenSession();

    const recorder = FakeMediaRecorder.instances[0]!;
    const chunk = new Blob(["fake audio"]);
    recorder.ondataavailable?.({ data: chunk });

    expect(ws.sent).toContain(chunk);
  });

  it("renders interim and finalized transcript as messages arrive", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "transcript", text: "hello ther", isFinal: false });
    await waitFor(() => {
      expect(screen.getByText("hello ther")).toBeInTheDocument();
    });

    ws.emitServerMessage({ type: "transcript", text: "hello there", isFinal: true });
    await waitFor(() => {
      expect(screen.getByText("hello there")).toBeInTheDocument();
    });
  });

  it("sends end_session and shows the ended state when the server confirms", async () => {
    const { ws } = await startAndOpenSession();
    ws.emitServerMessage({ type: "transcript", text: "goodbye", isFinal: true });
    await screen.findByText("goodbye");

    await userEvent.setup().click(screen.getByRole("button", { name: "Stop session" }));

    expect(ws.sent).toContain(JSON.stringify({ type: "end_session" }));

    ws.emitServerMessage({ type: "session_ended", reason: "user_ended" });

    await waitFor(() => {
      expect(screen.getByText("Session ended.")).toBeInTheDocument();
    });
    expect(screen.getByText("goodbye")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start new session" })).toBeInTheDocument();
    expect(FakeMediaRecorder.instances[0]?.stopped).toBe(true);
    expect(fakeTrack.stop).toHaveBeenCalled();
  });

  it("shows an error and a retry button when the mic permission is denied", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("Permission denied"));
    const user = userEvent.setup();
    render(<Session />);

    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => {
      expect(screen.getByText("Couldn't access your microphone.")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows a connection error when the socket errors", async () => {
    const user = userEvent.setup();
    render(<Session />);
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    FakeWebSocket.instances[0]?.onerror?.();

    await waitFor(() => {
      expect(screen.getByText("Connection error.")).toBeInTheDocument();
    });
  });

  it("shows the server's error message when rejected before the session starts", async () => {
    const user = userEvent.setup();
    render(<Session />);
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.emitServerMessage({ type: "error", message: "Daily session limit reached" });

    await waitFor(() => {
      expect(screen.getByText("Daily session limit reached")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows a transient server error banner without ending the session", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "error", message: "Transcription error" });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Transcription error");
    });
    expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
  });

  it("plays the streamed reply audio automatically once reply_audio_end arrives", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text", text: "Nice job!" });
    ws.emitBinaryMessage(new Blob(["chunk-one"]));
    ws.emitBinaryMessage(new Blob(["chunk-two"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });
    expect(FakeAudio.instances[0]?.played).toBe(true);
    expect(FakeAudio.instances[0]?.src).toBe("blob:fake-url");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Blob;
    expect(blob.size).toBe("chunk-one".length + "chunk-two".length);
  });

  it("revokes the object URL once playback ends", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text", text: "Nice job!" });
    ws.emitBinaryMessage(new Blob(["chunk"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });
    FakeAudio.instances[0]?.emit("ended");

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });

  it("renders a turn's detected errors in the correction panel", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-1",
      createdAt: "2026-07-18T12:00:00.000Z",
      errors: [
        {
          category: "subject_verb_agreement",
          original: "she go",
          corrected: "she goes",
          explanation: "Third-person singular verbs take an -s ending.",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText("she go")).toBeInTheDocument();
    });
    expect(screen.getByText("she goes")).toBeInTheDocument();
    expect(screen.getByText("Third-person singular verbs take an -s ending.")).toBeInTheDocument();
    expect(screen.getByText("Subject-verb agreement")).toBeInTheDocument();
  });

  it("does not add a panel entry for a turn with no detected errors", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text", text: "Nice job!" });
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("associates each panel entry with the turn it came from", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-1",
      createdAt: "2026-07-18T12:00:00.000Z",
      errors: [
        {
          category: "word_order",
          original: "go I",
          corrected: "I go",
          explanation: "Subject comes before the verb in English statements.",
        },
      ],
    });
    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-2",
      createdAt: "2026-07-18T12:01:00.000Z",
      errors: [
        {
          category: "article_usage",
          original: "I saw dog",
          corrected: "I saw a dog",
          explanation: "Singular countable nouns need an article.",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
    expect(screen.getByText("go I")).toBeInTheDocument();
    expect(screen.getByText("I saw dog")).toBeInTheDocument();
  });

  it("stops playing reply audio and clears the buffer on a server barge-in signal", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text", text: "Nice job!" });
    ws.emitBinaryMessage(new Blob(["chunk"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });
    const playingAudio = FakeAudio.instances[0]!;

    ws.emitServerMessage({ type: "reply_interrupted" });

    expect(playingAudio.paused).toBe(true);

    // A subsequent reply's chunks shouldn't be mixed in with anything left over from the
    // interrupted one.
    ws.emitServerMessage({ type: "reply_text", text: "Second reply" });
    ws.emitBinaryMessage(new Blob(["second"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(2);
    });
    const createObjectURL = URL.createObjectURL as ReturnType<typeof vi.fn>;
    const secondBlob = createObjectURL.mock.calls[1]?.[0] as Blob;
    expect(secondBlob.size).toBe("second".length);
  });

  it("tolerates a barge-in mid-stream, before the reply's Audio element exists", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text", text: "Nice job!" });
    ws.emitBinaryMessage(new Blob(["chunk"]));

    // Barge-in before reply_audio_end ever arrives (no Audio element created yet).
    ws.emitServerMessage({ type: "reply_interrupted" });

    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("starts a fresh audio buffer for each new reply", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text", text: "First reply" });
    ws.emitBinaryMessage(new Blob(["first-chunk"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    ws.emitServerMessage({ type: "reply_text", text: "Second reply" });
    ws.emitBinaryMessage(new Blob(["second"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(2);
    });
    const secondBlob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as Blob;
    expect(secondBlob.size).toBe("second".length);
  });
});
