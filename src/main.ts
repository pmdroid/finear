import { createApplication } from "./application";

const port = Number(process.env.PORT ?? 4444);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}
const application = await createApplication({
  databasePath: process.env.DATABASE_PATH ?? "finear.sqlite",
  hostname: process.env.HOST ?? "127.0.0.1",
  port,
  controlToken: process.env.CONTROL_TOKEN,
});
console.log(`Finear listening at ${application.url}`);

async function shutdown() {
  await application.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
