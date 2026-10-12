import { afterEach, describe, expect, test } from "bun:test";
import { startServer } from "../../src/server";

const servers: ReturnType<typeof startServer>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("HTTP bootstrap", () => {
  test("serves readiness over a real loopback listener", async () => {
    const server = startServer({ port: 0 });
    servers.push(server);
    expect(server.hostname).toBe("127.0.0.1");
    const response = await fetch(new URL("/health", server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("rejects unknown routes and non-GET readiness requests", async () => {
    const server = startServer({ port: 0 });
    servers.push(server);
    for (const [path, method] of [
      ["/unknown", "GET"],
      ["/health", "POST"],
    ] as const) {
      const response = await fetch(new URL(path, server.url), { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });
});
