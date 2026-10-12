import type { MigrationSet } from "../core/database";

export const workspaceMigrations: MigrationSet = {
  owner: "workspace",
  migrations: [
    {
      version: 1,
      sql: `
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings))
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      app INTEGER NOT NULL DEFAULT 0 CHECK (app IN (0, 1)),
      admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1)),
      created_at INTEGER NOT NULL,
      settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
      UNIQUE (organization_id, id)
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      key TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
      settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
      created_at INTEGER NOT NULL,
      UNIQUE (organization_id, key),
      UNIQUE (organization_id, id)
    );
    CREATE TABLE team_memberships (
      organization_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id),
      FOREIGN KEY (organization_id, team_id) REFERENCES teams(organization_id, id),
      FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id)
    );
    CREATE TABLE workflow_states (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      color TEXT NOT NULL,
      position REAL NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id, team_id) REFERENCES teams(organization_id, id),
      UNIQUE (organization_id, id)
    );
    CREATE TABLE project_statuses (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      color TEXT NOT NULL,
      position REAL NOT NULL,
      created_at INTEGER NOT NULL,
      settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
      UNIQUE (organization_id, id)
    );
  `,
    },
  ],
};
