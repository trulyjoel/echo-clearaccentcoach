import { buildApp } from "./app.js";
import { cleanupExpiredClips } from "./audioClips.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const app = buildApp();
const port = Number(process.env["PORT"] ?? 3000);

app.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  app.log.error(error);
  process.exitCode = 1;
});

function runClipCleanup(): void {
  cleanupExpiredClips().catch((error: unknown) => {
    app.log.error(error, "Failed to clean up expired audio clips");
  });
}

runClipCleanup();
setInterval(runClipCleanup, CLEANUP_INTERVAL_MS);
