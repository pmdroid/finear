import { GraphQLScalarType, Kind, valueFromASTUntyped, type ValueNode } from "graphql";
import type { Clock } from "../core/clock";
import { DomainError } from "../core/errors";

function invalid(name: string): never {
  throw new DomainError("INVALID_INPUT", `Invalid ${name} value`);
}

function jsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || !value || seen.has(value)) invalid("JSON");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    invalid("JSON");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) invalid("JSON");
      jsonValue(value[index], seen);
    }
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) invalid("JSON");
      jsonValue(descriptor.value, seen);
    }
    if (Object.getOwnPropertySymbols(value).length) invalid("JSON");
  }
  seen.delete(value);
}

function embedded(value: unknown): unknown {
  if (!value || typeof value !== "object") invalid("JSONObject");
  jsonValue(value);
  return value;
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string") invalid("JSON");
  let result: unknown;
  try {
    result = JSON.parse(value);
  } catch {
    invalid("JSON");
  }
  jsonValue(result);
  return result;
}

function absoluteDate(value: string): number {
  const match =
    /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      value,
    );
  if (!match || (match[4] && !match[3])) invalid("date");
  const year = Number(match[1]);
  const month = Number(match[2] ?? 1);
  const day = Number(match[3] ?? 1);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
    Number((match[7] ?? "0").padEnd(3, "0")),
  );
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    Number(match[4] ?? 0) > 23 ||
    Number(match[5] ?? 0) > 59 ||
    Number(match[6] ?? 0) > 59
  )
    invalid("date");
  const offset = match[8];
  if (offset && offset !== "Z") {
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4));
    if (hours > 23 || minutes > 59) invalid("date");
    date.setTime(date.getTime() - (offset[0] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60000);
  }
  if (!Number.isFinite(date.getTime())) invalid("date");
  return date.getTime();
}

function duration(value: string): RegExpExecArray | null {
  const match =
    /^([+-])?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/.exec(
      value,
    );
  if (!match || !match.slice(2).some((part) => part !== undefined) || value.endsWith("T"))
    return null;
  return match;
}

function relativeDate(parts: RegExpExecArray, clock?: Clock): number {
  if (!clock) throw new DomainError("INVALID_INPUT", "Relative dates require a clock");
  const now = clock.now();
  if (!Number.isSafeInteger(now)) invalid("clock");
  const sign = parts[1] === "-" ? -1 : 1;
  const values = parts.slice(2).map((part) => Number(part ?? 0));
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + sign * values[0]!);
  date.setUTCMonth(date.getUTCMonth() + sign * values[1]!);
  const last = new Date(date.getTime());
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, last.getUTCDate()));
  const milliseconds =
    sign *
    ((values[2]! * 7 + values[3]!) * 86400000 +
      values[4]! * 3600000 +
      values[5]! * 60000 +
      values[6]! * 1000);
  const result = date.getTime() + milliseconds;
  if (!Number.isSafeInteger(result) || !Number.isFinite(new Date(result).getTime()))
    invalid("date");
  return result;
}

function dateScalar(name: string, clock?: Clock): GraphQLScalarType {
  const timeless = name.startsWith("TimelessDate");
  function input(value: unknown): string {
    if (typeof value !== "string") invalid(name);
    const parts = duration(value);
    if (parts && name === "TimelessDateOrDuration") return value;
    const epoch = parts ? relativeDate(parts, clock) : absoluteDate(value);
    return new Date(epoch).toISOString().slice(0, timeless ? 10 : undefined);
  }
  return new GraphQLScalarType({
    name,
    serialize(value) {
      if (value instanceof Date || typeof value === "number") {
        const epoch = value instanceof Date ? value.getTime() : value;
        if (!Number.isSafeInteger(epoch) || !Number.isFinite(new Date(epoch).getTime()))
          invalid(name);
        return new Date(epoch).toISOString().slice(0, timeless ? 10 : undefined);
      }
      if (typeof value !== "string" || duration(value)) invalid(name);
      return input(value);
    },
    parseValue: input,
    parseLiteral(node) {
      if (node.kind !== Kind.STRING) invalid(name);
      return input(node.value);
    },
  });
}

function structuredLiteral(
  node: ValueNode,
  variables?: Readonly<Record<string, unknown>> | null,
): unknown {
  return embedded(valueFromASTUntyped(node, variables));
}

export function contractScalars(clock?: Clock): readonly GraphQLScalarType[] {
  return [
    ...["DateTime", "DateTimeOrDuration", "TimelessDate", "TimelessDateOrDuration"].map((name) =>
      dateScalar(name, clock),
    ),
    new GraphQLScalarType({
      name: "JSON",
      serialize(value) {
        jsonValue(value);
        return JSON.stringify(value);
      },
      parseValue: decoded,
      parseLiteral(node) {
        if (node.kind !== Kind.STRING) invalid("JSON");
        return decoded(node.value);
      },
    }),
    new GraphQLScalarType({
      name: "JSONObject",
      serialize: embedded,
      parseValue: embedded,
      parseLiteral: structuredLiteral,
    }),
  ];
}
