import { timingSafeEqual } from "node:crypto";
import type { AdjustableClock } from "../core/clock";
import { DomainError, errorResponse } from "../core/errors";
import type { HttpHandler } from "../server";

export interface ControlOptions {
  token?: string;
  clock: AdjustableClock;
  reset?: () => void;
}

export function createControlHandler(options: ControlOptions): HttpHandler {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__test/")) return null;
    if (!options.token) return Response.json({ error: "not_found" }, { status: 404 });
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return errorResponse(new DomainError("UNAUTHENTICATED", "Control token required"));
    }
    try {
      if (url.pathname === "/__test/reset" && request.method === "POST" && options.reset) {
        options.reset();
        return Response.json({ success: true });
      }
      if (url.pathname === "/__test/clock" && request.method === "GET") {
        return Response.json({ now: options.clock.now() });
      }
      if (url.pathname === "/__test/clock/advance" && request.method === "POST") {
        let input: unknown;
        try {
          input = await request.json();
        } catch {
          throw new DomainError("INVALID_INPUT", "Invalid JSON body");
        }
        if (
          !input ||
          typeof input !== "object" ||
          !("milliseconds" in input) ||
          typeof input.milliseconds !== "number"
        ) {
          throw new DomainError("INVALID_INPUT", "milliseconds is required");
        }
        return Response.json({ now: options.clock.advance(input.milliseconds) });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
