import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "./AuthenticatedApp.js";

const { getToken } = vi.hoisted(() => ({ getToken: async () => "test-token" }));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken }),
  UserButton: () => <div>User menu</div>,
}));

describe("AuthenticatedApp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows onboarding for a first-login user with no l1/consent on record", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ l1: null, consentGivenAt: null }), { status: 200 }),
    );

    render(<AuthenticatedApp />);

    await waitFor(() => {
      expect(screen.getByText("What's your native language?")).toBeInTheDocument();
    });
  });

  it("shows Home directly for a returning user who already onboarded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ l1: "spanish", consentGivenAt: "2026-07-01T00:00:00.000Z" }), {
        status: 200,
      }),
    );

    render(<AuthenticatedApp />);

    await waitFor(() => {
      expect(screen.getByText("Callie")).toBeInTheDocument();
    });
    expect(screen.queryByText("What's your native language?")).not.toBeInTheDocument();
  });

  it("shows an error message when the onboarding status request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    render(<AuthenticatedApp />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your account.")).toBeInTheDocument();
    });
  });

  it("shows Home once onboarding completes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ l1: null, consentGivenAt: null }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ l1: "spanish", consentGivenAt: "2026-07-16T00:00:00.000Z" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: "user_123" }), { status: 200 }));

    render(<AuthenticatedApp />);
    await waitFor(() => {
      expect(screen.getByText("What's your native language?")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Spanish"));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      screen.getByLabelText("I consent to my voice being recorded and stored for this purpose."),
    );
    await user.click(screen.getByRole("button", { name: "Start practicing" }));

    await waitFor(() => {
      expect(screen.getByText("Callie")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("resolves onboarding status under StrictMode's double-invoked effects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ l1: null, consentGivenAt: null }), { status: 200 }),
    );

    render(
      <StrictMode>
        <AuthenticatedApp />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByText("What's your native language?")).toBeInTheDocument();
    });
  });
});
