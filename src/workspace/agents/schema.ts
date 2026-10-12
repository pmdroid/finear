import type { MigrationSet } from "../../core/database";
import type { ResetOwner } from "../../core/runtime";

export const agentMigrations: MigrationSet = {
  owner: "workspace_agents",
  migrations: [
    {
      version: 1,
      sql: `
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      app_user_id TEXT NOT NULL,
      oauth_client_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      creator_id TEXT,
      comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
      source_comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      phase TEXT NOT NULL CHECK(phase IN ('pending','active','awaitingInput','complete','error','stopping')),
      summary TEXT,
      plan TEXT CHECK(plan IS NULL OR json_valid(plan)),
      external_urls TEXT NOT NULL CHECK(json_valid(external_urls)),
      external_link TEXT,
      UNIQUE(organization_id, id),
      FOREIGN KEY(organization_id, issue_id) REFERENCES issues(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY(organization_id, team_id) REFERENCES teams(organization_id, id),
      FOREIGN KEY(organization_id, app_user_id) REFERENCES users(organization_id, id),
      FOREIGN KEY(organization_id, creator_id) REFERENCES users(organization_id, id)
    );
    CREATE TABLE agent_activities (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      content TEXT NOT NULL CHECK(json_valid(content)),
      ephemeral INTEGER NOT NULL CHECK(ephemeral IN (0,1)),
      signal TEXT,
      signal_metadata TEXT,
      source_comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
      FOREIGN KEY(organization_id, session_id) REFERENCES agent_sessions(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY(organization_id, user_id) REFERENCES users(organization_id, id)
    );
    CREATE TRIGGER agent_activity_immutable BEFORE UPDATE OF id, organization_id, session_id, user_id, created_at, content, ephemeral, signal, signal_metadata ON agent_activities BEGIN SELECT RAISE(ABORT, 'Agent activities are immutable'); END;
    CREATE INDEX agent_session_issue ON agent_sessions(organization_id, issue_id, created_at, id);
    CREATE INDEX agent_activity_session ON agent_activities(session_id, created_at, id);
  `,
    },
  ],
};

export const agentsResetOwner: ResetOwner = {
  clear(tx) {
    tx.run("DELETE FROM agent_activities");
    tx.run("DELETE FROM agent_sessions");
  },
};
