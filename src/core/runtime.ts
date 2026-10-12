import { createClock, type AdjustableClock } from "./clock";
import {
  coreMigrations,
  openDatabase,
  type Database,
  type MigrationSet,
  type Transaction,
} from "./database";
import { workspaceMigrations } from "../workspace/schema";
import { seedWorkspace } from "../workspace/fixtures";

export interface Runtime {
  database: Database;
  clock: AdjustableClock;
  close(): void;
}

export interface RuntimeOptions {
  databasePath: string;
  clockSource?: () => number;
  migrations?: readonly MigrationSet[];
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const database = openDatabase(options.databasePath, options.clockSource);
  try {
    database.migrate([coreMigrations, workspaceMigrations, ...(options.migrations ?? [])]);
    const clock = createClock(database, options.clockSource);
    return { database, clock, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}

export interface ResetOwner {
  clear(tx: Transaction): void;
  seed?(tx: Transaction): void;
}

export function resetRuntime(runtime: Runtime, owners: readonly ResetOwner[] = []): void {
  runtime.database.transaction((tx) => {
    for (const owner of [...owners].reverse()) owner.clear(tx);
    for (const table of [
      "team_memberships",
      "workflow_states",
      "project_statuses",
      "teams",
      "users",
      "organizations",
      "outbox",
    ]) {
      tx.run(`DELETE FROM ${table}`);
    }
    tx.run("DELETE FROM sqlite_sequence WHERE name = 'outbox'");
    tx.run("UPDATE clock SET offset_ms = 0 WHERE id = 1");
    tx.run("UPDATE sync_sequence SET value = 0 WHERE id = 1");
    seedWorkspace(tx);
    for (const owner of owners) owner.seed?.(tx);
  });
}
