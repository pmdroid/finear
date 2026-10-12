import type { JsonObject, ReadDatabase, Transaction } from "../core/database";
import { DomainError } from "../core/errors";
import { requireOrganization, requireScope, requireTeam, type Principal } from "../core/principal";
import type { Runtime } from "../core/runtime";
import { filterEntities } from "./filters";
import { paginate } from "./pagination";
import type {
  CommentInput,
  CommentRow,
  Entity,
  EntityRow,
  IssueInput,
  IssueRelationInput,
  IssueRelationRow,
  IssueRow,
  LabelInput,
  ListArgs,
  MutationResult,
  ProjectInput,
  ProjectRow,
  WorkspaceOptions,
} from "./types";

const priorityLabels = ["No priority", "Urgent", "High", "Medium", "Low"];
const issueKeys = [
  "id",
  "teamId",
  "title",
  "description",
  "stateId",
  "projectId",
  "parentId",
  "assigneeId",
  "delegateId",
  "labelIds",
  "addedLabelIds",
  "removedLabelIds",
  "priority",
  "estimate",
  "dueDate",
  "boardOrder",
  "sortOrder",
  "prioritySortOrder",
  "subIssueSortOrder",
];
const projectKeys = [
  "id",
  "name",
  "teamIds",
  "statusId",
  "leadId",
  "memberIds",
  "description",
  "content",
  "color",
  "icon",
  "priority",
  "sortOrder",
  "prioritySortOrder",
  "startDate",
  "targetDate",
];
function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be nonempty text`);
  return value;
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    invalid("Expected UUID");
  return value;
}
function keys(input: object, allowed: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Expected input object");
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) invalid(`Unsupported input ${key}`);
}
function list(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    invalid(`${field} must be an ID list`);
  return [...new Set(value)] as string[];
}
function data(row: EntityRow): Record<string, unknown> {
  return JSON.parse(row.data) as Record<string, unknown>;
}
function ref(id: string | null): Entity | null {
  return id ? { id } : null;
}
function snapshot(entity: Entity): JsonObject {
  return JSON.parse(
    JSON.stringify(entity, (key, value: unknown) =>
      key.endsWith("At") && typeof value === "number" ? new Date(value).toISOString() : value,
    ),
  ) as JsonObject;
}
function dates(input: Record<string, unknown>) {
  for (const field of ["teamId", "stateId", "statusId"])
    if (input[field] !== undefined) uuid(input[field]);
  for (const field of ["parentId", "projectId", "assigneeId", "delegateId", "leadId"])
    if (input[field] !== undefined && input[field] !== null) uuid(input[field]);
  for (const field of [
    "priority",
    "boardOrder",
    "sortOrder",
    "prioritySortOrder",
    "description",
    "color",
  ])
    if (input[field] === null && field !== "description") invalid(`Invalid ${field}`);
  for (const field of ["dueDate", "startDate", "targetDate"]) {
    const value = input[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      invalid(`Invalid ${field}`);
  }
  for (const field of ["description", "content", "color", "icon"])
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "string")
      invalid(`Invalid ${field}`);
  if (
    input.priority !== undefined &&
    (!Number.isInteger(input.priority) || Number(input.priority) < 0 || Number(input.priority) > 4)
  )
    invalid("Invalid priority");
  if (
    input.estimate !== undefined &&
    input.estimate !== null &&
    (!Number.isInteger(input.estimate) || Number(input.estimate) < 0)
  )
    invalid("Invalid estimate");
  for (const field of ["sortOrder", "prioritySortOrder", "boardOrder", "subIssueSortOrder"])
    if (
      input[field] !== undefined &&
      input[field] !== null &&
      (typeof input[field] !== "number" || !Number.isFinite(input[field]))
    )
      invalid(`Invalid ${field}`);
}

export class Workspace {
  private readonly writeScopes = new WeakMap<Transaction, string>();
  constructor(
    readonly runtime: Runtime,
    readonly options: WorkspaceOptions = {},
  ) {}

  private write<T>(
    principal: Principal,
    scope: string,
    work: (tx: Transaction) => T,
    transaction?: Transaction,
  ): T {
    const guarded = (tx: Transaction) => {
      requireScope(principal, scope);
      this.options.requireAccess?.(tx, principal, {
        organizationId: principal.organizationId,
        scope,
      });
      const previous = this.writeScopes.get(tx);
      this.writeScopes.set(tx, scope);
      try {
        return work(tx);
      } finally {
        if (previous) this.writeScopes.set(tx, previous);
        else this.writeScopes.delete(tx);
      }
    };
    return transaction ? guarded(transaction) : this.runtime.database.transaction(guarded);
  }

  private delegated(
    tx: Transaction,
    principal: Principal,
    issue: Entity,
    previousDelegateId: string | null,
    owner?: import("../core/principal").AppOwner,
  ) {
    const result: unknown = this.options.onDelegated?.(
      tx,
      principal,
      issue,
      previousDelegateId,
      owner,
    );
    if (result && typeof (result as { then?: unknown }).then === "function")
      invalid("Delegation callback must be synchronous");
  }

  private team(principal: Principal, id: string, db: ReadDatabase) {
    const team = db
      .query<{ id: string; organization_id: string; key: string; settings: string }>(
        "SELECT * FROM teams WHERE organization_id = ? AND id = ?",
      )
      .get(principal.organizationId, id);
    if (!team) throw new DomainError("NOT_FOUND", "Team not found");
    requireTeam(principal, { id: team.id, organizationId: team.organization_id });
    if ("run" in db)
      this.options.requireAccess?.(db as Transaction, principal, {
        organizationId: principal.organizationId,
        teamId: team.id,
        scope: this.writeScopes.get(db as Transaction),
      });
    return team;
  }

  private user(principal: Principal, id: string, db: ReadDatabase, app?: boolean) {
    const user = db
      .query<{ id: string; organization_id: string; app: number; name: string }>(
        "SELECT * FROM users WHERE organization_id = ? AND id = ?",
      )
      .get(principal.organizationId, id);
    if (!user) throw new DomainError("NOT_FOUND", "User not found");
    requireOrganization(principal, user.organization_id);
    if (app !== undefined && Boolean(user.app) !== app)
      invalid(app ? "Delegate must be an app user" : "Assignee must be a human user");
    return user;
  }

  private issueRow(principal: Principal, id: string, db: ReadDatabase): IssueRow {
    const row = db
      .query<IssueRow>(
        "SELECT * FROM issues WHERE organization_id = ? AND (id = ? OR identifier = ? OR EXISTS (SELECT 1 FROM json_each(issues.data, '$.previousIdentifiers') WHERE value = ?))",
      )
      .get(principal.organizationId, id, id, id);
    if (
      !row ||
      !principal.teamIds.includes(row.team_id) ||
      (row.project_id && !this.projectVisible(principal, row.project_id, db))
    )
      throw new DomainError("NOT_FOUND", "Issue not found");
    requireOrganization(principal, row.organization_id);
    this.team(principal, row.team_id, db);
    if (row.project_id) this.projectRow(principal, row.project_id, db);
    return row;
  }

  private projectRow(principal: Principal, id: string, db: ReadDatabase): ProjectRow {
    const row = db
      .query<ProjectRow>("SELECT * FROM projects WHERE organization_id = ? AND id = ?")
      .get(principal.organizationId, id);
    if (!row || !this.projectVisible(principal, row.id, db))
      throw new DomainError("NOT_FOUND", "Project not found");
    requireOrganization(principal, row.organization_id);
    const teams = db
      .query<{ team_id: string }>("SELECT team_id FROM project_teams WHERE project_id = ?")
      .all(row.id);
    for (const team of teams) this.team(principal, team.team_id, db);
    return row;
  }

  private state(
    principal: Principal,
    teamId: string,
    stateId: string | undefined,
    db: ReadDatabase,
  ) {
    const team = this.team(principal, teamId, db);
    const triage = Boolean((JSON.parse(team.settings) as Record<string, unknown>).triageEnabled);
    const state =
      stateId === undefined
        ? db
            .query<{ id: string; type: string; name: string }>(
              "SELECT * FROM workflow_states WHERE organization_id = ? AND team_id = ? AND type = ? ORDER BY position, id LIMIT 1",
            )
            .get(principal.organizationId, teamId, triage ? "triage" : "backlog")
        : db
            .query<{ id: string; type: string; name: string }>(
              "SELECT * FROM workflow_states WHERE organization_id = ? AND team_id = ? AND id = ?",
            )
            .get(principal.organizationId, teamId, stateId);
    if (!state) invalid("Workflow state does not belong to the issue team");
    return state;
  }

  private status(principal: Principal, id: string | undefined, db: ReadDatabase) {
    const status =
      id === undefined
        ? db
            .query<{ id: string; type: string; name: string }>(
              "SELECT * FROM project_statuses WHERE organization_id = ? ORDER BY position, id LIMIT 1",
            )
            .get(principal.organizationId)
        : db
            .query<{ id: string; type: string; name: string }>(
              "SELECT * FROM project_statuses WHERE organization_id = ? AND id = ?",
            )
            .get(principal.organizationId, id);
    if (!status) invalid("Invalid project status");
    return status;
  }

  private nextNumber(tx: Transaction, principal: Principal, teamId: string): number {
    return tx
      .query<{ value: number }>(
        "INSERT INTO team_issue_numbers(organization_id, team_id, value) VALUES(?, ?, 1) ON CONFLICT(organization_id, team_id) DO UPDATE SET value = value + 1 RETURNING value",
      )
      .get(principal.organizationId, teamId)!.value;
  }

  private emit(
    tx: Transaction,
    principal: Principal,
    type: string,
    action: string,
    entity: Entity,
    before?: Entity,
  ) {
    const current = snapshot(entity);
    const previous: JsonObject = {};
    if (before) {
      const old = snapshot(before);
      for (const key of Object.keys(current))
        if (JSON.stringify(current[key]) !== JSON.stringify(old[key]))
          previous[key] = old[key] ?? null;
    }
    const actor = this.user(principal, principal.userId, tx);
    tx.appendEvent({
      organizationId: principal.organizationId,
      teamId: (entity.teamId as string | undefined) ?? null,
      resourceType: type,
      action,
      actorId: principal.userId,
      actor: { id: actor.id, name: actor.name, type: actor.app ? "app" : "user" },
      source: {
        url: String(entity.url),
        ...(type === "Project"
          ? { teamIds: (entity.teams as Entity[]).map((team) => team.id) }
          : {}),
      },
      occurredAt: tx.now,
      data: current,
      ...(before ? { updatedFrom: previous } : {}),
    });
  }

  private result<T extends Entity>(tx: Transaction, entity: T): MutationResult<T> {
    return { success: true, lastSyncId: tx.syncId, entity };
  }

  private issueProjection(row: IssueRow, db: ReadDatabase): Entity {
    const team = db.query<{ key: string }>("SELECT key FROM teams WHERE id = ?").get(row.team_id)!;
    const state = db
      .query<{ id: string; type: string; name: string }>(
        "SELECT * FROM workflow_states WHERE id = ?",
      )
      .get(row.state_id)!;
    const labelIds = db
      .query<{ label_id: string }>(
        "SELECT label_id FROM issue_label_memberships WHERE issue_id = ? ORDER BY label_id",
      )
      .all(row.id)
      .map((label) => label.label_id);
    const stored = data(row);
    return {
      ...stored,
      __typename: "Issue",
      id: row.id,
      organizationId: row.organization_id,
      teamId: row.team_id,
      stateId: row.state_id,
      projectId: row.project_id,
      parentId: row.parent_id,
      assigneeId: row.assignee_id,
      delegateId: row.delegate_id,
      creatorId: row.creator_id,
      title: row.title,
      number: row.number,
      identifier: row.identifier,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      url: `https://linear.app/issue/${row.identifier}`,
      branchName: `${row.identifier.toLowerCase()}-${row.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`,
      priorityLabel: priorityLabels[Number(stored.priority)],
      labelIds,
      labels: labelIds.map((id) =>
        db.query<Entity>("SELECT id, name, color FROM issue_labels WHERE id = ?").get(id)!,
      ),
      state: { id: state.id, type: state.type, name: state.name },
      team: { id: row.team_id, key: team.key },
      project: row.project_id
        ? {
            ...ref(row.project_id),
            name: db
              .query<{ name: string }>("SELECT name FROM projects WHERE id = ?")
              .get(row.project_id)!.name,
          }
        : null,
      parent: ref(row.parent_id),
      assignee: ref(row.assignee_id),
      delegate: ref(row.delegate_id),
      creator: ref(row.creator_id),
      sharedAccess: {
        __typename: "IssueSharedAccess",
        disallowedIssueFields: [],
        isShared: false,
        sharedWithCount: 0,
        sharedWithUsers: [],
        viewerHasOnlySharedAccess: false,
      },
      inheritsSharedAccess: false,
      reactions: [],
      reactionData: [],
      customerTicketCount: 0,
      syncedWith: [],
      integrationSourceType: null,
      botActor: null,
      sourceComment: null,
      cycle: null,
      externalUserCreator: null,
      asksExternalUserRequester: null,
      asksRequester: null,
      lastAppliedTemplate: null,
      projectMilestone: null,
      recurringIssueTemplate: null,
      favorite: null,
      snoozedBy: null,
    };
  }

  private metrics(projectId: string, db: ReadDatabase) {
    const rows = db
      .query<IssueRow & { state_type: string }>(
        "SELECT issues.*, workflow_states.type AS state_type FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id WHERE issues.project_id = ? AND issues.archived_at IS NULL",
      )
      .all(projectId);
    const scope = rows.reduce((sum, row) => sum + Number(data(row).estimate ?? 1), 0);
    const completed = rows.filter((row) => row.state_type === "completed");
    const started = rows.filter((row) => row.state_type === "started");
    const completedScope = completed.reduce((sum, row) => sum + Number(data(row).estimate ?? 1), 0);
    const inProgressScope = started.reduce((sum, row) => sum + Number(data(row).estimate ?? 1), 0);
    return {
      issueCount: rows.length,
      scope,
      completedIssueCount: completed.length,
      completedScope,
      inProgressScope,
      progress: scope ? (completedScope + 0.25 * inProgressScope) / scope : 0,
    };
  }

  private recordMetrics(tx: Transaction, projectId: string | null) {
    if (!projectId) return;
    const row = tx.query<ProjectRow>("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!row) return;
    tx.run(
      "INSERT INTO project_metric_history(organization_id, project_id, recorded_at, data) VALUES(?, ?, ?, ?) ON CONFLICT(project_id, recorded_at) DO UPDATE SET data = excluded.data",
      row.organization_id,
      projectId,
      tx.now,
      JSON.stringify(this.metrics(projectId, tx)),
    );
  }

  private projectProjection(row: ProjectRow, db: ReadDatabase): Entity {
    const stored = data(row);
    const status = db
      .query<{ id: string; type: string; name: string }>(
        "SELECT * FROM project_statuses WHERE id = ?",
      )
      .get(row.status_id)!;
    const metrics = this.metrics(row.id, db);
    const history = db
      .query<{ recorded_at: number; data: string }>(
        "SELECT * FROM project_metric_history WHERE project_id = ? ORDER BY recorded_at",
      )
      .all(row.id);
    const weeks: Record<string, number>[] = [];
    for (let end = row.created_at + 604800000; end <= this.runtime.clock.now(); end += 604800000) {
      const sample = history.findLast((entry) => entry.recorded_at <= end);
      weeks.push(
        sample
          ? (JSON.parse(sample.data) as Record<string, number>)
          : {
              issueCount: 0,
              scope: 0,
              completedIssueCount: 0,
              completedScope: 0,
              inProgressScope: 0,
            },
      );
    }
    return {
      ...stored,
      ...metrics,
      __typename: "Project",
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      statusId: row.status_id,
      leadId: row.lead_id,
      creatorId: row.creator_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      status: { id: status.id, type: status.type, name: status.name },
      state: status.type,
      lead: ref(row.lead_id),
      creator: ref(row.creator_id),
      teams: db
        .query<Entity>(
          "SELECT teams.id, teams.key, teams.name FROM teams JOIN project_teams ON project_teams.team_id = teams.id WHERE project_teams.project_id = ? ORDER BY teams.id",
        )
        .all(row.id),
      members: db
        .query<Entity>(
          "SELECT users.id, users.name FROM users JOIN project_members ON project_members.user_id = users.id WHERE project_members.project_id = ? ORDER BY users.id",
        )
        .all(row.id),
      url: `https://linear.app/project/${stored.slugId}`,
      priorityLabel: priorityLabels[Number(stored.priority)],
      resourceCount: 0,
      frequencyResolution: "weekly",
      labelIds: [],
      completedIssueCountHistory: weeks.map((week) => week.completedIssueCount),
      completedScopeHistory: weeks.map((week) => week.completedScope),
      inProgressScopeHistory: weeks.map((week) => week.inProgressScope),
      issueCountHistory: weeks.map((week) => week.issueCount),
      scopeHistory: weeks.map((week) => week.scope),
      slackIssueComments: false,
      slackIssueStatuses: false,
      slackNewIssue: false,
      integrationsSettings: null,
      microsoftTeamsChannelId: null,
      slackChannelId: null,
      documentContent: null,
      updateRemindersDay: null,
      updateReminderFrequency: null,
      updateRemindersHour: null,
      convertedFromIssue: null,
      lastAppliedTemplate: null,
      lastUpdate: null,
      updateReminderFrequencyInWeeks: null,
      health: null,
      targetDateResolution: null,
      startDateResolution: null,
      healthUpdatedAt: null,
      autoArchivedAt: null,
      projectUpdateRemindersPausedUntilAt: null,
      favorite: null,
      syncedWith: [],
    };
  }

  requireIssue(principal: Principal, id: string, tx?: Transaction): Entity {
    requireScope(principal, "read");
    const db = tx ?? this.runtime.database;
    return this.issueProjection(this.issueRow(principal, id, db), db);
  }

  requireProject(principal: Principal, id: string, tx?: Transaction): Entity {
    requireScope(principal, "read");
    const db = tx ?? this.runtime.database;
    return this.projectProjection(this.projectRow(principal, id, db), db);
  }

  private relationRow(principal: Principal, id: string, db: ReadDatabase): IssueRelationRow {
    const row = db
      .query<IssueRelationRow>("SELECT * FROM issue_relations WHERE organization_id = ? AND id = ?")
      .get(principal.organizationId, id);
    if (!row) throw new DomainError("NOT_FOUND", "Relation not found");
    this.issueRow(principal, row.issue_id, db);
    this.issueRow(principal, row.related_issue_id, db);
    return row;
  }

  private relationProjection(row: IssueRelationRow): Entity {
    return {
      id: row.id,
      type: row.type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: null,
      issue: { id: row.issue_id },
      relatedIssue: { id: row.related_issue_id },
    };
  }

  requireIssueRelation(principal: Principal, id: string): Entity {
    requireScope(principal, "read");
    return this.relationProjection(this.relationRow(principal, id, this.runtime.database));
  }

  listIssueRelations(principal: Principal, args: ListArgs = {}, issueId?: string, inverse = false) {
    requireScope(principal, "read");
    const db = this.runtime.database;
    const issue = issueId ? this.issueRow(principal, issueId, db) : undefined;
    const rows = db
      .query<IssueRelationRow>("SELECT * FROM issue_relations WHERE organization_id = ?")
      .all(principal.organizationId)
      .filter((row) => !issue || (inverse ? row.related_issue_id : row.issue_id) === issue.id)
      .filter((row) =>
        db
          .query<IssueRow>("SELECT * FROM issues WHERE id IN (?, ?)")
          .all(row.issue_id, row.related_issue_id)
          .every(
            (endpoint) =>
              principal.teamIds.includes(endpoint.team_id) &&
              (!endpoint.project_id || this.projectVisible(principal, endpoint.project_id, db)),
          ),
      );
    return this.connection(
      rows.map((row) => this.relationProjection(row)),
      args,
      `relations:${principal.organizationId}:${issue?.id ?? "all"}:${inverse}`,
    );
  }

  createIssueRelation(principal: Principal, input: IssueRelationInput, createdAt?: number) {
    keys(input, ["id", "issueId", "relatedIssueId", "type"]);
    return this.write(principal, "write", (tx) => {
      const issue = this.issueRow(principal, text(input.issueId, "issueId"), tx);
      const related = this.issueRow(principal, text(input.relatedIssueId, "relatedIssueId"), tx);
      const type = text(input.type, "type");
      if (!["blocks", "duplicate", "related", "similar"].includes(type))
        invalid("Invalid relation type");
      const id = input.id === undefined ? crypto.randomUUID() : uuid(input.id);
      if (tx.query("SELECT id FROM issue_relations WHERE id = ?").get(id))
        throw new DomainError("CONFLICT", "Relation ID already exists");
      tx.run(
        "INSERT INTO issue_relations(id, organization_id, issue_id, related_issue_id, type, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
        id,
        principal.organizationId,
        issue.id,
        related.id,
        type,
        createdAt ?? tx.now,
        tx.now,
      );
      return this.result(tx, this.relationProjection(this.relationRow(principal, id, tx)));
    });
  }

  updateIssueRelation(principal: Principal, id: string, input: IssueRelationInput) {
    keys(input, ["issueId", "relatedIssueId", "type"]);
    return this.write(principal, "write", (tx) => {
      const row = this.relationRow(principal, id, tx);
      const issue = this.issueRow(
        principal,
        input.issueId === undefined ? row.issue_id : text(input.issueId, "issueId"),
        tx,
      );
      const related = this.issueRow(
        principal,
        input.relatedIssueId === undefined
          ? row.related_issue_id
          : text(input.relatedIssueId, "relatedIssueId"),
        tx,
      );
      const type = input.type === undefined ? row.type : text(input.type, "type");
      tx.run(
        "UPDATE issue_relations SET issue_id = ?, related_issue_id = ?, type = ?, updated_at = ? WHERE id = ?",
        issue.id,
        related.id,
        type,
        tx.now,
        row.id,
      );
      return this.result(tx, this.relationProjection(this.relationRow(principal, row.id, tx)));
    });
  }

  deleteIssueRelation(principal: Principal, id: string) {
    return this.write(principal, "write", (tx) => {
      const row = this.relationRow(principal, id, tx);
      tx.run("DELETE FROM issue_relations WHERE id = ?", row.id);
      return { success: true, lastSyncId: tx.syncId, entityId: row.id };
    });
  }

  private connection(entities: Entity[], args: ListArgs, namespace: string) {
    return paginate(
      filterEntities(
        entities.filter((entity) => args.includeArchived || entity.archivedAt === null),
        args.filter,
        this.runtime.clock.now(),
      ),
      args,
      namespace,
    );
  }

  listIssues(
    principal: Principal,
    args: ListArgs = {},
    relation: {
      teamId?: string;
      projectId?: string;
      parentId?: string;
      assigneeId?: string;
      delegateId?: string;
    } = {},
  ) {
    requireScope(principal, "read");
    const db = this.runtime.database;
    if (relation.teamId) this.team(principal, relation.teamId, db);
    if (relation.projectId) this.projectRow(principal, relation.projectId, db);
    if (relation.parentId) this.issueRow(principal, relation.parentId, db);
    const rows = db
      .query<IssueRow>("SELECT * FROM issues WHERE organization_id = ?")
      .all(principal.organizationId)
      .filter(
        (row) =>
          principal.teamIds.includes(row.team_id) &&
          (!relation.teamId || row.team_id === relation.teamId) &&
          (!relation.projectId || row.project_id === relation.projectId) &&
          (!relation.parentId || row.parent_id === relation.parentId) &&
          (!relation.assigneeId || row.assignee_id === relation.assigneeId) &&
          (!relation.delegateId || row.delegate_id === relation.delegateId),
      );
    const visible = rows.filter(
      (row) => !row.project_id || this.projectVisible(principal, row.project_id, db),
    );
    return this.connection(
      visible.map((row) => this.issueProjection(row, db)),
      args,
      `issues:${principal.organizationId}:${JSON.stringify(relation)}`,
    );
  }

  private projectVisible(principal: Principal, id: string, db: ReadDatabase): boolean {
    return db
      .query<{ team_id: string }>("SELECT team_id FROM project_teams WHERE project_id = ?")
      .all(id)
      .every((team) => principal.teamIds.includes(team.team_id));
  }

  listProjects(principal: Principal, args: ListArgs = {}, teamId?: string) {
    requireScope(principal, "read");
    const db = this.runtime.database;
    if (teamId) this.team(principal, teamId, db);
    const rows = db
      .query<ProjectRow>("SELECT * FROM projects WHERE organization_id = ?")
      .all(principal.organizationId)
      .filter(
        (row) =>
          this.projectVisible(principal, row.id, db) &&
          (!teamId ||
            db
              .query("SELECT 1 FROM project_teams WHERE project_id = ? AND team_id = ?")
              .get(row.id, teamId)),
      );
    return this.connection(
      rows.map((row) => this.projectProjection(row, db)),
      args,
      `projects:${principal.organizationId}:${teamId ?? ""}`,
    );
  }

  private labels(
    tx: Transaction,
    principal: Principal,
    issueId: string,
    teamId: string,
    input: IssueInput,
  ) {
    const existing = tx
      .query<{ label_id: string }>(
        "SELECT label_id FROM issue_label_memberships WHERE issue_id = ?",
      )
      .all(issueId)
      .map((label) => label.label_id);
    const replacement = input.labelIds === undefined ? existing : list(input.labelIds, "labelIds");
    const ids =
      input.labelIds === undefined
        ? [
            ...new Set([...replacement, ...list(input.addedLabelIds ?? [], "addedLabelIds")]),
          ].filter((id) => !list(input.removedLabelIds ?? [], "removedLabelIds").includes(id))
        : replacement;
    for (const id of ids) {
      if (
        !tx
          .query(
            "SELECT 1 FROM issue_labels WHERE id = ? AND organization_id = ? AND (team_id IS NULL OR team_id = ?)",
          )
          .get(id, principal.organizationId, teamId)
      )
        invalid("Label is unavailable in this team");
    }
    tx.run("DELETE FROM issue_label_memberships WHERE issue_id = ?", issueId);
    for (const id of ids)
      tx.run(
        "INSERT INTO issue_label_memberships VALUES(?, ?, ?)",
        principal.organizationId,
        issueId,
        id,
      );
  }

  private validateIssueReferences(
    tx: Transaction,
    principal: Principal,
    id: string,
    teamId: string,
    projectId: string | null,
    parentId: string | null,
    assigneeId: string | null,
    delegateId: string | null,
  ) {
    if (projectId) {
      this.projectRow(principal, projectId, tx);
      if (
        !tx
          .query("SELECT 1 FROM project_teams WHERE project_id = ? AND team_id = ?")
          .get(projectId, teamId)
      )
        invalid("Issue team must belong to project");
    }
    if (parentId) {
      let cursor: string | null = parentId;
      const visited = new Set<string>([id]);
      while (cursor) {
        if (visited.has(cursor)) invalid("Parent assignment creates a cycle");
        visited.add(cursor);
        cursor = this.issueRow(principal, cursor, tx).parent_id;
      }
    }
    if (assigneeId) {
      this.user(principal, assigneeId, tx, false);
      if (
        !tx
          .query(
            "SELECT 1 FROM team_memberships WHERE organization_id = ? AND team_id = ? AND user_id = ?",
          )
          .get(principal.organizationId, teamId, assigneeId)
      )
        invalid("Assignee must belong to issue team");
    }
    if (delegateId) {
      this.user(principal, delegateId, tx, true);
      return this.options.requireDelegate?.(tx, {
        organizationId: principal.organizationId,
        teamId,
        appUserId: delegateId,
      });
    }
  }

  createIssue(
    principal: Principal,
    input: IssueInput,
    transaction?: Transaction,
  ): MutationResult<Entity> {
    requireScope(principal, principal.scopes.includes("write") ? "write" : "issues:create");
    keys(input, issueKeys);
    dates(input as Record<string, unknown>);
    const work = (tx: Transaction) => {
      const teamId = text(input.teamId, "teamId");
      const title = text(input.title, "title");
      const team = this.team(principal, teamId, tx);
      const id = input.id === undefined ? crypto.randomUUID() : uuid(input.id);
      if (tx.query("SELECT 1 FROM issues WHERE id = ?").get(id))
        throw new DomainError("CONFLICT", "Issue ID already exists");
      const state = this.state(principal, teamId, input.stateId, tx);
      const projectId = input.projectId ?? null;
      const parentId = input.parentId ?? null;
      const assigneeId = input.assigneeId ?? null;
      const delegateId = input.delegateId ?? null;
      const owner = this.validateIssueReferences(
        tx,
        principal,
        id,
        teamId,
        projectId,
        parentId,
        assigneeId,
        delegateId,
      );
      const number = this.nextNumber(tx, principal, teamId);
      const stored = {
        description: input.description ?? null,
        priority: input.priority ?? 0,
        estimate: input.estimate ?? null,
        dueDate: input.dueDate ?? null,
        boardOrder: input.boardOrder ?? number,
        sortOrder: input.sortOrder ?? number,
        prioritySortOrder: input.prioritySortOrder ?? number,
        subIssueSortOrder: parentId ? (input.subIssueSortOrder ?? number) : null,
        previousIdentifiers: [],
        trashed: false,
        startedAt: state.type === "started" ? tx.now : null,
        completedAt: state.type === "completed" ? tx.now : null,
        canceledAt: state.type === "canceled" ? tx.now : null,
        startedTriageAt: state.type === "triage" ? tx.now : null,
        triagedAt: null,
        addedToTeamAt: tx.now,
        addedToProjectAt: projectId ? tx.now : null,
        addedToCycleAt: null,
        autoArchivedAt: null,
        autoClosedAt: null,
        slaStartedAt: null,
        slaBreachesAt: null,
        slaHighRiskAt: null,
        slaMediumRiskAt: null,
        snoozedUntilAt: null,
        slaType: null,
      };
      tx.run(
        "INSERT INTO issues(id, organization_id, team_id, number, identifier, title, state_id, project_id, parent_id, assignee_id, delegate_id, creator_id, created_at, updated_at, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        principal.organizationId,
        teamId,
        number,
        `${team.key}-${number}`,
        title,
        state.id,
        projectId,
        parentId,
        assigneeId,
        delegateId,
        principal.userId,
        tx.now,
        tx.now,
        JSON.stringify(stored),
      );
      this.labels(tx, principal, id, teamId, input);
      this.recordMetrics(tx, projectId);
      const entity = this.issueProjection(this.issueRow(principal, id, tx), tx);
      this.emit(tx, principal, "Issue", "create", entity);
      if (delegateId) this.delegated(tx, principal, entity, null, owner);
      return this.result(tx, entity);
    };
    return this.write(
      principal,
      principal.scopes.includes("write") ? "write" : "issues:create",
      work,
      transaction,
    );
  }

  updateIssue(
    principal: Principal,
    id: string,
    input: IssueInput,
    transaction?: Transaction,
  ): MutationResult<Entity> {
    requireScope(principal, "write");
    keys(
      input,
      issueKeys.filter((key) => key !== "id"),
    );
    dates(input as Record<string, unknown>);
    const work = (tx: Transaction) => {
      const row = this.issueRow(principal, id, tx);
      const before = this.issueProjection(row, tx);
      const teamId = input.teamId === undefined ? row.team_id : text(input.teamId, "teamId");
      const team = this.team(principal, teamId, tx);
      const moved = teamId !== row.team_id;
      const state = this.state(
        principal,
        teamId,
        input.stateId ?? (moved ? undefined : row.state_id),
        tx,
      );
      const projectId = input.projectId === undefined ? row.project_id : input.projectId;
      const parentId = input.parentId === undefined ? row.parent_id : input.parentId;
      const assigneeId = input.assigneeId === undefined ? row.assignee_id : input.assigneeId;
      const delegateId = input.delegateId === undefined ? row.delegate_id : input.delegateId;
      const owner = this.validateIssueReferences(
        tx,
        principal,
        row.id,
        teamId,
        projectId,
        parentId,
        assigneeId,
        delegateId,
      );
      const stored = data(row);
      for (const field of [
        "description",
        "priority",
        "estimate",
        "dueDate",
        "boardOrder",
        "sortOrder",
        "prioritySortOrder",
        "subIssueSortOrder",
      ] as const)
        if (input[field] !== undefined) stored[field] = input[field];
      const oldState = tx
        .query<{ type: string }>("SELECT type FROM workflow_states WHERE id = ?")
        .get(row.state_id)!;
      if (state.id !== row.state_id) {
        for (const [field, type] of [
          ["startedAt", "started"],
          ["completedAt", "completed"],
          ["canceledAt", "canceled"],
        ])
          stored[field!] = state.type === type ? tx.now : null;
        if (state.type === "triage") stored.startedTriageAt = tx.now;
        if (oldState.type === "triage" && state.type !== "triage") stored.triagedAt = tx.now;
      }
      const number = moved ? this.nextNumber(tx, principal, teamId) : row.number;
      if (moved) {
        stored.previousIdentifiers = [...(stored.previousIdentifiers as string[]), row.identifier];
        stored.addedToTeamAt = tx.now;
      }
      if (projectId !== row.project_id) stored.addedToProjectAt = projectId ? tx.now : null;
      if (!parentId) stored.subIssueSortOrder = null;
      else if (stored.subIssueSortOrder === null) stored.subIssueSortOrder = number;
      const title = input.title === undefined ? row.title : text(input.title, "title");
      tx.run(
        "UPDATE issues SET team_id = ?, number = ?, identifier = ?, title = ?, state_id = ?, project_id = ?, parent_id = ?, assignee_id = ?, delegate_id = ?, updated_at = ?, data = ? WHERE id = ?",
        teamId,
        number,
        `${team.key}-${number}`,
        title,
        state.id,
        projectId,
        parentId,
        assigneeId,
        delegateId,
        tx.now,
        JSON.stringify(stored),
        row.id,
      );
      this.labels(tx, principal, row.id, teamId, input);
      this.recordMetrics(tx, row.project_id);
      this.recordMetrics(tx, projectId);
      const entity = this.issueProjection(this.issueRow(principal, row.id, tx), tx);
      this.emit(tx, principal, "Issue", "update", entity, before);
      if (delegateId && delegateId !== row.delegate_id)
        this.delegated(tx, principal, entity, row.delegate_id, owner);
      return this.result(tx, entity);
    };
    return this.write(principal, "write", work, transaction);
  }

  setDelegate(principal: Principal, issueId: string, delegateId: string | null, tx?: Transaction) {
    return this.updateIssue(principal, issueId, { delegateId }, tx);
  }

  archiveIssue(principal: Principal, id: string, trash = false) {
    return this.issueVisibility(principal, id, true, trash);
  }
  unarchiveIssue(principal: Principal, id: string) {
    return this.issueVisibility(principal, id, false, false);
  }
  private issueVisibility(principal: Principal, id: string, archived: boolean, trash: boolean) {
    requireScope(principal, "write");
    return this.write(principal, "write", (tx) => {
      const row = this.issueRow(principal, id, tx);
      const before = this.issueProjection(row, tx);
      tx.run(
        "UPDATE issues SET archived_at = ?, updated_at = ?, data = ? WHERE id = ?",
        archived ? (row.archived_at ?? tx.now) : null,
        tx.now,
        JSON.stringify({ ...data(row), trashed: trash }),
        row.id,
      );
      this.recordMetrics(tx, row.project_id);
      const entity = this.issueProjection(this.issueRow(principal, row.id, tx), tx);
      this.emit(tx, principal, "Issue", "update", entity, before);
      return this.result(tx, entity);
    });
  }

  deleteIssue(principal: Principal, id: string) {
    requireScope(principal, "write");
    return this.write(principal, "write", (tx) => {
      const row = this.issueRow(principal, id, tx);
      const entity = this.issueProjection(row, tx);
      const children = tx.query<IssueRow>("SELECT * FROM issues WHERE parent_id = ?").all(row.id);
      for (const child of children) this.updateIssue(principal, child.id, { parentId: null }, tx);
      const comments = tx
        .query<CommentRow>("SELECT * FROM comments WHERE issue_id = ?")
        .all(row.id);
      for (const comment of comments)
        this.emit(tx, principal, "Comment", "remove", this.commentProjection(comment, tx));
      tx.run("UPDATE comments SET parent_id = NULL WHERE issue_id = ?", row.id);
      tx.run("DELETE FROM issues WHERE id = ?", row.id);
      this.recordMetrics(tx, row.project_id);
      this.emit(tx, principal, "Issue", "remove", entity);
      return this.result(tx, entity);
    });
  }

  createProject(principal: Principal, input: ProjectInput): MutationResult<Entity> {
    requireScope(principal, "write");
    keys(input, projectKeys);
    dates(input as Record<string, unknown>);
    return this.write(principal, "write", (tx) => {
      const id = input.id === undefined ? crypto.randomUUID() : uuid(input.id);
      if (tx.query("SELECT 1 FROM projects WHERE id = ?").get(id))
        throw new DomainError("CONFLICT", "Project ID already exists");
      const name = text(input.name, "name");
      const teamIds = list(input.teamIds, "teamIds");
      if (!teamIds.length) invalid("Project requires at least one team");
      for (const teamId of teamIds) this.team(principal, teamId, tx);
      const status = this.status(principal, input.statusId, tx);
      if (input.leadId) this.user(principal, input.leadId, tx);
      const stored = {
        description: input.description ?? "",
        content: input.content ?? null,
        color: input.color ?? "#808080",
        icon: input.icon ?? null,
        priority: input.priority ?? 0,
        prioritySortOrder: input.prioritySortOrder ?? tx.now,
        sortOrder: input.sortOrder ?? tx.now,
        startDate: input.startDate ?? null,
        targetDate: input.targetDate ?? null,
        slugId: id.replaceAll("-", "").slice(0, 12),
        trashed: false,
        startedAt: status.type === "started" ? tx.now : null,
        completedAt: status.type === "completed" ? tx.now : null,
        canceledAt: status.type === "canceled" ? tx.now : null,
      };
      tx.run(
        "INSERT INTO projects(id, organization_id, name, status_id, lead_id, creator_id, created_at, updated_at, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        principal.organizationId,
        name,
        status.id,
        input.leadId ?? null,
        principal.userId,
        tx.now,
        tx.now,
        JSON.stringify(stored),
      );
      for (const teamId of teamIds)
        tx.run("INSERT INTO project_teams VALUES(?, ?, ?)", principal.organizationId, id, teamId);
      this.projectMembers(tx, principal, id, input.memberIds ?? []);
      this.recordMetrics(tx, id);
      const entity = this.projectProjection(this.projectRow(principal, id, tx), tx);
      this.emit(tx, principal, "Project", "create", entity);
      return this.result(tx, entity);
    });
  }

  private projectMembers(
    tx: Transaction,
    principal: Principal,
    projectId: string,
    input: string[],
  ) {
    const members = list(input, "memberIds");
    for (const id of members) this.user(principal, id, tx);
    tx.run("DELETE FROM project_members WHERE project_id = ?", projectId);
    for (const id of members)
      tx.run(
        "INSERT INTO project_members VALUES(?, ?, ?)",
        principal.organizationId,
        projectId,
        id,
      );
  }

  updateProject(principal: Principal, id: string, input: ProjectInput): MutationResult<Entity> {
    requireScope(principal, "write");
    keys(
      input,
      projectKeys.filter((key) => key !== "id"),
    );
    dates(input as Record<string, unknown>);
    return this.write(principal, "write", (tx) => {
      const row = this.projectRow(principal, id, tx);
      const before = this.projectProjection(row, tx);
      const status = this.status(principal, input.statusId ?? row.status_id, tx);
      const leadId = input.leadId === undefined ? row.lead_id : input.leadId;
      if (leadId) this.user(principal, leadId, tx);
      if (input.teamIds !== undefined) {
        const teams = list(input.teamIds, "teamIds");
        if (!teams.length) invalid("Project requires at least one team");
        for (const teamId of teams) this.team(principal, teamId, tx);
        const used = tx
          .query<{ team_id: string }>("SELECT DISTINCT team_id FROM issues WHERE project_id = ?")
          .all(row.id);
        if (used.some((team) => !teams.includes(team.team_id)))
          invalid("Cannot remove a team with project issues");
        const old = tx
          .query<{ team_id: string }>("SELECT team_id FROM project_teams WHERE project_id = ?")
          .all(row.id);
        for (const teamId of teams)
          tx.run(
            "INSERT OR IGNORE INTO project_teams VALUES(?, ?, ?)",
            principal.organizationId,
            row.id,
            teamId,
          );
        for (const team of old)
          if (!teams.includes(team.team_id))
            tx.run(
              "DELETE FROM project_teams WHERE project_id = ? AND team_id = ?",
              row.id,
              team.team_id,
            );
      }
      if (input.memberIds !== undefined)
        this.projectMembers(tx, principal, row.id, input.memberIds);
      const stored = data(row);
      for (const field of [
        "description",
        "content",
        "color",
        "icon",
        "priority",
        "sortOrder",
        "prioritySortOrder",
        "startDate",
        "targetDate",
      ] as const)
        if (input[field] !== undefined) {
          if ((field === "description" || field === "color") && input[field] === null)
            invalid(`Invalid ${field}`);
          stored[field] = input[field];
        }
      if (status.id !== row.status_id)
        for (const [field, type] of [
          ["startedAt", "started"],
          ["completedAt", "completed"],
          ["canceledAt", "canceled"],
        ])
          stored[field!] = status.type === type ? tx.now : null;
      tx.run(
        "UPDATE projects SET name = ?, status_id = ?, lead_id = ?, updated_at = ?, data = ? WHERE id = ?",
        input.name === undefined ? row.name : text(input.name, "name"),
        status.id,
        leadId,
        tx.now,
        JSON.stringify(stored),
        row.id,
      );
      const entity = this.projectProjection(this.projectRow(principal, row.id, tx), tx);
      this.emit(tx, principal, "Project", "update", entity, before);
      return this.result(tx, entity);
    });
  }

  archiveProject(principal: Principal, id: string, trash = false) {
    return this.projectVisibility(principal, id, true, trash);
  }
  unarchiveProject(principal: Principal, id: string) {
    return this.projectVisibility(principal, id, false, false);
  }
  private projectVisibility(principal: Principal, id: string, archived: boolean, trash: boolean) {
    requireScope(principal, "write");
    return this.write(principal, "write", (tx) => {
      const row = this.projectRow(principal, id, tx);
      const before = this.projectProjection(row, tx);
      tx.run(
        "UPDATE projects SET archived_at = ?, updated_at = ?, data = ? WHERE id = ?",
        archived ? (row.archived_at ?? tx.now) : null,
        tx.now,
        JSON.stringify({ ...data(row), trashed: trash }),
        row.id,
      );
      const entity = this.projectProjection(this.projectRow(principal, row.id, tx), tx);
      this.emit(tx, principal, "Project", "update", entity, before);
      return this.result(tx, entity);
    });
  }

  deleteProject(principal: Principal, id: string) {
    requireScope(principal, "write");
    return this.write(principal, "write", (tx) => {
      const row = this.projectRow(principal, id, tx);
      const entity = this.projectProjection(row, tx);
      for (const issue of tx
        .query<IssueRow>("SELECT * FROM issues WHERE project_id = ?")
        .all(row.id))
        this.updateIssue(principal, issue.id, { projectId: null }, tx);
      tx.run("DELETE FROM projects WHERE id = ?", row.id);
      this.emit(tx, principal, "Project", "remove", entity);
      return this.result(tx, entity);
    });
  }

  private commentProjection(row: CommentRow, db: ReadDatabase): Entity {
    const issue = db.query<IssueRow>("SELECT * FROM issues WHERE id = ?").get(row.issue_id)!;
    return {
      __typename: "Comment",
      id: row.id,
      organizationId: row.organization_id,
      teamId: issue.team_id,
      issueId: row.issue_id,
      parentId: row.parent_id,
      userId: row.user_id,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      issue: ref(row.issue_id),
      parent: ref(row.parent_id),
      user: ref(row.user_id),
      url: `https://linear.app/issue/${issue.identifier}#comment-${row.id}`,
      reactionData: [],
      reactions: [],
      agentSession: null,
      resolvingCommentId: null,
      documentContentId: null,
      initiativeId: null,
      initiativeUpdateId: null,
      projectId: null,
      projectUpdateId: null,
      botActor: null,
      resolvingComment: null,
      documentContent: null,
      syncedWith: [],
      externalThread: null,
      externalUser: null,
      initiative: null,
      initiativeUpdate: null,
      project: null,
      projectUpdate: null,
      quotedText: null,
      editedAt: null,
      resolvedAt: null,
      resolvingUser: null,
      ...data(row),
    };
  }

  requireComment(principal: Principal, id: string, tx?: Transaction): Entity {
    requireScope(principal, "read");
    const db = tx ?? this.runtime.database;
    const row = db
      .query<CommentRow>("SELECT * FROM comments WHERE id = ? AND organization_id = ?")
      .get(id, principal.organizationId);
    if (!row) throw new DomainError("NOT_FOUND", "Comment not found");
    const issue = db
      .query<IssueRow>("SELECT * FROM issues WHERE organization_id = ? AND id = ?")
      .get(principal.organizationId, row.issue_id);
    if (
      !issue ||
      !principal.teamIds.includes(issue.team_id) ||
      (issue.project_id && !this.projectVisible(principal, issue.project_id, db))
    )
      throw new DomainError("NOT_FOUND", "Comment not found");
    this.issueRow(principal, row.issue_id, db);
    return this.commentProjection(row, db);
  }

  createComment(
    principal: Principal,
    input: CommentInput,
    transaction?: Transaction,
  ): MutationResult<Entity> {
    requireScope(principal, principal.scopes.includes("write") ? "write" : "comments:create");
    keys(input, ["id", "issueId", "parentId", "body"]);
    const work = (tx: Transaction) => {
      const issue = this.issueRow(principal, input.issueId, tx);
      const body = text(input.body, "body");
      const id = input.id === undefined ? crypto.randomUUID() : uuid(input.id);
      if (tx.query("SELECT 1 FROM comments WHERE id = ?").get(id))
        throw new DomainError("CONFLICT", "Comment ID already exists");
      if (input.parentId) {
        const parent = tx
          .query<CommentRow>("SELECT * FROM comments WHERE id = ? AND organization_id = ?")
          .get(input.parentId, principal.organizationId);
        if (!parent || parent.issue_id !== issue.id)
          invalid("Comment parent must belong to same issue");
      }
      tx.run(
        "INSERT INTO comments(id, organization_id, issue_id, parent_id, user_id, creator_id, body, created_at, updated_at, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')",
        id,
        principal.organizationId,
        issue.id,
        input.parentId ?? null,
        principal.userId,
        principal.userId,
        body,
        tx.now,
        tx.now,
      );
      const entity = this.commentProjection(
        tx.query<CommentRow>("SELECT * FROM comments WHERE id = ?").get(id)!,
        tx,
      );
      this.emit(tx, principal, "Comment", "create", entity);
      return this.result(tx, entity);
    };
    return this.write(
      principal,
      principal.scopes.includes("write") ? "write" : "comments:create",
      work,
      transaction,
    );
  }

  listComments(principal: Principal, args: ListArgs = {}, issueId?: string, parentId?: string) {
    requireScope(principal, "read");
    const db = this.runtime.database;
    if (issueId) this.issueRow(principal, issueId, db);
    if (parentId) this.requireComment(principal, parentId);
    const rows = db
      .query<CommentRow & { team_id: string; project_id: string | null }>(
        "SELECT comments.*, issues.team_id, issues.project_id FROM comments JOIN issues ON issues.id = comments.issue_id WHERE comments.organization_id = ?",
      )
      .all(principal.organizationId)
      .filter(
        (row) =>
          principal.teamIds.includes(row.team_id) &&
          (!row.project_id || this.projectVisible(principal, row.project_id, db)) &&
          (!issueId || row.issue_id === issueId) &&
          (!parentId || row.parent_id === parentId),
      );
    return this.connection(
      rows.map((row) => this.commentProjection(row, db)),
      args,
      `comments:${principal.organizationId}:${issueId ?? ""}:${parentId ?? ""}`,
    );
  }

  createLabel(principal: Principal, input: LabelInput) {
    requireScope(principal, "write");
    keys(input, ["id", "name", "color", "teamId", "description"]);
    return this.write(principal, "write", (tx) => {
      if (input.teamId) this.team(principal, input.teamId, tx);
      const id = input.id === undefined ? crypto.randomUUID() : uuid(input.id);
      if (tx.query("SELECT 1 FROM issue_labels WHERE id = ?").get(id))
        throw new DomainError("CONFLICT", "Label ID already exists");
      tx.run(
        "INSERT INTO issue_labels VALUES(?, ?, ?, ?, ?, ?, ?)",
        id,
        principal.organizationId,
        input.teamId ?? null,
        text(input.name, "name"),
        input.color ?? "#808080",
        input.description ?? null,
        tx.now,
      );
      const entity = this.requireLabel(principal, id, tx);
      this.emit(tx, principal, "IssueLabel", "create", entity);
      return this.result(tx, entity);
    });
  }

  requireLabel(principal: Principal, id: string, tx?: Transaction): Entity {
    requireScope(principal, "read");
    const db = tx ?? this.runtime.database;
    const row = db
      .query<{
        id: string;
        organization_id: string;
        team_id: string | null;
        name: string;
        color: string;
        description: string | null;
        created_at: number;
      }>("SELECT * FROM issue_labels WHERE id = ? AND organization_id = ?")
      .get(id, principal.organizationId);
    if (!row || (row.team_id && !principal.teamIds.includes(row.team_id)))
      throw new DomainError("NOT_FOUND", "Label not found");
    if (row.team_id) this.team(principal, row.team_id, db);
    return {
      __typename: "IssueLabel",
      id: row.id,
      name: row.name,
      color: row.color,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.created_at,
      archivedAt: null,
      team: ref(row.team_id),
      inheritedFrom: null,
      parent: null,
      groupType: null,
      creator: null,
      retiredBy: null,
      isGroup: false,
      lastAppliedAt:
        db
          .query<{ at: number | null }>(
            "SELECT max(issues.updated_at) AS at FROM issues JOIN issue_label_memberships ON issue_label_memberships.issue_id = issues.id WHERE label_id = ?",
          )
          .get(id)?.at ?? null,
    };
  }

  listLabels(principal: Principal, args: ListArgs = {}, issueId?: string, teamId?: string) {
    requireScope(principal, "read");
    const db = this.runtime.database;
    if (issueId) this.issueRow(principal, issueId, db);
    if (teamId) this.team(principal, teamId, db);
    const rows = db
      .query<{ id: string; team_id: string | null }>(
        "SELECT id, team_id FROM issue_labels WHERE organization_id = ?",
      )
      .all(principal.organizationId)
      .filter(
        (row) =>
          (!row.team_id || principal.teamIds.includes(row.team_id)) &&
          (!teamId || !row.team_id || row.team_id === teamId) &&
          (!issueId ||
            db
              .query("SELECT 1 FROM issue_label_memberships WHERE issue_id = ? AND label_id = ?")
              .get(issueId, row.id)),
      );
    return this.connection(
      rows.map((row) => this.requireLabel(principal, row.id)),
      args,
      `labels:${principal.organizationId}:${issueId ?? ""}:${teamId ?? ""}`,
    );
  }
}
