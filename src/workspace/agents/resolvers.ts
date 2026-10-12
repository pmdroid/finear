import type { OperationRoots } from "../../graphql/contract";
import type { FieldResolver, ResolverMap } from "../../graphql/composition";
import { supportingResolvers } from "../supporting";
import type { Entity } from "../types";
import type { ActivityInput, Agents, SessionInput, SessionUpdate } from "./index";

export const agentsRoots = {
  query: ["agentSession", "agentSessions", "agentActivity", "agentActivities"],
  mutation: [
    "agentSessionCreateOnIssue",
    "agentSessionCreateOnComment",
    "agentSessionUpdate",
    "agentActivityCreate",
  ],
} as const satisfies OperationRoots;

export const agentsOperations = [
  "agentSessionCreateOnIssue",
  "agentSessionCreateOnComment",
  "updateAgentSession",
  "agentSession",
  "agentSessions",
  "agentSession_activities",
  "createAgentActivity",
  "agentActivity",
  "agentActivities",
] as const;

export function agentsResolvers(agents: Agents): ResolverMap {
  const supporting = supportingResolvers();
  const id = (source: unknown) => (source as Entity).id;
  const payload = (
    result: { entity: Entity; success: boolean; lastSyncId: number },
    field: string,
  ) => ({ ...result, [field]: result.entity });
  const relation =
    (field: string, root: string): FieldResolver =>
    (source, _args, context) => {
      const value = (source as Entity)[field] as Entity | null;
      return value ? supporting.Query![root]!(null, { id: value.id }, context, {} as never) : null;
    };
  return {
    Query: {
      agentSession: (_source, args, { principal }) =>
        agents.requireSession(principal, String(args.id)),
      agentSessions: (_source, args, { principal }) => agents.listSessions(principal, args),
      agentActivity: (_source, args, { principal }) =>
        agents.requireActivity(principal, String(args.id)),
      agentActivities: (_source, args, { principal }) => agents.listActivities(principal, args),
    },
    Mutation: {
      agentSessionCreateOnIssue: (_source, args, { principal }) =>
        payload(agents.createOnIssue(principal, args.input as SessionInput), "agentSession"),
      agentSessionCreateOnComment: (_source, args, { principal }) =>
        payload(agents.createOnComment(principal, args.input as SessionInput), "agentSession"),
      agentSessionUpdate: (_source, args, { principal }) =>
        payload(
          agents.updateSession(principal, String(args.id), args.input as SessionUpdate),
          "agentSession",
        ),
      agentActivityCreate: (_source, args, { principal }) =>
        payload(agents.createActivity(principal, args.input as ActivityInput), "agentActivity"),
    },
    AgentSession: {
      activities: (source, args, { principal }) =>
        agents.listActivities(principal, args, id(source)),
      appUser: relation("appUser", "user"),
      creator: relation("creator", "user"),
      dismissedBy: relation("dismissedBy", "user"),
      issue: (source, _args, { principal }) => {
        const value = (source as Entity).issue as Entity | null;
        return value ? agents.workspace.requireIssue(principal, value.id) : null;
      },
      comment: (source, _args, { principal }) => {
        const value = (source as Entity).comment as Entity | null;
        return value ? agents.workspace.requireComment(principal, value.id) : null;
      },
      sourceComment: (source, _args, { principal }) => {
        const value = (source as Entity).sourceComment as Entity | null;
        return value ? agents.workspace.requireComment(principal, value.id) : null;
      },
    },
    AgentActivity: {
      agentSession: (source, _args, { principal }) =>
        agents.requireSession(principal, ((source as Entity).agentSession as Entity).id),
      user: relation("user", "user"),
      sourceComment: (source, _args, { principal }) => {
        const value = (source as Entity).sourceComment as Entity | null;
        return value ? agents.workspace.requireComment(principal, value.id) : null;
      },
    },
    Issue: {
      agentSessions: (source, args, { principal }) =>
        agents.listSessions(principal, args, id(source)),
    },
    Comment: {
      agentSession: (source, _args, { principal }) =>
        agents.sessionForComment(principal, id(source)),
    },
  };
}
