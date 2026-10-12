import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreMigrations, openDatabase, type Transaction } from "../../src/core/database";
import { createRuntime, resetRuntime, type Runtime } from "../../src/core/runtime";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { createAppUser } from "../../src/workspace/directory";

const directories: string[] = [];
const runtimes: Runtime[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "finear-base-"));
  directories.push(directory);
  const path = join(directory, "workspace.sqlite");
  const runtime = createRuntime({ databasePath: path, clockSource: () => fixtureTime });
  runtimes.push(runtime);
  resetRuntime(runtime);
  return { runtime, path };
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const appId = "30000000-0000-4000-8000-000000000001";
function addApp(tx: Transaction) {
  createAppUser(tx, {
    id: appId,
    organizationId: fixtureIds.primary.organization,
    name: "Agent",
    email: "agent@example.test",
    createdAt: fixtureTime,
  });
  return tx.appendEvent({
    organizationId: fixtureIds.primary.organization,
    resourceType: "OAuthApp",
    action: "installed",
    occurredAt: fixtureTime,
    data: { appUserId: appId },
  });
}

describe("persistent runtime", () => {
  test("commits directory and outbox atomically and reopens with clock offset", () => {
    const { runtime, path } = setup();
    const eventId = runtime.database.transaction(addApp);
    runtime.clock.advance(60000);
    runtime.close();
    const reopened = createRuntime({ databasePath: path, clockSource: () => fixtureTime });
    runtimes.push(reopened);
    expect(
      reopened.database.query<{ app: number }>("SELECT app FROM users WHERE id = ?").get(appId)
        ?.app,
    ).toBe(1);
    expect(reopened.database.query<{ id: string }>("SELECT id FROM outbox").get()?.id).toBe(
      eventId,
    );
    expect(reopened.clock.now()).toBe(fixtureTime + 60000);
    expect(
      reopened.database.query<{ offset_ms: number }>("SELECT offset_ms FROM clock").get()
        ?.offset_ms,
    ).toBe(60000);
  });

  test("rolls back entities and outbox together, including across reopen", () => {
    const { runtime, path } = setup();
    expect(() =>
      runtime.database.transaction((tx) => {
        addApp(tx);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    runtime.close();
    const reopened = createRuntime({ databasePath: path });
    runtimes.push(reopened);
    expect(reopened.database.query("SELECT id FROM users WHERE id = ?").get(appId)).toBeNull();
    expect(reopened.database.query("SELECT id FROM outbox").all()).toEqual([]);
  });

  test("rejects async transactions and invalidates handles and prepared queries", async () => {
    const { runtime } = setup();
    let retained!: Transaction;
    let query!: ReturnType<Transaction["query"]>;
    expect(() =>
      runtime.database.transaction((tx) => {
        retained = tx;
        query = tx.query("SELECT id FROM users");
        addApp(tx);
        return Promise.resolve("not synchronous");
      }),
    ).toThrow("synchronous");
    expect(() => retained.run("DELETE FROM users")).toThrow("completed");
    expect(() =>
      retained.appendEvent({
        organizationId: "x",
        resourceType: "Issue",
        action: "create",
        occurredAt: fixtureTime,
        data: {},
      }),
    ).toThrow("completed");
    expect(() => query.all()).toThrow("completed");
    expect(runtime.database.query("SELECT id FROM outbox").all()).toEqual([]);
    let continuationError: unknown;
    expect(() =>
      runtime.database.transaction(async (tx) => {
        await Promise.resolve();
        try {
          tx.run("DELETE FROM users");
        } catch (error) {
          continuationError = error;
        }
      }),
    ).toThrow("synchronous");
    await Promise.resolve();
    expect(String(continuationError)).toContain("completed");
    expect(runtime.database.query("SELECT id FROM users").all()).toHaveLength(2);
  });

  test("invalidates successful transaction handles and rejects nested writes", () => {
    const { runtime } = setup();
    let retained!: Transaction;
    runtime.database.transaction((tx) => {
      retained = tx;
    });
    expect(() => retained.query("SELECT 1").get()).toThrow("completed");
    expect(() =>
      runtime.database.transaction(() => runtime.database.transaction(() => {})),
    ).toThrow("active transaction");
    expect(runtime.database.query("SELECT id FROM organizations").all()).toHaveLength(2);
  });

  test("read surface cannot write, foreign keys reject cross-workspace membership", () => {
    const { runtime } = setup();
    expect(() => runtime.database.query("DELETE FROM users RETURNING id").all()).toThrow();
    expect(() => runtime.database.query("PRAGMA query_only = OFF").all()).toThrow();
    expect(() =>
      runtime.database
        .query("WITH names AS (SELECT id FROM users) DELETE FROM users RETURNING id")
        .all(),
    ).toThrow();
    expect(() =>
      runtime.database.transaction((tx) => {
        tx.run(
          "INSERT INTO team_memberships (organization_id, team_id, user_id) VALUES (?, ?, ?)",
          fixtureIds.primary.organization,
          fixtureIds.primary.team,
          fixtureIds.secondary.user,
        );
      }),
    ).toThrow();
    expect(() =>
      runtime.database.transaction((tx) => {
        tx.run(
          "INSERT INTO teams (id, organization_id, name, key, created_at) VALUES (?, ?, ?, ?, ?)",
          "bad",
          "missing",
          "Invalid",
          "BAD",
          fixtureTime,
        );
      }),
    ).toThrow();
    expect(runtime.database.query("SELECT id FROM users").all()).toHaveLength(2);
  });

  test("clock validates advances and reset restores identical fixtures atomically", () => {
    const { runtime } = setup();
    const before = runtime.database.query("SELECT * FROM users ORDER BY id").all();
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => runtime.clock.advance(value)).toThrow();
    }
    expect(runtime.clock.now()).toBe(fixtureTime);
    runtime.database.transaction(addApp);
    runtime.clock.advance(100);
    resetRuntime(runtime);
    expect(runtime.database.query("SELECT * FROM users ORDER BY id").all()).toEqual(before);
    expect(runtime.clock.now()).toBe(fixtureTime);
    expect(runtime.database.query("SELECT * FROM outbox").all()).toEqual([]);
    runtime.database.transaction(addApp);
    runtime.clock.advance(123);
    const previousUsers = runtime.database.query("SELECT * FROM users ORDER BY id").all();
    const previousOutbox = runtime.database.query("SELECT * FROM outbox").all();
    expect(() =>
      resetRuntime(runtime, [
        {
          clear: () => {},
          seed: () => {
            throw new Error("seed failed");
          },
        },
      ]),
    ).toThrow("seed failed");
    expect(runtime.database.query("SELECT * FROM users ORDER BY id").all()).toEqual(previousUsers);
    expect(runtime.database.query("SELECT * FROM outbox").all()).toEqual(previousOutbox);
    expect(runtime.clock.now()).toBe(fixtureTime + 123);
  });

  test("captures transaction time once and allocates durable sync IDs lazily with rollback", () => {
    const { runtime, path } = setup();
    runtime.database.transaction((tx) => {
      expect(tx.now).toBe(fixtureTime);
      expect(tx.now).toBe(tx.now);
    });
    expect(
      runtime.database.query<{ value: number }>("SELECT value FROM sync_sequence").get()?.value,
    ).toBe(0);
    expect(
      runtime.database.transaction((tx) => {
        expect(tx.syncId).toBe(tx.syncId);
        return tx.syncId;
      }),
    ).toBe(1);
    expect(() =>
      runtime.database.transaction((tx) => {
        expect(tx.syncId).toBe(2);
        throw new Error("abort sync");
      }),
    ).toThrow("abort sync");
    expect(runtime.database.transaction((tx) => tx.syncId)).toBe(2);
    runtime.close();
    const reopened = createRuntime({ databasePath: path, clockSource: () => fixtureTime });
    runtimes.push(reopened);
    expect(reopened.database.transaction((tx) => tx.syncId)).toBe(3);
    resetRuntime(reopened);
    expect(reopened.database.transaction((tx) => tx.syncId)).toBe(1);
  });

  test("captures an advancing source only once for each transaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "finear-clock-source-"));
    directories.push(directory);
    let sourceTime = fixtureTime;
    const runtime = createRuntime({
      databasePath: join(directory, "source.sqlite"),
      clockSource: () => sourceTime++,
    });
    runtimes.push(runtime);
    runtime.database.transaction((tx) => {
      const first = tx.now;
      expect(tx.now).toBe(first);
      expect(sourceTime).toBe(first + 1);
    });
  });

  test("freezes actor and source outbox snapshots at append time", () => {
    const { runtime } = setup();
    const actor = { id: fixtureIds.primary.user, name: "Before" };
    const source = { client: "fixture" };
    runtime.database.transaction((tx) => {
      tx.appendEvent({
        organizationId: fixtureIds.primary.organization,
        resourceType: "User",
        action: "update",
        occurredAt: tx.now,
        actor,
        source,
        data: { name: "snapshot" },
      });
      actor.name = "After";
      source.client = "changed";
    });
    const row = runtime.database
      .query<{ actor: string; source: string }>("SELECT actor, source FROM outbox")
      .get();
    expect(JSON.parse(row!.actor).name).toBe("Before");
    expect(JSON.parse(row!.source).client).toBe("fixture");
  });

  test("owner migrations are checksummed, consecutive and atomic per owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "finear-migrations-"));
    directories.push(directory);
    const db = openDatabase(join(directory, "migrations.sqlite"));
    try {
      db.migrate([coreMigrations]);
      const first = { version: 1, sql: "CREATE TABLE owner_data (id TEXT PRIMARY KEY);" };
      db.migrate([{ owner: "test", migrations: [first] }]);
      db.migrate([{ owner: "test", migrations: [first] }]);
      expect(() =>
        db.migrate([{ owner: "test", migrations: [{ ...first, sql: first.sql + " " }] }]),
      ).toThrow("checksum");
      expect(() => db.migrate([{ owner: "test", migrations: [] }])).toThrow("newer");
      expect(() =>
        db.migrate([{ owner: "bad-order", migrations: [{ version: 2, sql: "SELECT 1;" }] }]),
      ).toThrow("consecutive");
      expect(() =>
        db.migrate([
          {
            owner: "atomic",
            migrations: [
              { version: 1, sql: "CREATE TABLE rolled_back (id TEXT);" },
              { version: 2, sql: "invalid sql" },
            ],
          },
        ]),
      ).toThrow();
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'rolled_back'").all()).toEqual(
        [],
      );
      expect(db.query("SELECT * FROM migrations WHERE owner = 'atomic'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
