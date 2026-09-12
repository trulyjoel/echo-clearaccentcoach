import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalWord } from "./g2p.js";
import { getPronunciationProvider, warmUpPronunciationService } from "./pronunciation.js";

function fakeLogger(): FastifyBaseLogger {
  return { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
}

const SAMPLE_PHONES: CanonicalWord[] = [{ word: "like", phones: ["L", "AY", "K"] }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpPronunciationProvider", () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env["PRONUNCIATION_SERVICE_URL"];
  const originalToken = process.env["PRONUNCIATION_SERVICE_TOKEN"];

  afterEach(() => {
    global.fetch = originalFetch;
    process.env["PRONUNCIATION_SERVICE_URL"] = originalUrl;
    process.env["PRONUNCIATION_SERVICE_TOKEN"] = originalToken;
  });

  it("throws when PRONUNCIATION_SERVICE_URL is not configured", async () => {
    delete process.env["PRONUNCIATION_SERVICE_URL"];

    await expect(
      getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES),
    ).rejects.toThrow("PRONUNCIATION_SERVICE_URL is required");
  });

  it("POSTs the audio and canonical phones as multipart form data and returns the edit ops", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    process.env["PRONUNCIATION_SERVICE_TOKEN"] = "test-token";
    let capturedUrl: string | undefined;
    let capturedForm: FormData | undefined;
    let capturedHeaders: Headers | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedForm = init?.body as FormData;
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse({
        editOps: [
          { word: "like", wordIndex: 0, op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES);

    expect(capturedUrl).toBe("https://pronunciation.example.test/score");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer test-token");
    expect(capturedForm?.get("canonical_phones")).toBe(JSON.stringify(SAMPLE_PHONES));
    const audioPart = capturedForm?.get("audio");
    expect(audioPart).toBeInstanceOf(Blob);
    expect(result).toEqual([
      { word: "like", wordIndex: 0, op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" },
    ]);
  });

  it("throws with the response status and body on a non-2xx response", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    global.fetch = vi.fn(
      async () => new Response("model unavailable", { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(
      getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES),
    ).rejects.toThrow("503");
  });

  it("rejects when the response body doesn't match the expected schema", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    global.fetch = vi.fn(async () =>
      jsonResponse({
        editOps: [
          { word: "like", wordIndex: 0, op: "bogus", expectedPhoneme: "L", spokenPhoneme: "R" },
        ],
      }),
    ) as unknown as typeof fetch;

    await expect(
      getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES),
    ).rejects.toThrow();
  });

  it("rejects when the response body is missing the editOps field", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    global.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;

    await expect(
      getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES),
    ).rejects.toThrow();
  });

  it("round-trips a null expectedPhoneme for an insertion", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    global.fetch = vi.fn(async () =>
      jsonResponse({
        editOps: [
          { word: "like", wordIndex: 0, op: "ins", expectedPhoneme: null, spokenPhoneme: "AH" },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES);

    expect(result).toEqual([
      { word: "like", wordIndex: 0, op: "ins", expectedPhoneme: null, spokenPhoneme: "AH" },
    ]);
  });

  it("rejects when the request never resolves within the timeout", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    let capturedSignal: AbortSignal | undefined;
    global.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
      });
    }) as unknown as typeof fetch;

    const promise = getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    capturedSignal?.dispatchEvent(new Event("abort"));

    await expect(promise).rejects.toThrow();
  });
});

describe("warmUpPronunciationService", () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env["PRONUNCIATION_SERVICE_URL"];
  const originalToken = process.env["PRONUNCIATION_SERVICE_TOKEN"];

  afterEach(() => {
    global.fetch = originalFetch;
    process.env["PRONUNCIATION_SERVICE_URL"] = originalUrl;
    process.env["PRONUNCIATION_SERVICE_TOKEN"] = originalToken;
  });

  it("GETs /health with the bearer token, without the caller waiting on it", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    process.env["PRONUNCIATION_SERVICE_TOKEN"] = "test-token";
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse({ status: "ok" });
    }) as unknown as typeof fetch;

    const returned = warmUpPronunciationService(fakeLogger());

    expect(returned).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capturedUrl).toBe("https://pronunciation.example.test/health");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer test-token");
  });

  it("logs and swallows a network failure instead of throwing", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    global.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const log = fakeLogger();

    warmUpPronunciationService(log);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(log.warn).toHaveBeenCalledWith(expect.any(Error), "Failed to warm up pronunciation service");
  });

  it("logs a non-2xx response instead of throwing", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    global.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const log = fakeLogger();

    warmUpPronunciationService(log);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(log.warn).toHaveBeenCalledWith(
      { status: 401 },
      "Pronunciation service warm-up request failed",
    );
  });
});
