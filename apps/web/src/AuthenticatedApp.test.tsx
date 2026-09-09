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

function statusResponse(overrides: { consentGivenAt: string | null }): string {
  return JSON.stringify({
    consentGivenAt: overrides.consentGivenAt,
    name: null,
    l1: null,
    proficiency: null,
    context: null,
    goals: null,
  });
}

describe("AuthenticatedApp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows onboarding for a first-login user with no consent on record", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(statusResponse({ consentGivenAt: null }), { status: 200 }),
    );

    render(<AuthenticatedApp />);

    await waitFor(() => {
      expect(screen.getByText("Recording consent")).toBeInTheDocument();
    });
  });

  it("shows Home directly once consent is on record, even if the rest of the profile isn't set", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(statusResponse({ consentGivenAt: "2026-07-01T00:00:00.000Z" }), { status: 200 }),
    );

    render(<AuthenticatedApp />);

    await waitFor(() => {
      expect(screen.getByText("Kalli")).toBeInTheDocument();
    });
    expect(screen.queryByText("Recording consent")).not.toBeInTheDocument();
  });

  it("shows an error message when the onboarding status request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    render(<AuthenticatedApp />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your account.")).toBeInTheDocument();
    });
  });

  it("shows Home once consent is given", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(statusResponse({ consentGivenAt: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(statusResponse({ consentGivenAt: "2026-07-16T00:00:00.000Z" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: "user_123" }), { status: 200 }));

    render(<AuthenticatedApp />);
    await waitFor(() => {
      expect(screen.getByText("Recording consent")).toBeInTheDocument();
    });

    await user.click(
      screen.getByLabelText("I consent to my voice being recorded and stored for this purpose."),
    );
    await user.click(screen.getByRole("button", { name: "Start practicing" }));

    await waitFor(() => {
      expect(screen.getByText("Kalli")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("resolves onboarding status under StrictMode's double-invoked effects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(statusResponse({ consentGivenAt: null }), { status: 200 }),
    );

    render(
      <StrictMode>
        <AuthenticatedApp />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByText("Recording consent")).toBeInTheDocument();
    });
  });
});
