import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const { mockState } = vi.hoisted(() => ({ mockState: { signedIn: false } }));

vi.mock("@clerk/react", () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }) => {
    if (when === "signed-in" && mockState.signedIn) return children;
    if (when === "signed-out" && !mockState.signedIn) return children;
    return null;
  },
  SignIn: () => <div>Sign in with your email</div>,
}));

vi.mock("./Home.js", () => ({
  Home: () => <div>Home page</div>,
}));

describe("App", () => {
  it("shows the sign-in flow when signed out", () => {
    mockState.signedIn = false;

    render(<App />);

    expect(screen.getByText("Sign in with your email")).toBeInTheDocument();
    expect(screen.queryByText("Home page")).not.toBeInTheDocument();
  });

  it("shows the home page when signed in", () => {
    mockState.signedIn = true;

    render(<App />);

    expect(screen.getByText("Home page")).toBeInTheDocument();
    expect(screen.queryByText("Sign in with your email")).not.toBeInTheDocument();
  });
});
