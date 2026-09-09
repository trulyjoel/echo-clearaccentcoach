import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding.js";

const { getToken } = vi.hoisted(() => ({ getToken: async () => "test-token" }));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken }),
}));

describe("Onboarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires explicit consent before submitting, then posts consent only", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    render(<Onboarding onComplete={onComplete} />);

    const submit = screen.getByRole("button", { name: "Start practicing" });
    expect(submit).toBeDisabled();

    await user.click(
      screen.getByLabelText("I consent to my voice being recorded and stored for this purpose."),
    );
    expect(submit).toBeEnabled();

    await user.click(submit);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/onboarding",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ consent: true }),
      }),
    );
  });

  it("shows an error and does not complete onboarding when the request fails", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    render(<Onboarding onComplete={onComplete} />);
    await user.click(
      screen.getByLabelText("I consent to my voice being recorded and stored for this purpose."),
    );
    await user.click(screen.getByRole("button", { name: "Start practicing" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Couldn't save your preferences. Try again.",
      );
    });
    expect(onComplete).not.toHaveBeenCalled();
  });
});
