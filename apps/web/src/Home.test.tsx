import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home.js";

const { getToken } = vi.hoisted(() => ({ getToken: async () => "test-token" }));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken }),
  UserButton: () => <div>User menu</div>,
}));

describe("Home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the signed-in user's id once /api/me resolves", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ userId: "user_123" }), { status: 200 }),
    );

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("Signed in as user_123")).toBeInTheDocument();
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
    );
  });

  it("shows an error message when /api/me fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your account.")).toBeInTheDocument();
    });
  });

  it("shows an error message when the request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your account.")).toBeInTheDocument();
    });
  });
});
