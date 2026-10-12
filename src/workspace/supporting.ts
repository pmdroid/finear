import type { Runtime } from "../core/runtime";
import { DomainError } from "../core/errors";
import { requireOrganization, requireScope, requireTeam, type Principal } from "../core/principal";
import type { ResolverMap } from "../graphql/composition";

type Row = Record<string, unknown> & {
  id: string;
  organization_id?: string;
  created_at: number;
  settings?: string;
};
type Args = Record<string, unknown>;

export function supportingResolvers(): ResolverMap {
  function rows(runtime: Runtime, table: string, principal: Principal): Row[] {
    requireScope(principal, "read");
    if (table === "organizations")
      return runtime.database
        .query<Row>("SELECT * FROM organizations WHERE id = ?")
        .all(principal.organizationId);
    let result = runtime.database
      .query<Row>(`SELECT * FROM ${table} WHERE organization_id = ? ORDER BY created_at, id`)
      .all(principal.organizationId);
    if (table === "teams") result = result.filter((row) => principal.teamIds.includes(row.id));
    if (table === "workflow_states")
      result = result.filter((row) => principal.teamIds.includes(String(row.team_id)));
    return result;
  }
  function count(runtime: Runtime, table: string, organizationId: string, userId?: string) {
    if (
      !runtime.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)
    )
      return 0;
    return (
      runtime.database
        .query<{ count: number }>(
          `SELECT count(*) AS count FROM ${table} WHERE organization_id = ?${userId ? " AND creator_id = ?" : ""}`,
        )
        .get(...(userId ? [organizationId, userId] : [organizationId]))?.count ?? 0
    );
  }
  function project(
    row: Row,
    table: string,
    runtime: Runtime,
    principal: Principal,
  ): Record<string, unknown> {
    const times = { id: row.id, createdAt: row.created_at, updatedAt: row.created_at };
    const settings = row.settings ? (JSON.parse(row.settings) as Record<string, unknown>) : {};
    if (table === "users")
      return {
        ...settings,
        ...times,
        name: row.name,
        email: row.email,
        displayName: row.name,
        initials: String(row.name)
          .split(" ")
          .map((part) => part[0])
          .join(""),
        url: `https://linear.app/${principal.organizationId}/profiles/${row.id}`,
        createdIssueCount: count(runtime, "issues", principal.organizationId, row.id),
        inviteHash: row.id,
        admin: Boolean(row.admin),
        owner: Boolean(row.admin),
        app: Boolean(row.app),
        isAssignable: true,
        isMentionable: true,
        isMe: row.id === principal.userId,
        supportsAgentSessions: Boolean(row.app),
        canAccessAnyPublicTeam: !row.app,
      };
    if (table === "teams")
      return {
        ...settings,
        ...times,
        name: row.name,
        displayName: row.name,
        key: row.key,
        private: Boolean(row.private),
        visibility: row.private ? "private" : "public",
        viewerCanJoin: false,
        inviteHash: row.id,
        issueCount: runtime.database
          .query("SELECT name FROM sqlite_master WHERE name = 'issues'")
          .get()
          ? (runtime.database
              .query<{ count: number }>("SELECT count(*) AS count FROM issues WHERE team_id = ?")
              .get(row.id)?.count ?? 0)
          : 0,
        defaultIssueState: runtime.database
          .query(
            "SELECT id FROM workflow_states WHERE team_id = ? AND type = 'backlog' ORDER BY position LIMIT 1",
          )
          .get(row.id),
      };
    if (table === "organizations")
      return {
        ...settings,
        ...times,
        name: row.name,
        urlKey: row.url_key,
        createdIssueCount: count(runtime, "issues", row.id),
        userCount: count(runtime, "users", row.id),
        projectStatuses: rows(runtime, "project_statuses", principal).map((status) =>
          project(status, "project_statuses", runtime, principal),
        ),
      };
    if (table === "workflow_states")
      return {
        ...times,
        name: row.name,
        type: row.type,
        color: row.color,
        position: row.position,
        description: null,
        archivedAt: null,
        inheritedFrom: null,
        team: { id: row.team_id },
      };
    return {
      ...times,
      name: row.name,
      type: row.type,
      color: row.color,
      position: row.position,
      description: null,
      archivedAt: null,
      indefinite: false,
    };
  }
  function filtered(input: Row[], filter: unknown): Row[] {
    if (filter === undefined || filter === null) return input;
    if (typeof filter !== "object" || Array.isArray(filter))
      throw new DomainError("INVALID_INPUT", "Invalid filter");
    function matches(row: Row, value: Record<string, unknown>): boolean {
      return Object.entries(value).every(([field, condition]) => {
        if (field === "and" || field === "or") {
          if (!Array.isArray(condition))
            throw new DomainError("INVALID_INPUT", "Invalid logical filter");
          const values = condition.map((item) => matches(row, item as Record<string, unknown>));
          return field === "and" ? values.every(Boolean) : values.some(Boolean);
        }
        const key = (
          {
            id: "id",
            name: "name",
            email: "email",
            key: "key",
            type: "type",
            team: "team_id",
            organization: "organization_id",
          } as Record<string, string>
        )[field];
        if (!key || !condition || typeof condition !== "object")
          throw new DomainError("INVALID_INPUT", `Unsupported filter ${field}`);
        const comparator = condition as Record<string, unknown>;
        return Object.entries(comparator).every(([operator, expected]) => {
          if (operator === "id") return matches({ ...row, id: String(row[key]) }, { id: expected });
          if (operator === "eq") return row[key] === expected;
          if (operator === "neq") return row[key] !== expected;
          if (operator === "in") return Array.isArray(expected) && expected.includes(row[key]);
          if (operator === "nin") return Array.isArray(expected) && !expected.includes(row[key]);
          if (operator === "contains")
            return typeof expected === "string" && String(row[key]).includes(expected);
          throw new DomainError("INVALID_INPUT", `Unsupported comparator ${operator}`);
        });
      });
    }
    return input.filter((row) => matches(row, filter as Record<string, unknown>));
  }
  function connection(
    input: Row[],
    args: Args,
    table: string,
    runtime: Runtime,
    principal: Principal,
  ) {
    if (args.sort !== undefined && args.sort !== null)
      throw new DomainError("INVALID_INPUT", "Explicit sort is not supported for directory reads");
    const result = filtered(input, args.filter);
    const cursor = (row: Row) => Buffer.from(`${table}:${row.id}`).toString("base64url");
    const index = (value: unknown) => {
      const found = result.findIndex((row) => cursor(row) === value);
      if (found < 0) throw new DomainError("INVALID_INPUT", "Invalid cursor");
      return found;
    };
    const start = args.after ? index(args.after) + 1 : 0;
    const end = args.before ? index(args.before) : result.length;
    const first = args.first === undefined ? undefined : Number(args.first);
    const last = args.last === undefined ? undefined : Number(args.last);
    if (
      (first !== undefined && (!Number.isInteger(first) || first < 0)) ||
      (last !== undefined && (!Number.isInteger(last) || last < 0)) ||
      (first !== undefined && last !== undefined)
    )
      throw new DomainError("INVALID_INPUT", "Invalid pagination");
    let selected = result.slice(start, end);
    if (last !== undefined) selected = selected.slice(Math.max(0, selected.length - last));
    else selected = selected.slice(0, first ?? 50);
    const nodes = selected.map((row) => project(row, table, runtime, principal));
    return {
      nodes,
      edges: nodes.map((node, i) => ({ node, cursor: cursor(selected[i]!) })),
      pageInfo: {
        hasPreviousPage: selected.length ? result.indexOf(selected[0]!) > 0 : start > 0,
        hasNextPage: selected.length
          ? result.indexOf(selected[selected.length - 1]!) < result.length - 1
          : end < result.length,
        startCursor: selected.length ? cursor(selected[0]!) : null,
        endCursor: selected.length ? cursor(selected[selected.length - 1]!) : null,
      },
    };
  }
  const root: Record<string, import("../graphql/composition").FieldResolver> = {};
  for (const [single, plural, table] of [
    ["user", "users", "users"],
    ["team", "teams", "teams"],
    ["workflowState", "workflowStates", "workflow_states"],
    ["projectStatus", "projectStatuses", "project_statuses"],
  ] as const) {
    root[single] = (_source, args, { runtime, principal }) => {
      const row = rows(runtime, table, principal).find(
        (row) => row.id === args.id || (table === "teams" && row.key === args.id),
      );
      if (!row) throw new DomainError("NOT_FOUND", "Record not found");
      return project(row, table, runtime, principal);
    };
    root[plural] = (_source, args, { runtime, principal }) =>
      connection(rows(runtime, table, principal), args, table, runtime, principal);
  }
  root.viewer = (_source, _args, { runtime, principal }) => {
    const row = rows(runtime, "users", principal).find((row) => row.id === principal.userId);
    if (!row) throw new DomainError("NOT_FOUND", "Viewer not found");
    return project(row, "users", runtime, principal);
  };
  root.organization = (_source, _args, { runtime, principal }) =>
    project(rows(runtime, "organizations", principal)[0]!, "organizations", runtime, principal);
  return {
    Query: root,
    Organization: {
      teams: (source, args, { runtime, principal }) => {
        requireOrganization(principal, (source as Row).id);
        return connection(rows(runtime, "teams", principal), args, "teams", runtime, principal);
      },
      users: (source, args, { runtime, principal }) => {
        requireOrganization(principal, (source as Row).id);
        return connection(rows(runtime, "users", principal), args, "users", runtime, principal);
      },
    },
    User: {
      teams: (source, args, { runtime, principal }) => {
        const memberships = runtime.database
          .query<{ team_id: string }>(
            "SELECT team_id FROM team_memberships WHERE organization_id = ? AND user_id = ?",
          )
          .all(principal.organizationId, (source as Row).id);
        return connection(
          rows(runtime, "teams", principal).filter((row) =>
            memberships.some((membership) => membership.team_id === row.id),
          ),
          args,
          "teams",
          runtime,
          principal,
        );
      },
    },
    Team: {
      states: (source, args, { runtime, principal }) => {
        requireTeam(principal, {
          id: (source as Row).id,
          organizationId: principal.organizationId,
        });
        return connection(
          rows(runtime, "workflow_states", principal).filter(
            (row) => row.team_id === (source as Row).id,
          ),
          args,
          "workflow_states",
          runtime,
          principal,
        );
      },
      members: (source, args, { runtime, principal }) => {
        requireTeam(principal, {
          id: (source as Row).id,
          organizationId: principal.organizationId,
        });
        const members = runtime.database
          .query<{ user_id: string }>("SELECT user_id FROM team_memberships WHERE team_id = ?")
          .all((source as Row).id);
        return connection(
          rows(runtime, "users", principal).filter((row) =>
            members.some((member) => member.user_id === row.id),
          ),
          args,
          "users",
          runtime,
          principal,
        );
      },
    },
  };
}
