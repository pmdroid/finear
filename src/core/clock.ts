import type { Database } from "./database";
import { DomainError } from "./errors";

export interface Clock {
  now(): number;
}

export interface AdjustableClock extends Clock {
  advance(milliseconds: number): number;
}

export function createClock(database: Database, source: () => number = Date.now): AdjustableClock {
  function now() {
    const offset = database
      .query<{ offset_ms: number }>("SELECT offset_ms FROM clock WHERE id = 1")
      .get();
    if (!offset) throw new DomainError("CONFLICT", "Clock has not been initialized");
    const value = source() + offset.offset_ms;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new DomainError("INVALID_INPUT", "Clock source must return epoch milliseconds");
    return value;
  }
  return {
    now,
    advance(milliseconds) {
      if (
        !Number.isSafeInteger(milliseconds) ||
        milliseconds < 0 ||
        !Number.isSafeInteger(now() + milliseconds)
      ) {
        throw new DomainError("INVALID_INPUT", "Clock advance must be a nonnegative safe integer");
      }
      database.transaction((tx) => {
        tx.run("UPDATE clock SET offset_ms = offset_ms + ? WHERE id = 1", milliseconds);
      });
      return now();
    },
  };
}
