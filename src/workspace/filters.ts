import { DomainError } from "../core/errors";
import type { Entity } from "./types";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("INVALID_INPUT", "Invalid filter object");
  return value as ObjectValue;
}
const comparators = new Set([
  "eq",
  "neq",
  "in",
  "nin",
  "contains",
  "notContains",
  "containsIgnoreCase",
  "notContainsIgnoreCase",
  "startsWith",
  "endsWith",
  "lt",
  "lte",
  "gt",
  "gte",
  "null",
]);
const fields = new Set([
  "id",
  "title",
  "name",
  "description",
  "number",
  "identifier",
  "priority",
  "estimate",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "completedAt",
  "startedAt",
  "canceledAt",
  "dueDate",
  "startDate",
  "targetDate",
  "state",
  "status",
  "team",
  "project",
  "parent",
  "assignee",
  "delegate",
  "creator",
  "labels",
  "teams",
  "members",
  "body",
  "issue",
  "user",
  "type",
  "key",
  "color",
  "email",
  "isGroup",
]);
const relations = new Set([
  "state",
  "status",
  "team",
  "project",
  "parent",
  "assignee",
  "delegate",
  "creator",
  "issue",
  "user",
]);
const collections = new Set(["labels", "teams", "members"]);
function comparable(value: unknown, now: number): unknown {
  if (typeof value !== "string") return value;
  const duration = /^(-?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (duration)
    return (
      now +
      (duration[1] ? -1 : 1) *
        ((Number(duration[2] ?? 0) * 86400 +
          Number(duration[3] ?? 0) * 3600 +
          Number(duration[4] ?? 0) * 60 +
          Number(duration[5] ?? 0)) *
          1000)
    );
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return Date.parse(value);
  return value;
}
function predicate(input: unknown, now: number): (value: unknown) => boolean {
  const rules = Object.entries(object(input)).map(([operator, expected]) => {
    if (!comparators.has(operator))
      throw new DomainError("INVALID_INPUT", `Unsupported comparator ${operator}`);
    if ((operator === "in" || operator === "nin") && !Array.isArray(expected))
      throw new DomainError("INVALID_INPUT", "Expected comparator list");
    if (operator === "null" && typeof expected !== "boolean")
      throw new DomainError("INVALID_INPUT", "Expected null boolean");
    return (value: unknown) => {
      if (operator === "null") return (value === null || value === undefined) === expected;
      if (operator === "eq") return value === expected;
      if (operator === "neq") return value !== expected;
      if (operator === "in") return (expected as unknown[]).includes(value);
      if (operator === "nin") return !(expected as unknown[]).includes(value);
      if (value === null || value === undefined) return false;
      const actual = comparable(value, now) as string | number;
      const target = comparable(expected, now) as string | number;
      if (operator === "lt") return actual < target;
      if (operator === "lte") return actual <= target;
      if (operator === "gt") return actual > target;
      if (operator === "gte") return actual >= target;
      if (typeof value !== "string" || typeof expected !== "string")
        throw new DomainError("INVALID_INPUT", "Expected text comparator");
      if (operator === "startsWith") return value.startsWith(expected);
      if (operator === "endsWith") return value.endsWith(expected);
      const found = operator.includes("IgnoreCase")
        ? value.toLowerCase().includes(expected.toLowerCase())
        : value.includes(expected);
      return operator.startsWith("not") ? !found : found;
    };
  });
  return (value) => rules.every((rule) => rule(value));
}
function compile(input: unknown, now: number): (entity: Record<string, unknown>) => boolean {
  const rules = Object.entries(object(input)).map(([field, condition]) => {
    if (field === "and" || field === "or") {
      if (!Array.isArray(condition))
        throw new DomainError("INVALID_INPUT", "Expected logical filter list");
      const nested = condition.map((item) => compile(item, now));
      return (entity: Record<string, unknown>) =>
        field === "and"
          ? nested.every((rule) => rule(entity))
          : nested.some((rule) => rule(entity));
    }
    if (!fields.has(field)) throw new DomainError("INVALID_INPUT", `Unsupported filter ${field}`);
    if (relations.has(field)) {
      const value = object(condition);
      if (Object.hasOwn(value, "null") && typeof value.null !== "boolean")
        throw new DomainError("INVALID_INPUT", "Expected relation null boolean");
      const { null: nullFilter, ...nested } = value;
      const test = compile(nested, now);
      return (entity: Record<string, unknown>) => {
        const absent = entity[field] === null || entity[field] === undefined;
        if (nullFilter !== undefined && absent !== nullFilter) return false;
        return Object.keys(nested).length === 0 || (!absent && test(object(entity[field])));
      };
    }
    if (collections.has(field)) {
      const entries = Object.entries(object(condition));
      const regular = Object.fromEntries(
        entries.filter(([key]) => !["some", "every", "none", "length", "null"].includes(key)),
      );
      const regularTest = compile(regular, now);
      const rules = entries
        .filter(([key]) => ["some", "every", "none", "length", "null"].includes(key))
        .map(([mode, value]) => {
          if (mode === "null") {
            if (typeof value !== "boolean")
              throw new DomainError("INVALID_INPUT", "Expected collection null boolean");
            return (values: Record<string, unknown>[]) => (values.length === 0) === value;
          }
          if (mode === "length") {
            const test = predicate(value, now);
            return (values: Record<string, unknown>[]) => test(values.length);
          }
          const test = compile(value, now);
          return (values: Record<string, unknown>[]) =>
            mode === "some"
              ? values.some(test)
              : mode === "every"
                ? values.every(test)
                : !values.some(test);
        });
      return (entity: Record<string, unknown>) => {
        const values = (entity[field] ?? []) as Record<string, unknown>[];
        return (
          rules.every((rule) => rule(values)) &&
          (Object.keys(regular).length === 0 || values.some(regularTest))
        );
      };
    }
    const test = predicate(condition, now);
    return (entity: Record<string, unknown>) => {
      if (!Object.hasOwn(entity, field))
        throw new DomainError("INVALID_INPUT", `Filter ${field} is unavailable for this entity`);
      return test(entity[field]);
    };
  });
  return (entity) => rules.every((rule) => rule(entity));
}
export function filterEntities<T extends Entity>(entities: T[], filter: unknown, now: number): T[] {
  if (filter === undefined || filter === null) return entities;
  return entities.filter(compile(filter, now));
}
