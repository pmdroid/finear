import type { MigrationSet } from "../core/database";
import { DomainError } from "../core/errors";
import { requireScope, type Principal } from "../core/principal";
import type { ResetOwner, Runtime } from "../core/runtime";
import type { Agents } from "./agents";
import type { Workspace } from "./entities";

type Candidate = { hostname: string; repositoryFullName: string };
type Suggestion = Candidate & { confidence: number };

export const repositorySuggestionMigrations: MigrationSet = {
  owner: "workspace_repositories",
  migrations: [
    {
      version: 1,
      sql: `
    CREATE TABLE repository_suggestions (
      organization_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      suggestions TEXT NOT NULL CHECK(json_valid(suggestions)),
      PRIMARY KEY(organization_id, issue_id),
      FOREIGN KEY(organization_id, issue_id) REFERENCES issues(organization_id, id) ON DELETE CASCADE
    );
  `,
    },
  ],
};

export const repositorySuggestionsResetOwner: ResetOwner = {
  clear(tx) {
    tx.run("DELETE FROM repository_suggestions");
  },
};

function candidates(input: unknown, scores: boolean): Suggestion[] {
  if (!Array.isArray(input)) throw new DomainError("INVALID_INPUT", "Expected repository list");
  return input.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new DomainError("INVALID_INPUT", "Invalid repository");
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          !["hostname", "repositoryFullName", ...(scores ? ["confidence"] : [])].includes(key),
      ) ||
      typeof row.hostname !== "string" ||
      !row.hostname.trim() ||
      typeof row.repositoryFullName !== "string" ||
      !/^[^/\s]+\/[^/\s]+$/.test(row.repositoryFullName) ||
      (scores &&
        (typeof row.confidence !== "number" ||
          !Number.isFinite(row.confidence) ||
          row.confidence < 0 ||
          row.confidence > 1))
    )
      throw new DomainError("INVALID_INPUT", "Invalid repository suggestion");
    return {
      hostname: row.hostname,
      repositoryFullName: row.repositoryFullName,
      confidence: scores ? (row.confidence as number) : 0,
    };
  });
}

export class RepositorySuggestions {
  constructor(
    readonly runtime: Runtime,
    readonly workspace: Workspace,
    readonly agents: Agents,
  ) {}

  configure(principal: Principal, issueId: string, input: unknown) {
    requireScope(principal, "write");
    const suggestions = candidates(input, true);
    this.runtime.database.transaction((tx) => {
      const issue = this.workspace.requireIssue(principal, issueId, tx);
      tx.run(
        "INSERT INTO repository_suggestions(organization_id, issue_id, suggestions) VALUES(?, ?, ?) ON CONFLICT(organization_id, issue_id) DO UPDATE SET suggestions = excluded.suggestions",
        principal.organizationId,
        issue.id,
        JSON.stringify(suggestions),
      );
    });
  }

  query(principal: Principal, issueId: string, input: unknown, agentSessionId?: string | null) {
    const issue = this.workspace.requireIssue(principal, issueId);
    if (agentSessionId !== undefined && agentSessionId !== null) {
      const session = this.agents.requireSession(principal, agentSessionId);
      if (session.issueId !== issue.id)
        throw new DomainError("INVALID_INPUT", "Session does not belong to issue");
    }
    const allowed = candidates(input, false);
    const row = this.runtime.database
      .query<{ suggestions: string }>(
        "SELECT suggestions FROM repository_suggestions WHERE organization_id = ? AND issue_id = ?",
      )
      .get(principal.organizationId, issue.id);
    const stored: Suggestion[] = row ? (JSON.parse(row.suggestions) as Suggestion[]) : [];
    return {
      suggestions: stored.filter((entry) =>
        allowed.some(
          (candidate) =>
            candidate.hostname === entry.hostname &&
            candidate.repositoryFullName === entry.repositoryFullName,
        ),
      ),
    };
  }
}
