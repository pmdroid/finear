import { startServer } from "./server";

const port = Number(process.env.PORT ?? 4444);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}
const server = startServer({ hostname: process.env.HOST ?? "127.0.0.1", port });
console.log(`Finear listening at ${server.url}`);

function shutdown() {
  server.stop(true);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
