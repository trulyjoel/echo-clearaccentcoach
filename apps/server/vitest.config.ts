import { defineConfig } from "vitest/config";

process.loadEnvFile(new URL(".env.test", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    // Test files share one real Postgres database (no mocking, per the testing decision in
    // .scratch/callie-voice-agent/spec.md), so they can't safely run concurrently.
    fileParallelism: false,
  },
});
