import type { MigrationSet } from "../core/database";
import type { ResetOwner } from "../core/runtime";

export const deliveryMigrations: MigrationSet = {
  owner: "delivery",
  migrations: [
    {
      version: 1,
      sql: `
      CREATE TABLE webhook_subscriptions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        creator_id TEXT,
        team_id TEXT,
        all_public_teams INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        label TEXT,
        resource_types TEXT NOT NULL CHECK(json_valid(resource_types)),
        app_user_id TEXT,
        oauth_client_id TEXT,
        agent_session_events INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (organization_id, creator_id) REFERENCES users(organization_id, id),
        FOREIGN KEY (organization_id, app_user_id) REFERENCES users(organization_id, id),
        FOREIGN KEY (organization_id, team_id) REFERENCES teams(organization_id, id),
        UNIQUE(organization_id, oauth_client_id, app_user_id)
      );
      CREATE TABLE webhook_progress (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL);
      INSERT INTO webhook_progress VALUES (1, 0);
      CREATE TABLE webhook_deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        envelope TEXT NOT NULL CHECK(json_valid(envelope)),
        occurred_at INTEGER NOT NULL,
        due_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending', 'acknowledged', 'exhausted')),
        UNIQUE(event_id, subscription_id)
      );
      CREATE INDEX webhook_due ON webhook_deliveries(due_at);
      CREATE TABLE webhook_attempts (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id),
        number INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        completed_at INTEGER,
        body TEXT NOT NULL,
        headers TEXT NOT NULL CHECK(json_valid(headers)),
        http_status INTEGER,
        error TEXT,
        UNIQUE(delivery_id, number)
      );
    `,
    },
  ],
};

export const deliveryResetOwner: ResetOwner = {
  clear(tx) {
    tx.run("DELETE FROM webhook_attempts");
    tx.run("DELETE FROM webhook_deliveries");
    tx.run("DELETE FROM webhook_subscriptions");
    tx.run("UPDATE webhook_progress SET sequence = 0 WHERE id = 1");
  },
};
