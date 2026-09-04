import { describe, expect, it } from "vitest";
import { createMarkerResolver } from "./emphasisMarkers.js";

describe("createMarkerResolver", () => {
  it("passes unmarked text through as a single non-emphasized segment", () => {
    const resolver = createMarkerResolver();

    const result = resolver.feed("You'd say I went to the store.");

    expect(result).toEqual([
      {
        plain: "You'd say I went to the store.",
        speechText: "You'd say I went to the store.",
        emphasized: false,
      },
    ]);
  });

  it("resolves a marker fully contained in one delta into three ordered segments", () => {
    const resolver = createMarkerResolver();

    const result = resolver.feed("I went to «the» store.");

    expect(result).toEqual([
      { plain: "I went to ", speechText: "I went to ", emphasized: false },
      { plain: "the", speechText: "THE", emphasized: true },
      { plain: " store.", speechText: " store.", emphasized: false },
    ]);
  });

  it("emits no segment for a marker with nothing before it in the delta", () => {
    const resolver = createMarkerResolver();

    const result = resolver.feed("«the» store.");

    expect(result).toEqual([
      { plain: "the", speechText: "THE", emphasized: true },
      { plain: " store.", speechText: " store.", emphasized: false },
    ]);
  });

  it("resolves a marker split across multiple deltas", () => {
    const resolver = createMarkerResolver();

    const first = resolver.feed("I went to «th");
    const second = resolver.feed("e» store.");

    expect(first).toEqual([{ plain: "I went to ", speechText: "I went to ", emphasized: false }]);
    expect(second).toEqual([
      { plain: "the", speechText: "THE", emphasized: true },
      { plain: " store.", speechText: " store.", emphasized: false },
    ]);
  });

  it("resolves a marker whose delimiters each land in their own delta", () => {
    const resolver = createMarkerResolver();

    const first = resolver.feed("I went to «");
    const second = resolver.feed("the");
    const third = resolver.feed("» store.");

    expect(first).toEqual([{ plain: "I went to ", speechText: "I went to ", emphasized: false }]);
    expect(second).toEqual([]);
    expect(third).toEqual([
      { plain: "the", speechText: "THE", emphasized: true },
      { plain: " store.", speechText: " store.", emphasized: false },
    ]);
  });

  it("flushes an unterminated marker at stream end as literal, non-emphasized plain text", () => {
    const resolver = createMarkerResolver();

    resolver.feed("I went to «the store.");
    const flushed = resolver.flush();

    expect(flushed).toEqual({
      plain: "«the store.",
      speechText: "«the store.",
      emphasized: false,
    });
  });

  it("flush is a no-op when no marker is pending", () => {
    const resolver = createMarkerResolver();

    resolver.feed("I went to the store.");
    const flushed = resolver.flush();

    expect(flushed).toEqual({ plain: "", speechText: "", emphasized: false });
  });

  it("upper-cases any marked word, with no lookup table restricting which words qualify", () => {
    const resolver = createMarkerResolver();

    const result = resolver.feed("Say «Xylophone» clearly.");

    expect(result[1]).toEqual({ plain: "Xylophone", speechText: "XYLOPHONE", emphasized: true });
  });

  it("resolves multiple markers in one delta as separate emphasized segments", () => {
    const resolver = createMarkerResolver();

    const result = resolver.feed("Not «a» store, «the» store.");

    expect(result).toEqual([
      { plain: "Not ", speechText: "Not ", emphasized: false },
      { plain: "a", speechText: "A", emphasized: true },
      { plain: " store, ", speechText: " store, ", emphasized: false },
      { plain: "the", speechText: "THE", emphasized: true },
      { plain: " store.", speechText: " store.", emphasized: false },
    ]);
  });

  it("puts a sentence boundary that lands before the marker in its own earlier segment", () => {
    // The correctness property session.ts relies on: a caller splitting sentences per segment,
    // in order, sees the boundary in the first (non-emphasized) segment before it ever observes
    // the emphasized segment — so an earlier, unrelated sentence in the same delta never gets
    // mistakenly flagged as the emphasized one.
    const resolver = createMarkerResolver();

    const result = resolver.feed("Nice try! You'd say I went to «the» store.");

    expect(result[0]).toEqual({
      plain: "Nice try! You'd say I went to ",
      speechText: "Nice try! You'd say I went to ",
      emphasized: false,
    });
    expect(result[1]).toEqual({ plain: "the", speechText: "THE", emphasized: true });
  });
});
