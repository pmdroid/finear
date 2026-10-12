import { DomainError } from "../core/errors";
import type { Entity, ListArgs } from "./types";

export function paginate<T extends Entity>(input: T[], args: ListArgs, namespace: string) {
  const first = args.first ?? undefined;
  const last = args.last ?? undefined;
  if (
    (first !== undefined && (!Number.isInteger(first) || first < 0)) ||
    (last !== undefined && (!Number.isInteger(last) || last < 0)) ||
    (first !== undefined && last !== undefined)
  )
    throw new DomainError("INVALID_INPUT", "Invalid pagination");
  const sorts: { field: string; descending: boolean; nullsFirst: boolean }[] = [];
  if (args.sort !== undefined && args.sort !== null) {
    const supplied = Array.isArray(args.sort) ? args.sort : [args.sort];
    for (const entry of supplied) {
      if (!entry || typeof entry !== "object")
        throw new DomainError("INVALID_INPUT", "Invalid sort");
      for (const [key, raw] of Object.entries(entry)) {
        const field = key === "manual" ? "sortOrder" : key;
        if (
          ![
            "createdAt",
            "updatedAt",
            "priority",
            "sortOrder",
            "name",
            "title",
            "estimate",
            "dueDate",
            "startDate",
            "targetDate",
            "completedAt",
          ].includes(field) ||
          !raw ||
          typeof raw !== "object"
        )
          throw new DomainError("INVALID_INPUT", `Unsupported sort ${key}`);
        const options = raw as Record<string, unknown>;
        if (
          Object.keys(options).some((key) => !["order", "nulls"].includes(key)) ||
          !["Ascending", "Descending"].includes(String(options.order)) ||
          (options.nulls !== undefined && !["first", "last"].includes(String(options.nulls)))
        )
          throw new DomainError("INVALID_INPUT", "Invalid sort options");
        sorts.push({
          field,
          descending: options.order === "Descending",
          nullsFirst: options.nulls === "first",
        });
      }
    }
  }
  if (!sorts.length) {
    if (args.orderBy && !["createdAt", "updatedAt"].includes(args.orderBy))
      throw new DomainError("INVALID_INPUT", "Invalid orderBy");
    sorts.push({ field: args.orderBy ?? "createdAt", descending: false, nullsFirst: false });
  }
  const result = [...input].sort((a, b) => {
    for (const { field, descending, nullsFirst } of sorts) {
      if (!Object.hasOwn(a, field) || !Object.hasOwn(b, field))
        throw new DomainError("INVALID_INPUT", `Sort ${field} is unavailable for this entity`);
      const left = a[field];
      const right = b[field];
      if (left === right) continue;
      if (left === null || left === undefined) return nullsFirst ? -1 : 1;
      if (right === null || right === undefined) return nullsFirst ? 1 : -1;
      const order = left < right ? -1 : 1;
      return descending ? -order : order;
    }
    return a.id.localeCompare(b.id);
  });
  const cursor = (entity: T) =>
    Buffer.from(JSON.stringify([namespace, sorts, entity.id])).toString("base64url");
  const index = (value: string) => {
    const found = result.findIndex((entity) => cursor(entity) === value);
    if (found < 0) throw new DomainError("INVALID_INPUT", "Invalid cursor");
    return found;
  };
  let start = args.after ? index(args.after) + 1 : 0;
  let end = args.before ? index(args.before) : result.length;
  if (start > end) throw new DomainError("INVALID_INPUT", "Invalid cursor range");
  if (last !== undefined) start = Math.max(start, end - last);
  else end = Math.min(end, start + (first ?? 50));
  const nodes = result.slice(start, end);
  return {
    nodes,
    edges: nodes.map((node) => ({ node, cursor: cursor(node) })),
    pageInfo: {
      hasPreviousPage: start > 0,
      hasNextPage: end < result.length,
      startCursor: nodes.length ? cursor(nodes[0]!) : null,
      endCursor: nodes.length ? cursor(nodes[nodes.length - 1]!) : null,
    },
  };
}
