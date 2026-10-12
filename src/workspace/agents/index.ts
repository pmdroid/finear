import type { JsonObject, Transaction } from "../../core/database";
import { DomainError } from "../../core/errors";
import { requireOwningApp, type AppOwner, type Principal } from "../../core/principal";
import type { Runtime } from "../../core/runtime";
import { requireDelegate, requireMention, type Identity } from "../../identity";
import type { Workspace } from "../entities";
import { filterEntities } from "../filters";
import { paginate } from "../pagination";
import type { Entity, ListArgs } from "../types";
export { agentMigrations, agentsResetOwner } from "./schema";
export { agentsResolvers, agentsRoots, agentsOperations } from "./resolvers";

export type OnDelegated = (
  tx: Transaction,
  principal: Principal,
  issue: Entity,
  previousDelegateId: string | null,
  owner?: AppOwner,
) => { success: boolean; lastSyncId: number; entity: Entity } | null;
export type SessionInput = {
  issueId?: string;
  commentId?: string;
  externalUrls?: unknown;
  externalLink?: unknown;
};
export type ActivityInput = {
  agentSessionId: string;
  id?: string;
  content: unknown;
  ephemeral?: boolean | null;
  signal?: string | null;
  signalMetadata?: unknown;
};
export type SessionUpdate = {
  summary?: string | null;
  plan?: unknown;
  externalUrls?: unknown;
  addedExternalUrls?: unknown;
  removedExternalUrls?: unknown;
  externalLink?: unknown;
};
type Link = { label: string; url: string };
type SessionRow = {
  id: string;
  organization_id: string;
  issue_id: string;
  team_id: string;
  app_user_id: string;
  oauth_client_id: string;
  installation_id: string;
  creator_id: string | null;
  comment_id: string | null;
  source_comment_id: string | null;
  created_at: number;
  updated_at: number;
  acknowledged_at: number | null;
  last_activity_at: number;
  started_at: number | null;
  ended_at: number | null;
  phase: string;
  summary: string | null;
  plan: string | null;
  external_urls: string;
  external_link: string | null;
};
type ActivityRow = {
  id: string;
  organization_id: string;
  session_id: string;
  user_id: string;
  created_at: number;
  content: string;
  ephemeral: number;
  signal: string | null;
  signal_metadata: string | null;
  source_comment_id: string | null;
};
const ref = (id: string | null) => (id ? { id } : null);
function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected object");
  return value as Record<string, unknown>;
}
function keys(value: unknown, allowed: string[]) {
  for (const key of Object.keys(object(value)))
    if (!allowed.includes(key)) invalid(`Unsupported input ${key}`);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("Expected nonempty text");
  return value;
}
function url(value: unknown): string {
  const result = text(value);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    return invalid("Invalid external URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    invalid("Invalid external URL");
  return result;
}
function links(value: unknown): Link[] {
  if (!Array.isArray(value)) invalid("Expected external URL list");
  const result = new Map<string, Link>();
  for (const item of value) {
    keys(item, ["label", "url"]);
    const link = object(item);
    const entry = { label: text(link.label), url: url(link.url) };
    result.set(entry.url, entry);
  }
  return [...result.values()];
}
function snapshot(value: unknown): JsonObject {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) =>
      key.endsWith("At") && typeof item === "number" ? new Date(item).toISOString() : item,
    ),
  ) as JsonObject;
}
function content(value: unknown, human: boolean): Record<string, unknown> {
  const input = object(value);
  const type = String(input.type);
  if (
    !(human ? ["prompt"] : ["thought", "action", "elicitation", "response", "error"]).includes(type)
  )
    invalid("Invalid activity type");
  keys(
    input,
    type === "action"
      ? ["type", "action", "parameter", "result"]
      : type === "error"
        ? ["type", "body", "reasonCode"]
        : type === "prompt"
          ? ["type", "body", "title"]
          : ["type", "body"],
  );
  if (type === "action") {
    text(input.action);
    text(input.parameter);
    if (input.result !== undefined && input.result !== null && typeof input.result !== "string")
      invalid("Invalid action result");
  } else {
    text(input.body);
    for (const key of ["title", "reasonCode"])
      if (input[key] !== undefined && input[key] !== null && typeof input[key] !== "string")
        invalid(`Invalid ${key}`);
  }
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

export function createAgents(runtime: Runtime, workspace: Workspace, identity: Identity) {
  return new Agents(runtime, workspace, identity);
}

export class Agents {
  constructor(
    readonly runtime: Runtime,
    readonly workspace: Workspace,
    readonly identity: Identity,
  ) {}

  private guard(tx: Transaction, principal: Principal, issue: Entity, scope = "read") {
    this.identity.requireAccess(tx, principal, {
      organizationId: String(issue.organizationId),
      teamId: String(issue.teamId),
      scope,
    });
  }

  private row(tx: Transaction, principal: Principal, id: string, write = false): SessionRow {
    const row = tx
      .query<SessionRow>("SELECT * FROM agent_sessions WHERE id = ? AND organization_id = ?")
      .get(id, principal.organizationId);
    if (!row) throw new DomainError("NOT_FOUND", "Agent session not found");
    const issue = this.workspace.requireIssue(principal, row.issue_id, tx);
    row.team_id = String(issue.teamId);
    this.guard(tx, principal, issue, write ? "write" : "read");
    if (principal.actor === "app" || write) {
      requireOwningApp(principal, {
        organizationId: row.organization_id,
        appUserId: row.app_user_id,
        oauthClientId: row.oauth_client_id,
        installationId: row.installation_id,
      });
      this.identity.requireInstallation(tx, principal);
    }
    return row;
  }

  private status(row: SessionRow, now: number) {
    if (["complete", "error", "stopping"].includes(row.phase)) return row.phase;
    if (row.acknowledged_at === null && now - row.last_activity_at >= 10_000) return "stale";
    if (now - row.last_activity_at >= 1_800_000) return "stale";
    return row.phase;
  }

  private project(row: SessionRow, now: number): Entity {
    const externalUrls = JSON.parse(row.external_urls) as Link[];
    return {
      __typename: "AgentSession",
      id: row.id,
      organizationId: row.organization_id,
      teamId: row.team_id,
      issueId: row.issue_id,
      appUserId: row.app_user_id,
      oauthClientId: row.oauth_client_id,
      appUser: ref(row.app_user_id),
      issue: ref(row.issue_id),
      creator: ref(row.creator_id),
      comment: ref(row.comment_id),
      sourceComment: ref(row.source_comment_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: null,
      dismissedAt: null,
      dismissedBy: null,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: this.status(row, now),
      summary: row.summary,
      plan: row.plan === null ? null : JSON.parse(row.plan),
      context: [],
      externalUrls,
      externalLinks: externalUrls,
      externalLink: row.external_link,
      sourceMetadata: null,
      slugId: row.id.replaceAll("-", "").slice(0, 12),
      url: `https://linear.app/agent-session/${row.id}`,
      type: "commentThread",
      codingHarness: null,
      codingHarnessModelLabel: null,
      modelSelection: null,
      pullRequest: null,
      workspaceDiff: null,
    };
  }

  private activityProject(row: ActivityRow): Entity {
    const stored = JSON.parse(row.content) as Record<string, unknown>;
    const type = String(stored.type);
    const bodyData =
      type === "action"
        ? {}
        : {
            bodyData: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: stored.body }] }],
            },
          };
    return {
      __typename: "AgentActivity",
      id: row.id,
      agentSessionId: row.session_id,
      agentSession: ref(row.session_id),
      user: ref(row.user_id),
      createdAt: row.created_at,
      updatedAt: row.created_at,
      archivedAt: null,
      ephemeral: Boolean(row.ephemeral),
      signal: row.signal,
      signalMetadata: row.signal_metadata === null ? null : JSON.parse(row.signal_metadata),
      sourceMetadata: null,
      sourceComment: ref(row.source_comment_id),
      contextualMetadata: null,
      queued: false,
      sentAt: null,
      pushSummary: null,
      executionSkippedReason: null,
      content: {
        ...stored,
        ...bodyData,
        __typename: `AgentActivity${type[0]!.toUpperCase()}${type.slice(1)}Content`,
        ...(type === "action" ? { result: stored.result ?? null, resultData: null } : {}),
        ...(type === "error" ? { reasonCode: stored.reasonCode ?? null } : {}),
        ...(type === "prompt" ? { title: stored.title ?? null } : {}),
      },
    };
  }

  private emit(
    tx: Transaction,
    principal: Principal,
    row: SessionRow,
    action: string,
    activity?: Entity,
    authorizedIssue?: Entity,
  ) {
    const session = this.project(row, tx.now);
    const issue = authorizedIssue ?? this.workspace.requireIssue(principal, row.issue_id, tx);
    const user = (id: string | null) =>
      id
        ? tx
            .query<{ id: string; name: string; email: string; app: number }>(
              "SELECT id, name, email, app FROM users WHERE id = ?",
            )
            .get(id)
        : null;
    const agentSession = {
      id: row.id,
      organizationId: row.organization_id,
      appUserId: row.app_user_id,
      creatorId: row.creator_id,
      creator: user(row.creator_id),
      issueId: row.issue_id,
      issue: snapshot(issue),
      commentId: row.comment_id,
      comment: row.comment_id
        ? snapshot(this.workspace.requireComment(principal, row.comment_id, tx))
        : null,
      sourceCommentId: row.source_comment_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      archivedAt: null,
      status: session.status,
      summary: row.summary,
      type: "commentThread",
      url: session.url,
      sourceMetadata: null,
    };
    const data: JsonObject = { agentSession: snapshot(agentSession) };
    if (activity) {
      const stored = tx
        .query<ActivityRow>("SELECT * FROM agent_activities WHERE id = ?")
        .get(activity.id)!;
      data.agentActivity = snapshot({
        id: stored.id,
        agentSessionId: stored.session_id,
        userId: stored.user_id,
        user: user(stored.user_id),
        createdAt: stored.created_at,
        updatedAt: stored.created_at,
        archivedAt: null,
        content: JSON.parse(stored.content),
        signal: stored.signal,
        signalMetadata: stored.signal_metadata ? JSON.parse(stored.signal_metadata) : null,
        sourceCommentId: stored.source_comment_id,
      });
    }
    if (action === "created") {
      data.promptContext = String(issue.description ?? issue.title);
      if (row.source_comment_id && row.source_comment_id !== row.comment_id)
        data.previousComments = tx
          .query<{ id: string }>(
            "SELECT id FROM comments WHERE issue_id = ? AND (id = ? OR parent_id = ?) AND id <> ? ORDER BY created_at, id",
          )
          .all(row.issue_id, row.comment_id, row.comment_id, row.source_comment_id)
          .map(({ id }) => snapshot(this.workspace.requireComment(principal, id, tx)));
    }
    tx.appendEvent({
      organizationId: row.organization_id,
      teamId: row.team_id,
      resourceType: "AgentSessionEvent",
      action,
      actorId: principal.userId,
      occurredAt: tx.now,
      targetAppUserId: row.app_user_id,
      oauthClientId: row.oauth_client_id,
      data,
    });
  }

  private create(
    tx: Transaction,
    principal: Principal,
    owner: AppOwner,
    issue: Entity,
    input: SessionInput,
    comment?: Entity,
    sourceComment?: Entity,
  ) {
    if (comment?.parentId) invalid("Agent session requires a root comment");
    const externalUrls = input.externalUrls === undefined ? [] : links(input.externalUrls);
    const externalLink = input.externalLink === undefined ? null : url(input.externalLink);
    const id = crypto.randomUUID();
    tx.run(
      "INSERT INTO agent_sessions(id, organization_id, issue_id, team_id, app_user_id, oauth_client_id, installation_id, creator_id, comment_id, source_comment_id, created_at, updated_at, acknowledged_at, last_activity_at, started_at, phase, external_urls, external_link) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      principal.organizationId,
      issue.id,
      String(issue.teamId),
      owner.appUserId,
      owner.oauthClientId,
      owner.installationId,
      principal.actor === "app" ? null : principal.userId,
      comment?.id ?? null,
      sourceComment?.id ?? comment?.id ?? null,
      tx.now,
      tx.now,
      externalUrls.length || externalLink ? tx.now : null,
      tx.now,
      externalUrls.length || externalLink ? tx.now : null,
      externalUrls.length || externalLink ? "active" : "pending",
      JSON.stringify(externalUrls),
      externalLink,
    );
    const row = tx.query<SessionRow>("SELECT * FROM agent_sessions WHERE id = ?").get(id)!;
    this.emit(tx, principal, row, "created", undefined, issue);
    return { success: true, lastSyncId: tx.syncId, entity: this.project(row, tx.now) };
  }

  createOnIssue(principal: Principal, input: SessionInput) {
    keys(input, ["issueId", "externalUrls", "externalLink"]);
    return this.runtime.database.transaction((tx) => {
      const issue = this.workspace.requireIssue(principal, text(input.issueId), tx);
      this.guard(tx, principal, issue, "write");
      return this.create(
        tx,
        principal,
        this.identity.requireInstallation(tx, principal),
        issue,
        input,
      );
    });
  }

  createOnComment(principal: Principal, input: SessionInput) {
    keys(input, ["commentId", "externalUrls", "externalLink"]);
    return this.runtime.database.transaction((tx) => {
      const comment = this.workspace.requireComment(principal, text(input.commentId), tx);
      const issue = this.workspace.requireIssue(principal, String(comment.issueId), tx);
      this.guard(tx, principal, issue, "write");
      return this.create(
        tx,
        principal,
        this.identity.requireInstallation(tx, principal),
        issue,
        input,
        comment,
      );
    });
  }

  requireSession(principal: Principal, id: string) {
    return this.runtime.database.transaction((tx) =>
      this.project(this.row(tx, principal, id), tx.now),
    );
  }

  sessionForComment(principal: Principal, id: string) {
    return this.runtime.database.transaction((tx) => {
      const comment = this.workspace.requireComment(principal, id, tx);
      const issue = this.workspace.requireIssue(principal, String(comment.issueId), tx);
      this.guard(tx, principal, issue);
      const row = tx
        .query<SessionRow>(
          "SELECT * FROM agent_sessions WHERE organization_id = ? AND (comment_id = ? OR comment_id = ?) AND (? <> 'app' OR app_user_id = ?) ORDER BY created_at DESC, id LIMIT 1",
        )
        .get(
          principal.organizationId,
          id,
          comment.parentId as string | null,
          principal.actor,
          principal.userId,
        );
      return row ? this.project(this.row(tx, principal, row.id), tx.now) : null;
    });
  }

  requireActivity(principal: Principal, id: string) {
    return this.runtime.database.transaction((tx) => {
      const activity = tx
        .query<ActivityRow>("SELECT * FROM agent_activities WHERE id = ? AND organization_id = ?")
        .get(id, principal.organizationId);
      if (!activity) throw new DomainError("NOT_FOUND", "Agent activity not found");
      this.row(tx, principal, activity.session_id);
      return this.activityProject(activity);
    });
  }

  listSessions(principal: Principal, args: ListArgs = {}, issueId?: string) {
    return this.runtime.database.transaction((tx) => {
      if (issueId) this.guard(tx, principal, this.workspace.requireIssue(principal, issueId, tx));
      this.identity.requireAccess(tx, principal, {
        organizationId: principal.organizationId,
        scope: "read",
      });
      const result: Entity[] = [];
      for (const row of tx
        .query<SessionRow>(
          "SELECT s.*, i.team_id AS team_id FROM agent_sessions s JOIN issues i ON i.id = s.issue_id WHERE s.organization_id = ?",
        )
        .all(principal.organizationId)) {
        if (issueId && row.issue_id !== issueId) continue;
        if (
          !principal.teamIds.includes(row.team_id) ||
          (principal.actor === "app" && row.app_user_id !== principal.userId)
        )
          continue;
        this.row(tx, principal, row.id);
        result.push(this.project(row, tx.now));
      }
      return paginate(
        filterEntities(result, args.filter, tx.now),
        args,
        `agentSessions:${principal.organizationId}`,
      );
    });
  }

  listActivities(principal: Principal, args: ListArgs = {}, sessionId?: string) {
    return this.runtime.database.transaction((tx) => {
      if (sessionId) this.row(tx, principal, sessionId);
      this.identity.requireAccess(tx, principal, {
        organizationId: principal.organizationId,
        scope: "read",
      });
      const result: Entity[] = [];
      const rows = tx
        .query<ActivityRow & { app_user_id: string; team_id: string }>(
          "SELECT a.*, s.app_user_id, i.team_id FROM agent_activities a JOIN agent_sessions s ON s.id = a.session_id JOIN issues i ON i.id = s.issue_id WHERE a.organization_id = ?",
        )
        .all(principal.organizationId);
      for (const row of rows) {
        if (sessionId && row.session_id !== sessionId) continue;
        if (
          !principal.teamIds.includes(row.team_id) ||
          (principal.actor === "app" && row.app_user_id !== principal.userId)
        )
          continue;
        this.row(tx, principal, row.session_id);
        result.push(this.activityProject(row));
      }
      const translate = (filter: unknown): unknown => {
        if (filter === undefined || filter === null) return filter;
        const input = object(filter);
        return Object.fromEntries(
          Object.entries(input).map(([key, value]) =>
            key === "agentSessionId"
              ? ["parent", { id: value }]
              : [
                  key,
                  ["and", "or"].includes(key) && Array.isArray(value)
                    ? value.map(translate)
                    : value,
                ],
          ),
        );
      };
      const projected = result.map((entity) => ({
        ...entity,
        parent: { id: entity.agentSessionId },
        type: (entity.content as Record<string, unknown>).type,
      }));
      return paginate(
        filterEntities(projected, translate(args.filter), tx.now),
        args,
        `agentActivities:${principal.organizationId}:${sessionId ?? "all"}`,
      );
    });
  }

  private append(
    tx: Transaction,
    principal: Principal,
    row: SessionRow,
    input: ActivityInput,
    human = false,
    sourceCommentId: string | null = null,
  ) {
    keys(input, ["agentSessionId", "id", "content", "ephemeral", "signal", "signalMetadata"]);
    const stored = content(input.content, human);
    const type = String(stored.type);
    if (
      input.ephemeral !== undefined &&
      input.ephemeral !== null &&
      typeof input.ephemeral !== "boolean"
    )
      invalid("Invalid ephemeral flag");
    if (input.ephemeral && !["thought", "action"].includes(type))
      invalid("Only thoughts and actions can be ephemeral");
    if (input.signal != null && !["auth", "select", "continue", "stop"].includes(input.signal))
      invalid("Invalid activity signal");
    if (input.signal === "stop" && !human) invalid("Stop is human-generated");
    if (input.signalMetadata != null) object(input.signalMetadata);
    if (!human && row.phase === "stopping" && !["response", "error"].includes(type))
      invalid("Stopping sessions require a final response or error");
    if (!human && ["complete", "error"].includes(row.phase))
      invalid("Terminal sessions require a human prompt to reopen");
    const id = input.id ?? crypto.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      invalid("Expected UUID v4");
    if (tx.query("SELECT 1 FROM agent_activities WHERE id = ?").get(id))
      throw new DomainError("CONFLICT", "Agent activity ID already exists");
    let commentId = row.comment_id;
    if (["elicitation", "response", "error"].includes(type)) {
      const comment = this.workspace.createComment(
        principal,
        { issueId: row.issue_id, parentId: commentId, body: String(stored.body) },
        tx,
      ).entity;
      if (!commentId) commentId = comment.id;
    }
    tx.run(
      "INSERT INTO agent_activities(id, organization_id, session_id, user_id, created_at, content, ephemeral, signal, signal_metadata, source_comment_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      row.organization_id,
      row.id,
      principal.userId,
      tx.now,
      JSON.stringify(stored),
      input.ephemeral ? 1 : 0,
      input.signal ?? null,
      input.signalMetadata == null ? null : JSON.stringify(input.signalMetadata),
      sourceCommentId,
    );
    const phase =
      input.signal === "stop"
        ? "stopping"
        : type === "elicitation"
          ? "awaitingInput"
          : type === "response"
            ? "complete"
            : type === "error"
              ? "error"
              : human
                ? "pending"
                : "active";
    tx.run(
      "UPDATE agent_sessions SET updated_at = ?, last_activity_at = ?, acknowledged_at = ?, started_at = ?, ended_at = ?, phase = ?, comment_id = ? WHERE id = ?",
      tx.now,
      tx.now,
      human ? null : (row.acknowledged_at ?? tx.now),
      human ? row.started_at : (row.started_at ?? tx.now),
      ["complete", "error"].includes(phase) ? tx.now : null,
      phase,
      commentId,
      row.id,
    );
    const activity = this.activityProject(
      tx.query<ActivityRow>("SELECT * FROM agent_activities WHERE id = ?").get(id)!,
    );
    if (human)
      this.emit(
        tx,
        principal,
        tx.query<SessionRow>("SELECT * FROM agent_sessions WHERE id = ?").get(row.id)!,
        "prompted",
        activity,
      );
    return { success: true, lastSyncId: tx.syncId, entity: activity };
  }

  createActivity(principal: Principal, input: ActivityInput) {
    return this.runtime.database.transaction((tx) =>
      this.append(tx, principal, this.row(tx, principal, text(input.agentSessionId), true), input),
    );
  }

  updateSession(principal: Principal, id: string, input: SessionUpdate) {
    keys(input, [
      "summary",
      "plan",
      "externalUrls",
      "addedExternalUrls",
      "removedExternalUrls",
      "externalLink",
    ]);
    return this.runtime.database.transaction((tx) => {
      const row = this.row(tx, principal, id, true);
      let plan = row.plan;
      if (input.plan !== undefined) {
        if (
          input.plan !== null &&
          (!Array.isArray(input.plan) ||
            input.plan.some((step) => {
              keys(step, ["content", "status"]);
              return (
                typeof step.content !== "string" ||
                !step.content.trim() ||
                !["pending", "inProgress", "completed", "canceled"].includes(step.status)
              );
            }))
        )
          invalid("Plan must be an array of content/status steps");
        plan = input.plan === null ? null : JSON.stringify(input.plan);
      }
      const summary = input.summary === undefined ? row.summary : input.summary;
      if (
        summary !== null &&
        (typeof summary !== "string" ||
          !summary.trim() ||
          summary.length > 255 ||
          /[\r\n\0]/.test(summary))
      )
        invalid("Invalid session summary");
      let externalUrls: Link[] = JSON.parse(row.external_urls);
      if (input.externalUrls !== undefined) externalUrls = links(input.externalUrls);
      else {
        if (input.removedExternalUrls !== undefined) {
          if (
            !Array.isArray(input.removedExternalUrls) ||
            input.removedExternalUrls.some((entry) => typeof entry !== "string")
          )
            invalid("Expected removed URL list");
          externalUrls = externalUrls.filter(
            (entry) => !(input.removedExternalUrls as string[]).includes(entry.url),
          );
        }
        if (input.addedExternalUrls !== undefined)
          externalUrls = links([...externalUrls, ...links(input.addedExternalUrls)]);
      }
      const externalLink =
        input.externalLink === undefined
          ? row.external_link
          : input.externalLink === null
            ? null
            : url(input.externalLink);
      const acknowledge =
        (input.externalUrls !== undefined ||
          input.addedExternalUrls !== undefined ||
          input.externalLink !== undefined) &&
        Boolean(externalUrls.length || externalLink);
      const phase = acknowledge && row.phase === "pending" ? "active" : row.phase;
      tx.run(
        "UPDATE agent_sessions SET updated_at = ?, summary = ?, plan = ?, external_urls = ?, external_link = ?, acknowledged_at = ?, last_activity_at = ?, started_at = ?, phase = ? WHERE id = ?",
        tx.now,
        summary,
        plan,
        JSON.stringify(externalUrls),
        externalLink,
        acknowledge ? (row.acknowledged_at ?? tx.now) : row.acknowledged_at,
        acknowledge ? tx.now : row.last_activity_at,
        acknowledge ? (row.started_at ?? tx.now) : row.started_at,
        phase,
        id,
      );
      return {
        success: true,
        lastSyncId: tx.syncId,
        entity: this.project(
          tx.query<SessionRow>("SELECT * FROM agent_sessions WHERE id = ?").get(id)!,
          tx.now,
        ),
      };
    });
  }

  private human(principal: Principal) {
    if (principal.actor === "app") throw new DomainError("FORBIDDEN", "Human action required");
  }

  prompt(principal: Principal, id: string, body: string, signal?: string) {
    this.human(principal);
    return this.runtime.database.transaction((tx) => {
      const row = this.row(tx, principal, id);
      this.guard(tx, principal, this.workspace.requireIssue(principal, row.issue_id, tx), "write");
      const comment = this.workspace.createComment(
        principal,
        { issueId: row.issue_id, parentId: row.comment_id, body },
        tx,
      ).entity;
      if (!row.comment_id) {
        tx.run("UPDATE agent_sessions SET comment_id = ? WHERE id = ?", comment.id, row.id);
        row.comment_id = comment.id;
      }
      return this.append(
        tx,
        principal,
        row,
        { agentSessionId: id, content: { type: "prompt", body }, signal },
        true,
        comment.id,
      );
    });
  }

  stop(principal: Principal, id: string, body = "Stop") {
    return this.prompt(principal, id, body, "stop");
  }

  onDelegated(
    tx: Transaction,
    principal: Principal,
    issue: Entity,
    previousDelegateId: string | null,
    validatedOwner?: AppOwner,
  ) {
    if (!issue.delegateId || issue.delegateId === previousDelegateId) return null;
    const owner =
      validatedOwner ??
      requireDelegate(tx, {
        organizationId: principal.organizationId,
        teamId: String(issue.teamId),
        appUserId: String(issue.delegateId),
      });
    if (owner.organizationId !== issue.organizationId || owner.appUserId !== issue.delegateId)
      throw new DomainError("FORBIDDEN", "Delegation owner mismatch");
    const existing = tx
      .query<SessionRow>(
        "SELECT * FROM agent_sessions WHERE issue_id = ? AND app_user_id = ? AND phase NOT IN ('complete','error') ORDER BY created_at DESC, id LIMIT 1",
      )
      .get(issue.id, owner.appUserId);
    if (existing)
      return { success: true, lastSyncId: tx.syncId, entity: this.project(existing, tx.now) };
    return this.create(tx, principal, owner, issue, {});
  }

  delegate(principal: Principal, issueId: string, appUserId: string) {
    this.human(principal);
    return this.runtime.database.transaction((tx) => {
      const before = this.workspace.requireIssue(principal, issueId, tx);
      this.guard(tx, principal, before, "write");
      const issue = this.workspace.setDelegate(principal, issueId, appUserId, tx).entity;
      return this.onDelegated(tx, principal, issue, before.delegateId as string | null);
    });
  }

  mention(principal: Principal, issueId: string, appUserId: string, commentId?: string) {
    this.human(principal);
    return this.runtime.database.transaction((tx) => {
      const issue = this.workspace.requireIssue(principal, issueId, tx);
      const comment = commentId
        ? this.workspace.requireComment(principal, commentId, tx)
        : undefined;
      if (comment && comment.issueId !== issue.id) invalid("Comment belongs to another issue");
      this.guard(tx, principal, issue, "write");
      let root = comment;
      while (root?.parentId)
        root = this.workspace.requireComment(principal, String(root.parentId), tx);
      return this.create(
        tx,
        principal,
        requireMention(tx, {
          organizationId: principal.organizationId,
          teamId: String(issue.teamId),
          appUserId,
        }),
        issue,
        {},
        root,
        comment,
      );
    });
  }
}
