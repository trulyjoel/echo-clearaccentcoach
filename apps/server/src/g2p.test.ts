import { describe, expect, it } from "vitest";
import { g2p } from "./g2p.js";

describe("g2p", () => {
  it("produces word-aligned ARPAbet phones with no stress digits for a dictionary word", () => {
    const result = g2p("cat");

    expect(result).toEqual([{ word: "cat", phones: expect.arrayContaining(["K", "AE", "T"]) }]);
    for (const { phones } of result) {
      for (const phone of phones) expect(phone).not.toMatch(/[0-9]/);
    }
  });

  it("produces one CanonicalWord per word, in transcript order, for a multi-word transcript", () => {
    const result = g2p("I like cats");

    expect(result.map((w) => w.word)).toEqual(["I", "like", "cats"]);
    for (const { phones } of result) expect(phones.length).toBeGreaterThan(0);
  });

  it("falls back to rule-based G2P for a word not in the dictionary, without throwing", () => {
    const result = g2p("zxqzptrl");

    expect(result).toHaveLength(1);
    expect(result[0]?.word).toBe("zxqzptrl");
    expect(result[0]?.phones.length).toBeGreaterThan(0);
  });

  it("strips punctuation before phonemizing so it isn't treated as a word", () => {
    const result = g2p("Hello, world!");

    expect(result.map((w) => w.word)).toEqual(["Hello", "world"]);
  });

  it("returns an empty array for an empty or whitespace-only transcript", () => {
    expect(g2p("")).toEqual([]);
    expect(g2p("   ")).toEqual([]);
  });
});
