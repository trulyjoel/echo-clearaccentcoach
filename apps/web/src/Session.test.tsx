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
  onmessage: ((event: { data: string }) => void) | null = null;
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
    getUserMedia.mockClear().mockResolvedValue(fakeStream);
    fakeTrack.stop.mockClear();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("WebSocket", FakeWebSocket);
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

  it("shows a transient server error banner without ending the session", async () => {
    const { ws } = await startAndOpenSession();

    ws.emitServerMessage({ type: "error", message: "Transcription error" });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Transcription error");
    });
    expect(screen.getByRole("button", { name: "Stop session" })).toBeInTheDocument();
  });
});
