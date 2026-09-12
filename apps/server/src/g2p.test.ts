import { describe, expect, it } from "vitest";
import { CANONICAL_VALID_PHONES, g2p } from "./g2p.js";

describe("g2p", () => {
  it("produces word-aligned canonical phones with no stress digits for a dictionary word", async () => {
    const result = await g2p("cat");

    expect(result).toEqual([{ word: "cat", phones: ["k", "æ", "t"] }]);
    for (const { phones } of result) {
      for (const phone of phones) expect(phone).not.toMatch(/[0-9]/);
    }
  });

  it("produces one CanonicalWord per word, in transcript order, for a multi-word transcript", async () => {
    const result = await g2p("I like cats");

    expect(result.map((w) => w.word)).toEqual(["I", "like", "cats"]);
    for (const { phones } of result) expect(phones.length).toBeGreaterThan(0);
  });

  it("falls back to rule-based G2P for a word not in the dictionary, without throwing", async () => {
    const result = await g2p("zxqzptrl");

    expect(result).toHaveLength(1);
    expect(result[0]?.word).toBe("zxqzptrl");
    expect(result[0]?.phones.length).toBeGreaterThan(0);
  });

  it("strips punctuation before phonemizing so it isn't treated as a word", async () => {
    const result = await g2p("Hello, world!");

    expect(result.map((w) => w.word)).toEqual(["Hello", "world"]);
  });

  it("returns an empty array for an empty or whitespace-only transcript", async () => {
    expect(await g2p("")).toEqual([]);
    expect(await g2p("   ")).toEqual([]);
  });

  it("every phone g2p ever emits is a member of wav2vec2's 39-phone vocabulary", async () => {
    const result = await g2p("I like cats hello 1995");
    for (const { phones } of result) {
      for (const phone of phones) expect(CANONICAL_VALID_PHONES.has(phone)).toBe(true);
    }
  });

  it("normalizes espeak-ng's reduced schwa to a canonical phone for a word known to trigger it", async () => {
    const result = await g2p("hello");

    expect(result).toHaveLength(1);
    // "hello" -> /həlˈoʊ/ — the unstressed first syllable's schwa must resolve to "ʌ", not pass
    // through as the raw IPA "ə" (which isn't in wav2vec2's target vocabulary).
    expect(result[0]?.phones).toEqual(["h", "ʌ", "l", "oʊ"]);
  });

  it("joins phones from every expanded entry for a number, without truncating to just the first", async () => {
    const result = await g2p("1995");

    expect(result).toHaveLength(1);
    expect(result[0]?.word).toBe("1995");
    // "1995" expands to three entries ("nineteen"/"ninety"/"five") — a truncated implementation
    // that only reads the first entry would produce far fewer phones than this.
    expect(result[0]?.phones.length).toBeGreaterThan(5);
    for (const phone of result[0]?.phones ?? []) {
      expect(CANONICAL_VALID_PHONES.has(phone)).toBe(true);
    }
  });

  it("doesn't truncate for a non-ASCII/accented word", async () => {
    const result = await g2p("naïve");

    expect(result).toHaveLength(1);
    expect(result[0]?.word).toBe("naïve");
    expect(result[0]?.phones.length).toBeGreaterThan(0);
    for (const phone of result[0]?.phones ?? []) {
      expect(CANONICAL_VALID_PHONES.has(phone)).toBe(true);
    }
  });
});
