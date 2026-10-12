import type { MigrationSet } from "../core/database";

export const identityMigrations: MigrationSet = {
  owner: "identity",
  migrations: [
    {
      version: 1,
      sql: `
    CREATE TABLE oauth_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret_hash TEXT,
      redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
      scopes TEXT NOT NULL CHECK (json_valid(scopes)),
      webhook TEXT CHECK (webhook IS NULL OR json_valid(webhook))
    );
    CREATE TABLE oauth_consents (
      hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(id),
      parameters TEXT NOT NULL CHECK (json_valid(parameters)),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE oauth_installations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      client_id TEXT NOT NULL REFERENCES oauth_clients(id),
      app_user_id TEXT NOT NULL,
      installer_id TEXT NOT NULL,
      revoked_at INTEGER,
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, app_user_id) REFERENCES users(organization_id, id),
      FOREIGN KEY (organization_id, installer_id) REFERENCES users(organization_id, id)
    );
    CREATE UNIQUE INDEX oauth_active_installation ON oauth_installations(organization_id, client_id) WHERE revoked_at IS NULL;
    CREATE TABLE oauth_grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      client_id TEXT NOT NULL REFERENCES oauth_clients(id),
      user_id TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('user', 'app')),
      installation_id TEXT,
      scopes TEXT NOT NULL CHECK (json_valid(scopes)),
      team_ids TEXT NOT NULL CHECK (json_valid(team_ids)),
      pkce INTEGER NOT NULL CHECK (pkce IN (0, 1)),
      revoked_at INTEGER,
      FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id),
      FOREIGN KEY (organization_id, installation_id) REFERENCES oauth_installations(organization_id, id)
    );
    CREATE TABLE oauth_codes (
      hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
      redirect_uri TEXT NOT NULL,
      challenge TEXT,
      method TEXT,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE TABLE oauth_tokens (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
      access_hash TEXT NOT NULL UNIQUE,
      refresh_hash TEXT NOT NULL UNIQUE,
      access_expires_at INTEGER NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      rotated_at INTEGER,
      successor_id TEXT REFERENCES oauth_tokens(id),
      recovery_salt TEXT
    );
  `,
    },
  ],
};
