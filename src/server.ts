export type HttpHandler = (request: Request) => Response | null | Promise<Response | null>;

export interface ServerOptions {
  hostname?: string;
  port?: number;
  handlers?: readonly HttpHandler[];
}

export function startServer(options: ServerOptions = {}) {
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4444,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }
      for (const handler of options.handlers ?? []) {
        const response = await handler(request);
        if (response) return response;
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
}
