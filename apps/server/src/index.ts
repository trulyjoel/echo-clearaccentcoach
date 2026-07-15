import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env["PORT"] ?? 3000);

app.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  app.log.error(error);
  process.exitCode = 1;
});
