import type { ServerToClientMessage } from "@kalli/types";
import { render, screen, waitFor, within } from "@testing-library/react";
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

class FakeSourceBuffer {
  appended: ArrayBuffer[] = [];
  updating = false;
  private readonly listeners: Record<string, Array<() => void>> = {};

  addEventListener(event: string, listener: () => void, options?: { once?: boolean }): void {
    const wrapped = options?.once
      ? () => {
          this.removeEventListener(event, wrapped);
          listener();
        }
      : listener;
    (this.listeners[event] ??= []).push(wrapped);
  }

  removeEventListener(event: string, listener: () => void): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter((l) => l !== listener);
  }

  appendBuffer(buffer: ArrayBuffer): void {
    this.appended.push(buffer);
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      for (const listener of this.listeners["updateend"] ?? []) listener();
    });
  }

  /** Decodes every chunk appended so far back to text, in arrival order. */
  appendedText(): string {
    return this.appended.map((buffer) => new TextDecoder().decode(buffer)).join("");
  }
}

class FakeMediaSource {
  static instances: FakeMediaSource[] = [];
  readyState: "closed" | "open" | "ended" = "closed";
  sourceBuffers: FakeSourceBuffer[] = [];
  endOfStreamCalled = false;
  private readonly listeners: Record<string, Array<() => void>> = {};

  constructor() {
    FakeMediaSource.instances.push(this);
  }

