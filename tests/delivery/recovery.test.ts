import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { createAppUser } from "../../src/workspace/directory";
import {
  createDelivery,
  deliveryMigrations,
  deliveryResetOwner,
  provisionAppWebhook,
} from "../../src/delivery";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const ids = fixtureIds.primary;
const appId = "30000000-0000-4000-8000-000000000001";

test("provisioning shares active transaction, rolls back and idempotently updates the concrete app registration", async () => {
  const runtime = createRuntime({ databasePath: ":memory:", migrations: [deliveryMigrations] });
  const delivery = createDelivery(runtime);
  try {
    resetRuntime(runtime, [deliveryResetOwner]);
    const input = {
      organizationId: ids.organization,
      oauthClientId: "client",
      appUserId: appId,
      url: "http://127.0.0.1:1",
      secret: "secret",
      resourceTypes: ["Issue"],
      agentSessionEvents: true,
    };
    expect(() =>
      runtime.database.transaction((tx) => {
        createAppUser(tx, {
          id: appId,
          organizationId: ids.organization,
          name: "App",
          email: "app@example.test",
          createdAt: tx.now,
        });
        provisionAppWebhook(tx, input);
        throw new Error("abort installation");
      }),
    ).toThrow("abort installation");
    expect(runtime.database.query("SELECT id FROM webhook_subscriptions").all()).toEqual([]);
    expect(runtime.database.query("SELECT id FROM users WHERE id = ?").get(appId)).toBeNull();
    runtime.database.transaction((tx) =>
      createAppUser(tx, {
        id: appId,
        organizationId: ids.organization,
        name: "App",
        email: "app@example.test",
        createdAt: tx.now,
      }),
    );
    const first = runtime.database.transaction((tx) => provisionAppWebhook(tx, input));
    const second = runtime.database.transaction((tx) =>
      delivery.provisionAppWebhook(tx, { ...input, secret: "updated" }),
    );
    expect(second).toBe(first);
    expect(
      runtime.database.query<{ secret: string }>("SELECT secret FROM webhook_subscriptions").all(),
    ).toEqual([{ secret: "updated" }]);
  } finally {
    await delivery.close();
    runtime.close();
  }
});

test("durable unfinished attempt is inspected and scheduled after reopen rather than lost or acknowledged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finear-delivery-recovery-"));
  directories.push(directory);
  const path = join(directory, "workspace.sqlite");
  let runtime = createRuntime({
    databasePath: path,
    clockSource: () => fixtureTime,
    migrations: [deliveryMigrations],
  });
  let delivery = createDelivery(runtime);
  try {
    resetRuntime(runtime, [deliveryResetOwner]);
    runtime.database.transaction((tx) => {
      const eventId = tx.appendEvent({
        organizationId: ids.organization,
        resourceType: "Issue",
        action: "create",
        occurredAt: tx.now,
        data: { id: "issue" },
      });
      tx.run("UPDATE webhook_progress SET sequence = (SELECT max(sequence) FROM outbox)");
      tx.run(
        `INSERT INTO webhook_deliveries (id, event_id, subscription_id, organization_id, url, secret, resource_type, envelope, occurred_at, due_at, status)
        VALUES ('delivery', ?, 'subscription', ?, 'http://127.0.0.1:1', 'secret', 'Issue', '{}', ?, ?, 'pending')`,
        eventId,
        ids.organization,
        tx.now,
        tx.now,
      );
      tx.run(
        `INSERT INTO webhook_attempts (id, delivery_id, number, sent_at, body, headers)
        VALUES ('attempt', 'delivery', 1, ?, '{}', '{}')`,
        tx.now,
      );
    });
    await delivery.close();
    runtime.close();
    runtime = createRuntime({
      databasePath: path,
      clockSource: () => fixtureTime,
      migrations: [deliveryMigrations],
    });
    delivery = createDelivery(runtime);
    await delivery.runDue();
    expect(delivery.attempts("delivery")[0]!.error).toBe("Interrupted before acknowledgment");
    expect(delivery.nextDueAt()).toBe(fixtureTime + 60_000);
    runtime.clock.advance(60_000);
    await delivery.runDue();
    expect(delivery.attempts("delivery")).toHaveLength(2);
    expect(delivery.attempts("delivery")[1]!.error).toBe("Network request failed");
    expect(delivery.nextDueAt()).toBe(fixtureTime + 60_000 + 3_600_000);
  } finally {
    await delivery.close();
    runtime.close();
  }
});
