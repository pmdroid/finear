import type { ResolverMap, GraphQLContext } from "../graphql/composition";
import { DomainError } from "../core/errors";
import { requireScope } from "../core/principal";

function capability(source: unknown, context: GraphQLContext, field: string): boolean {
  requireScope(context.principal, "read");
  const id = (source as { id: string }).id;
  const row = context.runtime.database
    .query<{ app: number; settings: string }>(
      "SELECT app, settings FROM users WHERE id = ? AND organization_id = ?",
    )
    .get(id, context.principal.organizationId);
  if (!row) throw new DomainError("NOT_FOUND", "User not found");
  if (!row.app) return field !== "supportsAgentSessions";
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  return settings[field] === true;
}

export function identityResolvers(): ResolverMap {
  return {
    User: {
      isAssignable: (source, _args, context) => capability(source, context, "isAssignable"),
      isMentionable: (source, _args, context) => capability(source, context, "isMentionable"),
      supportsAgentSessions: (source, _args, context) =>
        capability(source, context, "supportsAgentSessions"),
      canAccessAnyPublicTeam: (source, _args, context) =>
        capability(source, context, "canAccessAnyPublicTeam"),
    },
  };
}