  addEventListener(event: string, listener: () => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  addSourceBuffer(_mimeType: string): FakeSourceBuffer {
    const sourceBuffer = new FakeSourceBuffer();
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }

  endOfStream(): void {
    this.endOfStreamCalled = true;
    this.readyState = "ended";
  }

  /** Test helper simulating the browser firing `sourceopen` once the src is attached. */
  open(): void {
    this.readyState = "open";
    for (const listener of this.listeners["sourceopen"] ?? []) listener();
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

/** Emits a realistic completed user turn: a finalized transcript followed by its turn boundary. */
function emitUserTurn(ws: FakeWebSocket, text: string): void {
  ws.emitServerMessage({ type: "transcript", text, isFinal: true });
  ws.emitServerMessage({ type: "end_of_turn" });
}

describe("Session", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    FakeWebSocket.instances = [];
    FakeAudio.instances = [];
    FakeMediaSource.instances = [];
    getUserMedia.mockClear().mockResolvedValue(fakeStream);
    fakeTrack.stop.mockClear();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("MediaSource", FakeMediaSource);
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

  it("restarts the recorder on end_of_turn so each turn's clip starts with a fresh header", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "end_of_turn" });

    expect(FakeMediaRecorder.instances[0]?.stopped).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(FakeMediaRecorder.instances[1]?.stopped).toBe(false);
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

  it("keeps every past turn visible as the conversation continues", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "transcript", text: "hello there", isFinal: true });
    ws.emitServerMessage({ type: "end_of_turn" });
    ws.emitServerMessage({ type: "reply_text_delta", text: "Hi! How are you?" });
    ws.emitServerMessage({ type: "reply_text", text: "Hi! How are you?" });
    ws.emitServerMessage({ type: "reply_audio_end" });
    await screen.findByText("Hi! How are you?");

    ws.emitServerMessage({ type: "transcript", text: "I am good", isFinal: true });

    await waitFor(() => {
      expect(screen.getByText("I am good")).toBeInTheDocument();
    });
    // Both the first turn's transcript and Kalli's reply are still on screen, not overwritten.
    expect(screen.getByText("hello there")).toBeInTheDocument();
    expect(screen.getByText("Hi! How are you?")).toBeInTheDocument();
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

  it("starts playing the reply's audio element as soon as the first reply_text_delta arrives", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });
    expect(FakeAudio.instances[0]?.played).toBe(true);
    expect(FakeAudio.instances[0]?.src).toBe("blob:fake-url");
    expect(FakeMediaSource.instances).toHaveLength(1);
  });

  it("shows a typing indicator the instant the user's turn ends", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "transcript", text: "hello there", isFinal: true });
    ws.emitServerMessage({ type: "end_of_turn" });

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Kalli is typing" })).toBeInTheDocument();
    });

    ws.emitServerMessage({ type: "reply_text_delta", text: "Hi!" });
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "Kalli is typing" })).not.toBeInTheDocument();
    });
    expect(screen.getByText("Hi!")).toBeInTheDocument();
  });

  it("renders reply_text_delta chunks as a live, growing caption", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice " });
    await waitFor(() => {
      expect(screen.getByText("Nice")).toBeInTheDocument();
    });

    ws.emitServerMessage({ type: "reply_text_delta", text: "job!" });
    await waitFor(() => {
      expect(screen.getByText("Nice job!")).toBeInTheDocument();
    });
  });

  it("does not open a second audio session for the second delta of the same reply", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice " });
    await waitFor(() => {
      expect(FakeMediaSource.instances).toHaveLength(1);
    });
    ws.emitServerMessage({ type: "reply_text_delta", text: "job!" });

    expect(FakeMediaSource.instances).toHaveLength(1);
  });

  it("finalizes the caption to the authoritative full text once reply_text arrives", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice " });
    ws.emitServerMessage({ type: "reply_text", text: "Nice job!" });

    await waitFor(() => {
      expect(screen.getByText("Nice job!")).toBeInTheDocument();
    });
  });

  it("starts a fresh caption and audio session for the next reply after reply_audio_end", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "First reply" });
    ws.emitServerMessage({ type: "reply_audio_end" });

    ws.emitServerMessage({ type: "reply_text_delta", text: "Second reply" });

    await waitFor(() => {
      expect(FakeMediaSource.instances).toHaveLength(2);
    });
    expect(screen.getByText("Second reply")).toBeInTheDocument();
    expect(screen.queryByText("First replySecond reply")).not.toBeInTheDocument();
  });

  it("keeps a reply's streamed text, marked cut off, on barge-in or a pipeline error", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job" });
    await screen.findByText("Nice job", { exact: false });

    ws.emitServerMessage({ type: "reply_interrupted", reason: "barge_in" });
    await waitFor(() => {
      expect(screen.getByText("Nice job", { exact: false })).toHaveTextContent("(cut off)");
    });

    ws.emitServerMessage({ type: "reply_text_delta", text: "Oh no" });
    await screen.findByText("Oh no", { exact: false });

    ws.emitServerMessage({ type: "reply_interrupted", reason: "error" });
    await waitFor(() => {
      expect(screen.getByText("Oh no", { exact: false })).toHaveTextContent("(cut off)");
    });
    // The barge-in-cut reply from before is still visible too, not discarded.
    expect(screen.getByText("Nice job", { exact: false })).toBeInTheDocument();
  });

  it("appends each chunk as it arrives, without waiting for reply_audio_end", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });
    const mediaSource = FakeMediaSource.instances[0]!;
    mediaSource.open();
    const sourceBuffer = mediaSource.sourceBuffers[0]!;

    ws.emitBinaryMessage(new Blob(["chunk-one"]));
    await waitFor(() => {
      expect(sourceBuffer.appendedText()).toBe("chunk-one");
    });

    // Still no reply_audio_end — the second chunk is appended as soon as it arrives too.
    ws.emitBinaryMessage(new Blob(["chunk-two"]));
    await waitFor(() => {
      expect(sourceBuffer.appendedText()).toBe("chunk-onechunk-two");
    });

    ws.emitServerMessage({ type: "reply_audio_end" });
    await waitFor(() => {
      expect(mediaSource.endOfStreamCalled).toBe(true);
    });
  });

  it("still ends the stream once sourceopen fires late, for a reply_audio_end with no chunks", async () => {
    const { ws } = await startAndOpenSession();

    // reply_audio_end arrives (an empty reply) before sourceopen — real browsers fire
    // sourceopen as a separate task, arriving after any already-queued microtask work, so
    // endOfStream must wait for it rather than checking readyState before it's fired.
    ws.emitServerMessage({ type: "reply_text_delta", text: "" });
    ws.emitServerMessage({ type: "reply_audio_end" });
    const mediaSource = FakeMediaSource.instances[0]!;

    // Let any microtask-only processing run to completion before sourceopen ever fires.
    await Promise.resolve();
    await Promise.resolve();
    expect(mediaSource.endOfStreamCalled).toBe(false);

    mediaSource.open();

    await waitFor(() => {
      expect(mediaSource.endOfStreamCalled).toBe(true);
    });
  });

  it("queues a chunk that arrives before the source buffer exists yet", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });
    // Chunk arrives before the simulated sourceopen event fires.
    ws.emitBinaryMessage(new Blob(["chunk"]));

    const mediaSource = FakeMediaSource.instances[0]!;
    mediaSource.open();

    await waitFor(() => {
      expect(mediaSource.sourceBuffers[0]?.appendedText()).toBe("chunk");
    });
  });

  it("revokes the object URL once playback ends", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });
    FakeMediaSource.instances[0]!.open();
    ws.emitBinaryMessage(new Blob(["chunk"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });
    FakeAudio.instances[0]?.emit("ended");

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });

  it("reports a console error and notifies the server when autoplay is blocked", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    class RejectingFakeAudio extends FakeAudio {
      override play(): Promise<void> {
        this.played = true;
        return Promise.reject(new Error("NotAllowedError"));
      }
    }
    vi.stubGlobal("Audio", RejectingFakeAudio);
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("Failed to play reply audio", expect.any(Error));
    });
    expect(ws.sent).toContain(JSON.stringify({ type: "reply_playback_ended" }));
    consoleError.mockRestore();
  });

  it("renders a turn's detected errors in the correction panel", async () => {
    const { ws } = await startAndOpenSession();

    emitUserTurn(ws, "test turn");
    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-1",
      createdAt: "2026-07-18T12:00:00.000Z",
      errors: [
        {
          id: "error-1",
          hasClip: true,
          bookmarked: false,
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

  it("scrolls to and highlights the panel entry when its flagged span is clicked", async () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    const { ws } = await startAndOpenSession();

    emitUserTurn(ws, "she go");
    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-1",
      createdAt: "2026-07-18T12:00:00.000Z",
      errors: [
        {
          id: "error-1",
          hasClip: false,
          bookmarked: false,
          category: "subject_verb_agreement",
          original: "she go",
          corrected: "she goes",
          explanation: "Third-person singular verbs take an -s ending.",
        },
      ],
    });
    const log = await screen.findByRole("log", { name: "Conversation" });
    const flaggedSpan = await waitFor(() => within(log).getByText("she go"));

    await userEvent.setup().click(flaggedSpan);

    expect(scrollIntoView).toHaveBeenCalled();
    const panelEntry = document.getElementById("correction-error-1");
    expect(panelEntry).toHaveClass("ring-lavender-400");
    scrollIntoView.mockRestore();
  });

  it("does not add a panel entry for a turn with no detected errors", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("associates each panel entry with the turn it came from", async () => {
    const { ws } = await startAndOpenSession();

    emitUserTurn(ws, "first turn");
    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-1",
      createdAt: "2026-07-18T12:00:00.000Z",
      errors: [
        {
          id: "error-1",
          hasClip: false,
          bookmarked: false,
          category: "word_order",
          original: "go I",
          corrected: "I go",
          explanation: "Subject comes before the verb in English statements.",
        },
      ],
    });
    emitUserTurn(ws, "second turn");
    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-2",
      createdAt: "2026-07-18T12:01:00.000Z",
      errors: [
        {
          id: "error-2",
          hasClip: false,
          bookmarked: false,
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

  it("keeps the correction panel visible after the session ends", async () => {
    const { ws } = await startAndOpenSession();

    emitUserTurn(ws, "test turn");
    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-1",
      createdAt: "2026-07-18T12:00:00.000Z",
      errors: [
        {
          id: "error-1",
          hasClip: false,
          bookmarked: false,
          category: "preposition_choice",
          original: "arrive to the station",
          corrected: "arrive at the station",
          explanation: "Use 'at' for a specific point of arrival.",
        },
      ],
    });
    await screen.findByText("arrive to the station");

    await userEvent.setup().click(screen.getByRole("button", { name: "Stop session" }));
    ws.emitServerMessage({ type: "session_ended", reason: "user_ended" });

    await waitFor(() => {
      expect(screen.getByText("Session ended.")).toBeInTheDocument();
    });
    expect(screen.getByText("arrive to the station")).toBeInTheDocument();
    expect(screen.getByText("arrive at the station")).toBeInTheDocument();
  });

  it("still appends a turn_errors frame that arrives after the session has ended", async () => {
    const { ws } = await startAndOpenSession();

    emitUserTurn(ws, "test turn");
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop session" }));
    ws.emitServerMessage({ type: "session_ended", reason: "user_ended" });
    await waitFor(() => {
      expect(screen.getByText("Session ended.")).toBeInTheDocument();
    });

    ws.emitServerMessage({
      type: "turn_errors",
      turnId: "turn-1",
      createdAt: "2026-07-18T12:00:00.000Z",
      errors: [
        {
          id: "error-1",
          hasClip: false,
          bookmarked: false,
          category: "verb_tense_aspect",
          original: "I am go",
          corrected: "I am going",
          explanation: "Use the -ing form after 'am' for the present continuous.",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText("I am go")).toBeInTheDocument();
    });
  });

  it("stops playing reply audio and clears the buffer on a server barge-in signal", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });
    FakeMediaSource.instances[0]!.open();
    ws.emitBinaryMessage(new Blob(["chunk"]));

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });
    const playingAudio = FakeAudio.instances[0]!;

    ws.emitServerMessage({ type: "reply_interrupted", reason: "barge_in" });

    expect(playingAudio.paused).toBe(true);

    // A subsequent reply's chunks shouldn't be mixed in with anything left over from the
    // interrupted one.
    ws.emitServerMessage({ type: "reply_text_delta", text: "Second reply" });
    FakeMediaSource.instances[1]!.open();
    ws.emitBinaryMessage(new Blob(["second"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(2);
    });
    await waitFor(() => {
      expect(FakeMediaSource.instances[1]?.sourceBuffers[0]?.appendedText()).toBe("second");
    });
    expect(FakeMediaSource.instances[0]?.sourceBuffers[0]?.appendedText()).toBe("chunk");
  });

  it("ignores a chunk that arrives for a reply that was already interrupted", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });
    const interruptedSource = FakeMediaSource.instances[0]!;
    interruptedSource.open();
    ws.emitServerMessage({ type: "reply_interrupted", reason: "barge_in" });

    // A stray chunk from the interrupted reply shows up late; it must not land in a fresh
    // MediaSource for whatever comes next, nor throw trying to append to the stale one.
    ws.emitBinaryMessage(new Blob(["late-chunk"]));

    expect(interruptedSource.sourceBuffers[0]?.appendedText() ?? "").toBe("");
  });

  it("tolerates a barge-in signal when no reply is in progress", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_interrupted", reason: "barge_in" });

    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("pauses safely on barge-in before any audio chunk has arrived", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "Nice job!" });
    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });

    ws.emitServerMessage({ type: "reply_interrupted", reason: "barge_in" });

    expect(FakeAudio.instances[0]?.paused).toBe(true);
  });

  it("starts a fresh audio buffer for each new reply", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "reply_text_delta", text: "First reply" });
    FakeMediaSource.instances[0]!.open();
    ws.emitBinaryMessage(new Blob(["first-chunk"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    ws.emitServerMessage({ type: "reply_text_delta", text: "Second reply" });
    FakeMediaSource.instances[1]!.open();
    ws.emitBinaryMessage(new Blob(["second"]));
    ws.emitServerMessage({ type: "reply_audio_end" });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(2);
    });
    await waitFor(() => {
      expect(FakeMediaSource.instances[1]?.sourceBuffers[0]?.appendedText()).toBe("second");
    });
    expect(FakeMediaSource.instances[0]?.sourceBuffers[0]?.appendedText()).toBe("first-chunk");
  });

  it("does not throw when the server sends profile_updated", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({
      type: "profile_updated",
      name: "Maria",
      l1: "spanish",
      proficiency: "intermediate",
      context: "work meetings",
      goals: "sounding more natural",
    });

    // No UI assertion — the test's job is just proving the exhaustive switch handles this
    // variant without throwing or leaving the session in a broken state. The button staying
    // "Stop session" (not reverting to an error/starting state) is that proof.
    expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
  });

  it("does not throw when the server sends turn_pronunciation_errors", async () => {
    const { ws } = await startAndOpenSession();

    emitUserTurn(ws, "test turn");
    ws.emitServerMessage({
      type: "turn_pronunciation_errors",
      turnId: "turn-1",
      createdAt: "2026-07-18T12:00:00.000Z",
      errors: [
        {
          id: "error-1",
          word: "like",
          op: "sub",
          expectedPhoneme: "L",
          spokenPhoneme: "R",
          source: "audio",
        },
      ],
    });

    // No UI assertion — no correction panel exists for pronunciation errors yet. The test's job
    // is just proving the exhaustive switch handles this variant without throwing or leaving the
    // session in a broken state, same as the profile_updated case above.
    expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
  });

  describe("error clip/target-audio playback", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockReset().mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob(["audio-bytes"])),
      });
    });

    async function emitOneError(hasClip: boolean, bookmarked = false): Promise<FakeWebSocket> {
      const { ws } = await startAndOpenSession();
      emitUserTurn(ws, "test turn");
      ws.emitServerMessage({
        type: "turn_errors",
        turnId: "turn-1",
        createdAt: "2026-07-18T12:00:00.000Z",
        errors: [
          {
            id: "error-1",
            hasClip,
            bookmarked,
            category: "word_order",
            original: "go I",
            corrected: "I go",
            explanation: "Subject comes before the verb in English statements.",
          },
        ],
      });
      await screen.findByText("go I");
      return ws;
    }

    it("shows a Play my clip button only when the error has a stored clip", async () => {
      await emitOneError(true);
      expect(screen.getByRole("button", { name: "Play my clip" })).toBeInTheDocument();
    });

    it("omits the Play my clip button when the error has no stored clip", async () => {
      await emitOneError(false);
      expect(screen.queryByRole("button", { name: "Play my clip" })).not.toBeInTheDocument();
    });

    it("always shows a Play target button, regardless of clip availability", async () => {
      await emitOneError(false);
      expect(screen.getByRole("button", { name: "Play target" })).toBeInTheDocument();
    });

    it("fetches and plays the error's clip with an auth header when clicked", async () => {
      await emitOneError(true);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Play my clip" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/errors/error-1/clip"),
          expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
        );
      });
      await waitFor(() => {
        expect(FakeAudio.instances.some((audio) => audio.played)).toBe(true);
      });
    });

    it("fetches and plays the target audio when clicked", async () => {
      await emitOneError(false);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Play target" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/errors/error-1/target-audio"),
          expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
        );
      });
      await waitFor(() => {
        expect(FakeAudio.instances.some((audio) => audio.played)).toBe(true);
      });
    });

    it("shows an alert if the fetch fails, without crashing the panel", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        blob: () => Promise.resolve(new Blob()),
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      await emitOneError(false);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Play target" }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't play that audio.");
      });
      consoleError.mockRestore();
    });
  });

  describe("bookmarking a clip", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("fetch", fetchMock);
    });

    function mockBookmarkResponse(bookmarked: boolean): void {
      fetchMock.mockReset().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ bookmarked }),
      });
    }

    async function emitOneError(hasClip: boolean, bookmarked: boolean): Promise<FakeWebSocket> {
      const { ws } = await startAndOpenSession();
      emitUserTurn(ws, "test turn");
      ws.emitServerMessage({
        type: "turn_errors",
        turnId: "turn-1",
        createdAt: "2026-07-18T12:00:00.000Z",
        errors: [
          {
            id: "error-1",
            hasClip,
            bookmarked,
            category: "word_order",
            original: "go I",
            corrected: "I go",
            explanation: "Subject comes before the verb in English statements.",
          },
        ],
      });
      await screen.findByText("go I");
      return ws;
    }

    it("shows a Bookmark clip button only when the error has a stored clip", async () => {
      mockBookmarkResponse(true);
      await emitOneError(true, false);
      expect(screen.getByRole("button", { name: "Bookmark clip" })).toBeInTheDocument();
    });

    it("omits the bookmark button when the error has no stored clip", async () => {
      mockBookmarkResponse(true);
      await emitOneError(false, false);
      expect(screen.queryByRole("button", { name: "Bookmark clip" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Un-bookmark clip" })).not.toBeInTheDocument();
    });

    it("shows Un-bookmark clip when the clip is already bookmarked", async () => {
      mockBookmarkResponse(false);
      await emitOneError(true, true);
      expect(screen.getByRole("button", { name: "Un-bookmark clip" })).toBeInTheDocument();
    });

    it("PATCHes the bookmark endpoint with an auth header and flips the button label", async () => {
      mockBookmarkResponse(true);
      await emitOneError(true, false);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Bookmark clip" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/errors/error-1/bookmark"),
          expect.objectContaining({
            method: "PATCH",
            headers: { Authorization: "Bearer test-token" },
          }),
        );
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Un-bookmark clip" })).toBeInTheDocument();
      });
    });

    it("flips back to Bookmark clip on a second toggle", async () => {
      mockBookmarkResponse(false);
      await emitOneError(true, true);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Un-bookmark clip" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Bookmark clip" })).toBeInTheDocument();
      });
    });

    it("shows an alert if the bookmark toggle fails, without crashing the panel", async () => {
      fetchMock.mockReset().mockResolvedValue({ ok: false, status: 404 });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      await emitOneError(true, false);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Bookmark clip" }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't update the bookmark.");
      });
      expect(screen.getByRole("button", { name: "Bookmark clip" })).toBeInTheDocument();
      consoleError.mockRestore();
    });
  });
});
