import type { FieldResolver, GraphQLContext, ResolverMap } from "../graphql/composition";
import { DomainError } from "../core/errors";
import { Workspace } from "./entities";
import { supportingResolvers } from "./supporting";
import { paginate } from "./pagination";
import { filterEntities } from "./filters";
import type { CommentInput, Entity, IssueInput, LabelInput, ListArgs, ProjectInput } from "./types";

export function workspaceEntityResolvers(workspace: Workspace): ResolverMap {
  const supporting = supportingResolvers();
  const entityId = (source: unknown) => String((source as Entity).id);
  const relationship =
    (field: string, get: (context: GraphQLContext, id: string) => unknown): FieldResolver =>
    (source, _args, context) => {
      const reference = (source as Entity)[field] as Entity | null;
      return reference ? get(context, reference.id) : null;
    };
  const directory = (root: string, context: GraphQLContext, id: string) =>
    supporting.Query![root]!(null, { id }, context, {} as never);
  const issue = (_context: GraphQLContext, id: string) =>
    workspace.requireIssue(_context.principal, id);
  const project = (_context: GraphQLContext, id: string) =>
    workspace.requireProject(_context.principal, id);
  const comment = (_context: GraphQLContext, id: string) =>
    workspace.requireComment(_context.principal, id);
  const user = (context: GraphQLContext, id: string) => directory("user", context, id);
  const team = (context: GraphQLContext, id: string) => directory("team", context, id);
  const payload = (result: ReturnType<Workspace["createIssue"]>, field: string) => ({
    ...result,
    [field]: result.entity,
  });
  const input = <T>(value: unknown) => value as T;
  const projectCollection =
    (field: "teams" | "members", root: string): FieldResolver =>
    (source, args, context) => {
      const entity = workspace.requireProject(context.principal, entityId(source));
      const nodes = (entity[field] as Entity[]).map(
        (node) => directory(root, context, node.id) as Entity,
      );
      return paginate(
        filterEntities(nodes, args.filter, context.runtime.clock.now()),
        args,
        `project-${field}:${entity.id}`,
      );
    };
  return {
    Query: {
      issue: (_source, args, { principal }) => workspace.requireIssue(principal, String(args.id)),
      issues: (_source, args, { principal }) => workspace.listIssues(principal, args),
      project: (_source, args, { principal }) =>
        workspace.requireProject(principal, String(args.id)),
      projects: (_source, args, { principal }) => workspace.listProjects(principal, args),
      comment: (_source, args, { principal }) =>
        workspace.requireComment(principal, String(args.id)),
      comments: (_source, args, { principal }) => workspace.listComments(principal, args),
      issueLabel: (_source, args, { principal }) =>
        workspace.requireLabel(principal, String(args.id)),
      issueLabels: (_source, args, { principal }) => workspace.listLabels(principal, args),
    },
    Mutation: {
      issueCreate: (_source, args, { principal }) =>
        payload(workspace.createIssue(principal, input<IssueInput>(args.input)), "issue"),
      issueUpdate: (_source, args, { principal }) =>
        payload(
          workspace.updateIssue(principal, String(args.id), input<IssueInput>(args.input)),
          "issue",
        ),
      issueArchive: (_source, args, { principal }) =>
        workspace.archiveIssue(principal, String(args.id), args.trash === true),
      issueUnarchive: (_source, args, { principal }) =>
        workspace.unarchiveIssue(principal, String(args.id)),
      issueDelete: (_source, args, { principal }) =>
        workspace.deleteIssue(principal, String(args.id)),
      projectCreate: (_source, args, { principal }) => {
        if (
          ["aiConversationId", "projectDraftId", "slackChannelName"].some(
            (key) => args[key] !== undefined && args[key] !== null,
          )
        )
          throw new DomainError("INVALID_INPUT", "Unsupported project create options");
        return payload(
          workspace.createProject(principal, input<ProjectInput>(args.input)),
          "project",
        );
      },
      projectUpdate: (_source, args, { principal }) =>
        payload(
          workspace.updateProject(principal, String(args.id), input<ProjectInput>(args.input)),
          "project",
        ),
      projectArchive: (_source, args, { principal }) =>
        workspace.archiveProject(principal, String(args.id), args.trash === true),
      projectUnarchive: (_source, args, { principal }) =>
        workspace.unarchiveProject(principal, String(args.id)),
      projectDelete: (_source, args, { principal }) =>
        workspace.deleteProject(principal, String(args.id)),
      commentCreate: (_source, args, { principal }) =>
        payload(workspace.createComment(principal, input<CommentInput>(args.input)), "comment"),
      issueLabelCreate: (_source, args, { principal }) =>
        payload(workspace.createLabel(principal, input<LabelInput>(args.input)), "issueLabel"),
    },
    Issue: {
      team: relationship("team", team),
      state: relationship("state", (context, id) => directory("workflowState", context, id)),
      parent: relationship("parent", issue),
      project: relationship("project", project),
      assignee: relationship("assignee", user),
      delegate: relationship("delegate", user),
      creator: relationship("creator", user),
      children: (source, args, { principal }) =>
        workspace.listIssues(principal, args, { parentId: entityId(source) }),
      comments: (source, args, { principal }) =>
        workspace.listComments(principal, args, entityId(source)),
      labels: (source, args, { principal }) =>
        workspace.listLabels(principal, args, entityId(source)),
    },
    Project: {
      status: relationship("status", (context, id) => directory("projectStatus", context, id)),
      creator: relationship("creator", user),
      lead: relationship("lead", user),
      issues: (source, args, { principal }) =>
        workspace.listIssues(principal, args, { projectId: entityId(source) }),
      teams: projectCollection("teams", "team"),
      members: projectCollection("members", "user"),
    },
    Comment: {
      issue: relationship("issue", issue),
      parent: relationship("parent", comment),
      user: relationship("user", user),
      children: (source, args, { principal }) =>
        workspace.listComments(principal, args, undefined, entityId(source)),
    },
    IssueLabel: { team: relationship("team", team) },
    Team: {
      issues: (source, args, { principal }) =>
        workspace.listIssues(principal, args, { teamId: entityId(source) }),
      projects: (source, args, { principal }) =>
        workspace.listProjects(principal, args, entityId(source)),
      labels: (source, args, { principal }) =>
        workspace.listLabels(principal, args, undefined, entityId(source)),
    },
    User: {
      assignedIssues: (source, args, { principal }) =>
        workspace.listIssues(principal, args, { assigneeId: entityId(source) }),
      delegatedIssues: (source, args, { principal }) =>
        workspace.listIssues(principal, args, { delegateId: entityId(source) }),
    },
  };
}

export const workspaceEntityRoots = [
  "issue",
  "issues",
  "project",
  "projects",
  "comment",
  "comments",
  "issueLabel",
  "issueLabels",
] as const;
export const workspaceEntityOperations = [
  "issue",
  "issues",
  "createIssue",
  "updateIssue",
  "archiveIssue",
  "unarchiveIssue",
  "deleteIssue",
  "issue_children",
  "issue_comments",
  "issue_labels",
  "project",
  "projects",
  "createProject",
  "updateProject",
  "archiveProject",
  "unarchiveProject",
  "deleteProject",
  "project_issues",
  "project_teams",
  "project_members",
  "team_issues",
  "team_projects",
  "viewer_assignedIssues",
  "viewer_delegatedIssues",
  "comment",
  "comments",
  "createComment",
  "comment_children",
  "issueLabel",
  "issueLabels",
  "createIssueLabel",
] as const;
export type WorkspaceListArguments = ListArgs;
