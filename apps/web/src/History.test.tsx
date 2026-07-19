import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { History } from "./History.js";

const { getToken } = vi.hoisted(() => ({ getToken: async () => "test-token" }));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken }),
}));

const sessionsResponse = [
  {
    id: "session-2",
    startedAt: "2026-07-10T09:00:00.000Z",
    endedAt: null,
    endReason: null,
    turnCount: 0,
    errorCount: 0,
  },
  {
    id: "session-1",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:10:00.000Z",
    endReason: "user_ended",
    turnCount: 3,
    errorCount: 2,
  },
];

const summaryResponse = [
  { category: "word_order", count: 2 },
  { category: "verb_tense_aspect", count: 1 },
];

const sessionErrorsResponse = {
  session: sessionsResponse[1],
  errors: [
    {
      id: "error-1",
      category: "subject_verb_agreement",
      original: "she go",
      corrected: "she goes",
      explanation: "Third-person singular verbs take an -s ending.",
      hasClip: false,
      bookmarked: false,
      createdAt: "2026-07-01T10:05:00.000Z",
    },
  ],
};

function mockFetchByUrl(handlers: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    for (const [path, body] of Object.entries(handlers)) {
      if (url.endsWith(path)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
}

describe("History", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders past sessions with date, duration, and counts", async () => {
    mockFetchByUrl({
      "/api/history/sessions": sessionsResponse,
      "/api/history/errors/summary": summaryResponse,
    });

    render(<History />);

    await waitFor(() => {
      expect(screen.getAllByText(/7\/1\/2026/).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/10m 0s/)).toBeInTheDocument();
    expect(screen.getByText(/3 turns/)).toBeInTheDocument();
    expect(screen.getByText(/2 errors/)).toBeInTheDocument();
    expect(screen.getAllByText(/7\/10\/2026/).length).toBeGreaterThan(0);
    expect(screen.getByText(/In progress/)).toBeInTheDocument();
  });

  it("renders the aggregate error-frequency summary by category", async () => {
    mockFetchByUrl({
      "/api/history/sessions": sessionsResponse,
      "/api/history/errors/summary": summaryResponse,
    });

    render(<History />);

    await waitFor(() => {
      expect(screen.getByText(/Word order/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Verb tense\/aspect/)).toBeInTheDocument();
  });

  it("shows a session's flagged errors after clicking into it, scoped by auth token", async () => {
    mockFetchByUrl({
      "/api/history/sessions": sessionsResponse,
      "/api/history/errors/summary": summaryResponse,
      "/api/history/sessions/session-1/errors": sessionErrorsResponse,
    });

    render(<History />);

    await waitFor(() => {
      expect(screen.getAllByText(/7\/1\/2026/).length).toBeGreaterThan(0);
    });

    screen.getByRole("button", { name: /View errors from 7\/1\/2026/ }).click();

    await waitFor(() => {
      expect(screen.getByText("she go")).toBeInTheDocument();
    });
    expect(screen.getByText("she goes")).toBeInTheDocument();
    expect(screen.getByText("Subject-verb agreement")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/history/sessions/session-1/errors",
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
    );
  });

  it("shows an error message when the sessions fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    render(<History />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your session history.")).toBeInTheDocument();
    });
  });
});
