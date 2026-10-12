export interface ServerOptions {
  hostname?: string;
  port?: number;
}

export function startServer(options: ServerOptions = {}) {
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4444,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
}
