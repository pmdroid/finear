import type { MigrationSet } from "../core/database";
import type { ResetOwner } from "../core/runtime";

export const workspaceEntityMigrations: MigrationSet = {
  owner: "workspace_entities",
  migrations: [
    {
      version: 1,
      sql: `
    CREATE UNIQUE INDEX workspace_state_team ON workflow_states(organization_id, team_id, id);
    CREATE TABLE team_issue_numbers (
      organization_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      value INTEGER NOT NULL CHECK(value > 0),
      PRIMARY KEY(organization_id, team_id),
      FOREIGN KEY(organization_id, team_id) REFERENCES teams(organization_id, id)
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      status_id TEXT NOT NULL,
      lead_id TEXT,
      creator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(organization_id, id),
      FOREIGN KEY(organization_id, status_id) REFERENCES project_statuses(organization_id, id),
      FOREIGN KEY(organization_id, lead_id) REFERENCES users(organization_id, id),
      FOREIGN KEY(organization_id, creator_id) REFERENCES users(organization_id, id)
    );
    CREATE TABLE project_teams (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      PRIMARY KEY(organization_id, project_id, team_id),
      FOREIGN KEY(organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY(organization_id, team_id) REFERENCES teams(organization_id, id)
    );
    CREATE TABLE project_members (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY(project_id, user_id),
      FOREIGN KEY(organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY(organization_id, user_id) REFERENCES users(organization_id, id)
    );
    CREATE TABLE issue_labels (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      team_id TEXT,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(organization_id, id),
      FOREIGN KEY(organization_id, team_id) REFERENCES teams(organization_id, id)
    );
    CREATE TABLE issues (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      team_id TEXT NOT NULL,
      number INTEGER NOT NULL CHECK(number > 0),
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      state_id TEXT NOT NULL,
      project_id TEXT,
      parent_id TEXT,
      assignee_id TEXT,
      delegate_id TEXT,
      creator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(organization_id, id),
      UNIQUE(organization_id, identifier),
      UNIQUE(team_id, number),
      CHECK(parent_id IS NULL OR parent_id <> id),
      FOREIGN KEY(organization_id, team_id, state_id) REFERENCES workflow_states(organization_id, team_id, id),
      FOREIGN KEY(organization_id, project_id, team_id) REFERENCES project_teams(organization_id, project_id, team_id),
      FOREIGN KEY(organization_id, parent_id) REFERENCES issues(organization_id, id),
      FOREIGN KEY(organization_id, assignee_id) REFERENCES users(organization_id, id),
      FOREIGN KEY(organization_id, delegate_id) REFERENCES users(organization_id, id),
      FOREIGN KEY(organization_id, creator_id) REFERENCES users(organization_id, id)
    );
    CREATE TABLE issue_label_memberships (
      organization_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY(issue_id, label_id),
      FOREIGN KEY(organization_id, issue_id) REFERENCES issues(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY(organization_id, label_id) REFERENCES issue_labels(organization_id, id)
    );
    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      parent_id TEXT,
      user_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(organization_id, id),
      UNIQUE(organization_id, issue_id, id),
      FOREIGN KEY(organization_id, issue_id) REFERENCES issues(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY(organization_id, issue_id, parent_id) REFERENCES comments(organization_id, issue_id, id),
      FOREIGN KEY(organization_id, user_id) REFERENCES users(organization_id, id),
      FOREIGN KEY(organization_id, creator_id) REFERENCES users(organization_id, id)
    );
    CREATE TABLE project_metric_history (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY(project_id, recorded_at),
      FOREIGN KEY(organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX workspace_issue_team ON issues(organization_id, team_id, created_at, id);
    CREATE INDEX workspace_issue_parent ON issues(organization_id, parent_id);
    CREATE INDEX workspace_issue_project ON issues(organization_id, project_id);
    CREATE INDEX workspace_comment_issue ON comments(organization_id, issue_id, created_at, id);
  `,
    },
  ],
};

export const workspaceEntityResetOwner: ResetOwner = {
  clear(tx) {
    tx.run("DELETE FROM comments WHERE parent_id IS NOT NULL");
    tx.run("DELETE FROM comments");
    tx.run("UPDATE issues SET parent_id = NULL");
    for (const table of [
      "issue_label_memberships",
      "issues",
      "project_metric_history",
      "project_members",
      "project_teams",
      "projects",
      "issue_labels",
      "team_issue_numbers",
    ])
      tx.run(`DELETE FROM ${table}`);
  },
};
