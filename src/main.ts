import { createRuntime, resetRuntime } from "./core/runtime";
import { startServer } from "./server";
import { createGraphQLHandler } from "./graphql/http";
import { createControlHandler } from "./testing/control";

const port = Number(process.env.PORT ?? 4444);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}
const runtime = createRuntime({ databasePath: process.env.DATABASE_PATH ?? "finear.sqlite" });
if (!runtime.database.query("SELECT id FROM organizations LIMIT 1").get()) resetRuntime(runtime);
const server = startServer({
  hostname: process.env.HOST ?? "127.0.0.1",
  port,
  handlers: [
    await createGraphQLHandler(runtime),
    createControlHandler({
      token: process.env.CONTROL_TOKEN,
      clock: runtime.clock,
      reset: () => resetRuntime(runtime),
    }),
  ],
});
console.log(`Finear listening at ${server.url}`);

function shutdown() {
  server.stop(true);
  runtime.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
