import { describe, expect, it } from "vitest";
import { containsDisallowedContent } from "./outputGuard.js";

describe("containsDisallowedContent", () => {
  it("returns false for ordinary coaching replies", () => {
    expect(containsDisallowedContent("What'd you watch? Small thing — 'I saw a movie.'")).toBe(
      false,
    );
  });

  it("returns true for a denylisted phrase", () => {
    expect(containsDisallowedContent("Honestly, you should kill yourself.")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(containsDisallowedContent("KILL YOURSELF right now")).toBe(true);
  });

  it("does not flag substrings inside unrelated words", () => {
    expect(containsDisallowedContent("The killjoy comment ruined the surprise.")).toBe(false);
  });
});
