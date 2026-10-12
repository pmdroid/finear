import { DomainError } from "../core/errors";
import { requireAdmin } from "../core/principal";
import type { ResolverMap } from "../graphql/composition";
import { supportingResolvers } from "../workspace/supporting";
import {
  createSubscription,
  deleteSubscription,
  projectSubscription,
  subscription,
  updateSubscription,
  type Subscription,
} from "./subscriptions";

export function deliveryResolvers(): ResolverMap {
  const directory = supportingResolvers().Query!;
  return {
    Query: {
      webhook: (_source, args, { runtime, principal }) =>
        projectSubscription(subscription(runtime.database, principal, args.id)),
      webhooks: (_source, args, { runtime, principal }) => {
        requireAdmin(principal);
        const orderBy = args.orderBy ?? "createdAt";
        if (!["createdAt", "updatedAt"].includes(String(orderBy)))
          throw new DomainError("INVALID_INPUT", "Invalid webhook order");
        const rows = runtime.database
          .query<Subscription>(
            `SELECT * FROM webhook_subscriptions WHERE organization_id = ? ORDER BY ${orderBy === "createdAt" ? "created_at" : "updated_at"}, id`,
          )
          .all(principal.organizationId)
          .filter((row) => !row.team_id || principal.teamIds.includes(row.team_id));
        const cursor = (row: Subscription) =>
          Buffer.from(`webhook:${row.id}`).toString("base64url");
        const index = (value: unknown) => {
          const result = rows.findIndex((row) => cursor(row) === value);
          if (result < 0) throw new DomainError("INVALID_INPUT", "Invalid webhook cursor");
          return result;
        };
        const first = args.first == null ? undefined : Number(args.first);
        const last = args.last == null ? undefined : Number(args.last);
        if (
          (first !== undefined && (!Number.isInteger(first) || first < 0)) ||
          (last !== undefined && (!Number.isInteger(last) || last < 0)) ||
          (first !== undefined && last !== undefined)
        )
          throw new DomainError("INVALID_INPUT", "Invalid pagination");
        const start = args.after == null ? 0 : index(args.after) + 1;
        const end = args.before == null ? rows.length : index(args.before);
        const selectedStart = last !== undefined ? Math.max(start, end - last) : start;
        const selectedEnd = last !== undefined ? end : Math.min(end, start + (first ?? 50));
        const selected = rows.slice(selectedStart, selectedEnd);
        return {
          nodes: selected.map(projectSubscription),
          edges: selected.map((row) => ({ cursor: cursor(row), node: projectSubscription(row) })),
          pageInfo: {
            hasPreviousPage: selectedStart > 0,
            hasNextPage: selectedEnd < rows.length,
            startCursor: selected.length ? cursor(selected[0]!) : null,
            endCursor: selected.length ? cursor(selected[selected.length - 1]!) : null,
          },
        };
      },
    },
    Mutation: {
      webhookCreate: (_source, args, { runtime, principal }) =>
        createSubscription(runtime, principal, args.input as Record<string, unknown>),
      webhookUpdate: (_source, args, { runtime, principal }) =>
        updateSubscription(runtime, principal, args.id, args.input as Record<string, unknown>),
      webhookDelete: (_source, args, { runtime, principal }) =>
        deleteSubscription(runtime, principal, args.id),
    },
    Webhook: {
      team: (source, _args, context, info) => {
        const row = subscription(
          context.runtime.database,
          context.principal,
          (source as { id: string }).id,
        );
        return row.team_id ? directory.team!(null, { id: row.team_id }, context, info) : null;
      },
      creator: (source, _args, context, info) => {
        const row = subscription(
          context.runtime.database,
          context.principal,
          (source as { id: string }).id,
        );
        return row.creator_id ? directory.user!(null, { id: row.creator_id }, context, info) : null;
      },
      failures: (source, _args, { runtime, principal }) => {
        const row = subscription(runtime.database, principal, (source as { id: string }).id);
        return runtime.database
          .query<{
            id: string;
            createdAt: number;
            executionId: string;
            httpStatus: number | null;
            responseOrError: string | null;
            url: string;
          }>(`SELECT a.id, a.sent_at AS createdAt, d.id AS executionId, a.http_status AS httpStatus, a.error AS responseOrError, d.url
          FROM webhook_attempts a JOIN webhook_deliveries d ON d.id = a.delivery_id
          WHERE d.subscription_id = ? AND a.completed_at IS NOT NULL AND (a.http_status IS NULL OR a.http_status != 200)
          ORDER BY a.rowid DESC LIMIT 50`)
          .all(row.id)
          .map((failure) => ({ ...failure, webhook: projectSubscription(row) }));
      },
    },
  };
}
