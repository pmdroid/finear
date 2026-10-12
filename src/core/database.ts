import { Database as SQLite, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { DomainError } from "./errors";

export type SqlValue = SQLQueryBindings;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Query<T> {
  get(...bindings: SqlValue[]): T | null;
  all(...bindings: SqlValue[]): T[];
}

export interface ReadDatabase {
  query<T>(sql: string): Query<T>;
}

export interface EventInput {
  organizationId: string;
  teamId?: string | null;
  resourceType: string;
  action: string;
  actorId?: string | null;
  occurredAt: number;
  data: JsonObject;
  updatedFrom?: JsonObject;
  targetAppUserId?: string | null;
  oauthClientId?: string | null;
  actor?: JsonObject;
  source?: JsonObject;
}

export interface OutboxEvent extends EventInput {
  id: string;
}

export interface Transaction extends ReadDatabase {
  readonly now: number;
  readonly syncId: number;
  run(sql: string, ...bindings: SqlValue[]): void;
  appendEvent(event: EventInput): string;
}

export interface Migration {
  version: number;
  sql: string;
}

export interface MigrationSet {
  owner: string;
  migrations: readonly Migration[];
}

export interface Database extends ReadDatabase {
  transaction<T>(work: (tx: Transaction) => T, time?: number): T;
  migrate(sets: readonly MigrationSet[]): void;
  close(): void;
}

export const coreMigrations: MigrationSet = {
  owner: "core",
  migrations: [
    {
      version: 1,
      sql: `
    CREATE TABLE clock (id INTEGER PRIMARY KEY CHECK (id = 1), offset_ms INTEGER NOT NULL CHECK (offset_ms >= 0));
    INSERT INTO clock (id, offset_ms) VALUES (1, 0);
    CREATE TABLE sync_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
    INSERT INTO sync_sequence VALUES (1, 0);
    CREATE TABLE outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL,
      team_id TEXT,
      resource_type TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      occurred_at INTEGER NOT NULL,
      data TEXT NOT NULL CHECK (json_valid(data)),
      updated_from TEXT CHECK (updated_from IS NULL OR json_valid(updated_from)),
      target_app_user_id TEXT,
      oauth_client_id TEXT,
      actor TEXT CHECK (actor IS NULL OR json_valid(actor)),
      source TEXT CHECK (source IS NULL OR json_valid(source))
    );
    CREATE INDEX outbox_organization_sequence ON outbox (organization_id, sequence);
  `,
    },
  ],
};

export function openDatabase(path: string, source: () => number = Date.now): Database {
  const sqlite = new SQLite(path, { create: true, strict: true });
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 5000");
  sqlite.run(`CREATE TABLE IF NOT EXISTS migrations (
    owner TEXT NOT NULL,
    version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    PRIMARY KEY (owner, version)
  )`);
  let closed = false;
  let inTransaction = false;

  function ensureOpen() {
    if (closed) throw new DomainError("CONFLICT", "Database is closed");
  }

  function query<T>(sql: string, ensureActive: () => void, readOnly: boolean): Query<T> {
    function execute<R>(operation: () => R): R {
      ensureOpen();
      ensureActive();
      if (readOnly && !/^\s*(SELECT|WITH|EXPLAIN)\b/i.test(sql)) {
        throw new DomainError("INVALID_INPUT", "Read queries must use SELECT, WITH, or EXPLAIN");
      }
      if (readOnly) sqlite.run("PRAGMA query_only = ON");
      try {
        return operation();
      } finally {
        if (readOnly) sqlite.run("PRAGMA query_only = OFF");
      }
    }
    return {
      get: (...bindings) => execute(() => sqlite.query<T, SqlValue[]>(sql).get(...bindings)),
      all: (...bindings) => execute(() => sqlite.query<T, SqlValue[]>(sql).all(...bindings)),
    };
  }

  const database: Database = {
    query: <T>(sql: string) => query<T>(sql, () => {}, true),
    transaction<T>(work: (tx: Transaction) => T, time?: number): T {
      ensureOpen();
      if (inTransaction)
        throw new DomainError("CONFLICT", "Pass the active transaction to composed writes");
      let active = true;
      function ensureActive() {
        if (!active) throw new DomainError("CONFLICT", "Transaction has completed");
      }
      const initialized = sqlite.query("SELECT name FROM sqlite_master WHERE name = 'clock'").get();
      const offset = initialized
        ? (sqlite.query<{ offset_ms: number }, []>("SELECT offset_ms FROM clock WHERE id = 1").get()
            ?.offset_ms ?? 0)
        : 0;
      const capturedTime = time ?? source() + offset;
      if (!Number.isSafeInteger(capturedTime) || capturedTime < 0)
        throw new DomainError("INVALID_INPUT", "Transaction time must be epoch milliseconds");
      let syncId: number | undefined;
      const tx: Transaction = {
        get now() {
          ensureActive();
          return capturedTime;
        },
        get syncId() {
          ensureActive();
          if (syncId === undefined) {
            const row = sqlite
              .query<{ value: number }, []>(
                "UPDATE sync_sequence SET value = value + 1 WHERE id = 1 RETURNING value",
              )
              .get();
            if (!row || !Number.isSafeInteger(row.value))
              throw new DomainError("CONFLICT", "Sync sequence exhausted");
            syncId = row.value;
          }
          return syncId;
        },
        query: <R>(sql: string) => query<R>(sql, ensureActive, false),
        run(sql, ...bindings) {
          ensureActive();
          sqlite.query(sql).run(...bindings);
        },
        appendEvent(event) {
          ensureActive();
          if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) {
            throw new DomainError(
              "INVALID_INPUT",
              "Event occurrence time must be epoch milliseconds",
            );
          }
          const id = crypto.randomUUID();
          tx.run(
            `INSERT INTO outbox
            (id, organization_id, team_id, resource_type, action, actor_id, occurred_at, data, updated_from, target_app_user_id, oauth_client_id, actor, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            event.organizationId,
            event.teamId ?? null,
            event.resourceType,
            event.action,
            event.actorId ?? null,
            event.occurredAt,
            JSON.stringify(event.data),
            event.updatedFrom === undefined ? null : JSON.stringify(event.updatedFrom),
            event.targetAppUserId ?? null,
            event.oauthClientId ?? null,
            event.actor === undefined ? null : JSON.stringify(event.actor),
            event.source === undefined ? null : JSON.stringify(event.source),
          );
          return id;
        },
      };
      inTransaction = true;
      try {
        return sqlite
          .transaction(() => {
            const result = work(tx);
            if (
              result !== null &&
              (typeof result === "object" || typeof result === "function") &&
              "then" in result
            ) {
              Promise.resolve(result).catch(() => {});
              throw new DomainError("INVALID_INPUT", "Transaction callbacks must be synchronous");
            }
            return result;
          })
          .immediate();
      } finally {
        active = false;
        inTransaction = false;
      }
    },
    migrate(sets) {
      const owners = new Set<string>();
      for (const set of sets) {
        if (owners.has(set.owner)) throw new DomainError("CONFLICT", "Duplicate migration owner");
        owners.add(set.owner);
        database.transaction((tx) => {
          const applied = tx
            .query<{ version: number; checksum: string }>(
              "SELECT version, checksum FROM migrations WHERE owner = ? ORDER BY version",
            )
            .all(set.owner);
          if (applied.length > set.migrations.length)
            throw new DomainError("CONFLICT", "Database migration version is newer than source");
          for (const [index, migration] of set.migrations.entries()) {
            if (migration.version !== index + 1)
              throw new DomainError(
                "INVALID_INPUT",
                "Migration versions must start at one and be consecutive",
              );
            const checksum = createHash("sha256").update(migration.sql).digest("hex");
            const previous = applied[index];
            if (previous) {
              if (previous.version !== migration.version || previous.checksum !== checksum) {
                throw new DomainError(
                  "CONFLICT",
                  "Applied migration checksum does not match source",
                );
              }
            } else {
              sqlite.run(migration.sql);
              tx.run(
                "INSERT INTO migrations (owner, version, checksum) VALUES (?, ?, ?)",
                set.owner,
                migration.version,
                checksum,
              );
            }
          }
        });
      }
    },
    close() {
      if (inTransaction) throw new DomainError("CONFLICT", "Cannot close an active transaction");
      if (!closed) {
        sqlite.close();
        closed = true;
      }
    },
  };
  return database;
}
