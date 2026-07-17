import { defineConfig } from "vitest/config";

process.loadEnvFile(new URL(".env.test", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
  },
});
