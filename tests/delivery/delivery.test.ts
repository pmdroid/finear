import { afterEach, expect, test } from "bun:test";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "../../src/core/database";
import type { Principal } from "../../src/core/principal";
import { createRuntime, resetRuntime, type Runtime } from "../../src/core/runtime";
import { fixtureIds } from "../../src/workspace/fixtures";
import { createAppUser } from "../../src/workspace/directory";
import {
  createDelivery,
  deliveryMigrations,
  deliveryResetOwner,
  provisionAppWebhook,
  retryDelays,
  type Delivery,
} from "../../src/delivery";
import {
  createSubscription,
  updateSubscription,
  deleteSubscription,
} from "../../src/delivery/subscriptions";

const ids = fixtureIds.primary;
const appA = "30000000-0000-4000-8000-000000000001";
const appB = "30000000-0000-4000-8000-000000000002";
const principal: Principal = {
  organizationId: ids.organization,
  userId: ids.user,
  actor: "apiKey",
  oauthClientId: null,
  installationId: null,
  grantId: null,
  scopes: ["read", "write"],
  teamIds: [ids.team],
  admin: true,
};
const directories: string[] = [];
const runtimes: Runtime[] = [];
const deliveries: Delivery[] = [];
const receivers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const delivery of deliveries.splice(0)) await delivery.close();
  for (const receiver of receivers.splice(0)) await receiver.stop(true);
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "finear-delivery-"));
  directories.push(directory);
  const path = join(directory, "workspace.sqlite");
  const now = Date.now();
  const reopen = () => {
    const runtime = createRuntime({
      databasePath: path,
      clockSource: () => now,
      migrations: [deliveryMigrations],
    });
    runtimes.push(runtime);
    const delivery = createDelivery(runtime);
    deliveries.push(delivery);
    return { runtime, delivery };
  };
  const initial = reopen();
  resetRuntime(initial.runtime, [deliveryResetOwner]);
  return { ...initial, reopen, now };
}
function receiver(status = 200, delay = 0) {
  const captures: { body: string; headers: Headers; method: string }[] = [];
  const state = { status };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captures.push({
        body: await request.text(),
        headers: request.headers,
        method: request.method,
      });
      if (delay) await Bun.sleep(delay);
      return new Response("receiver", { status: state.status });
    },
  });
  receivers.push(server);
  return { url: server.url.href, captures, state };
}
function subscribe(runtime: Runtime, url: string, extra: Record<string, unknown> = {}) {
  return createSubscription(runtime, principal, {
    url,
    secret: "signing-secret",
    resourceTypes: ["Issue", "Project", "Comment"],
    allPublicTeams: true,
    ...extra,
  }).webhook.id;
}
function append(runtime: Runtime, overrides: Partial<EventInput> = {}) {
  return runtime.database.transaction((tx) =>
    tx.appendEvent({
      organizationId: ids.organization,
      teamId: ids.team,
      resourceType: "Issue",
      action: "update",
      occurredAt: tx.now - 2000,
      data: {
        id: "issue-snapshot",
        title: "Frozen title",
        url: "https://linear.app/eng/issue/ENG-1",
      },
      updatedFrom: { title: "Earlier title" },
      actor: { id: ids.user, name: "Human 1", type: "user" },
      ...overrides,
    }),
  );
}
function app(
  runtime: Runtime,
  url: string,
  appUserId = appA,
  clientId = "client-a",
  events = true,
) {
  return runtime.database.transaction((tx) => {
    createAppUser(tx, {
      id: appUserId,
      organizationId: ids.organization,
      name: "App",
      email: `${appUserId}@example.test`,
      createdAt: tx.now,
    });
    return provisionAppWebhook(tx, {
      organizationId: ids.organization,
      oauthClientId: clientId,
      appUserId,
      url,
      secret: "app-secret",
      resourceTypes: ["Issue"],
      agentSessionEvents: events,
    });
  });
}

test("real native receiver observes exact signed bytes and SDK rejects stale and tampered bodies", async () => {
  const { runtime, delivery, now } = setup();
  const target = receiver();
  const subscriptionId = subscribe(runtime, target.url);
  const eventId = append(runtime);
  expect(delivery.nextDueAt()).toBe(now);
  await delivery.runDue();
  expect(target.captures).toHaveLength(1);
  const capture = target.captures[0]!;
  const body = JSON.parse(capture.body);
  expect(body).toEqual({
    type: "Issue",
    action: "update",
    organizationId: ids.organization,
    webhookId: subscriptionId,
    createdAt: new Date(now - 2000).toISOString(),
    webhookTimestamp: now,
    data: {
      id: "issue-snapshot",
      title: "Frozen title",
      url: "https://linear.app/eng/issue/ENG-1",
    },
    url: "https://linear.app/eng/issue/ENG-1",
    updatedFrom: { title: "Earlier title" },
    actor: { id: ids.user, name: "Human 1", type: "user" },
  });
  expect(capture.method).toBe("POST");
  expect(capture.headers.get("content-type")).toBe("application/json");
  expect(capture.headers.get("user-agent")).toBe("Linear-Webhook");
  expect(capture.headers.get("linear-event")).toBe("Issue");
  expect(capture.headers.get("linear-timestamp")).toBe(String(now));
  expect(capture.headers.get("linear-delivery")).toBe(delivery.deliveries()[0]!.id);
  expect(delivery.deliveries()[0]!.event_id).toBe(eventId);
  const verifier = new LinearWebhookClient("signing-secret");
  const signature = capture.headers.get("linear-signature")!;
  expect(signature).toBe(createHmac("sha256", "signing-secret").update(capture.body).digest("hex"));
  expect(verifier.verify(Buffer.from(capture.body), signature)).toBe(true);
  expect(() => verifier.verify(Buffer.from(capture.body + " "), signature)).toThrow("signature");
  const stale = JSON.stringify({ ...body, webhookTimestamp: Date.now() - 120_000 });
  expect(() =>
    verifier.verify(
      Buffer.from(stale),
      createHmac("sha256", "signing-secret").update(stale).digest("hex"),
      String(Date.now()),
    ),
  ).toThrow("timestamp");
  const missingTimestamp = JSON.stringify({ type: "Issue" });
  expect(() =>
    verifier.verify(
      Buffer.from(missingTimestamp),
      createHmac("sha256", "signing-secret").update(missingTimestamp).digest("hex"),
      String(Date.now()),
    ),
  ).toThrow("timestamp");
  expect(delivery.nextDueAt()).toBeNull();
  expect(delivery.attempts()[0]!.http_status).toBe(200);
});

test("only HTTP 200 acknowledges; three retries are sequential virtual delays with stable delivery identity", async () => {
  const { runtime, delivery, now } = setup();
  const target = receiver(204);
  const subscriptionId = subscribe(runtime, target.url);
  append(runtime);
  await delivery.runDue();
  const original = delivery.deliveries()[0]!;
  updateSubscription(runtime, principal, subscriptionId, {
    secret: "new-secret",
    url: "http://127.0.0.1:1",
  });
  let time = now;
  for (const delay of retryDelays) {
    expect(delivery.nextDueAt()).toBe(time + delay);
    runtime.clock.advance(delay - 1);
    await delivery.runDue();
    expect(target.captures).toHaveLength(delivery.attempts().length);
    runtime.clock.advance(1);
    time += delay;
    await delivery.runDue();
    const sent = target.captures.at(-1)!;
    expect(sent.headers.get("linear-timestamp")).toBe(String(time));
    expect(sent.headers.get("linear-delivery")).toBe(original.id);
    const body = JSON.parse(sent.body);
    expect(body.createdAt).toBe(new Date(now - 2000).toISOString());
    expect(body.data.title).toBe("Frozen title");
    expect(sent.headers.get("linear-signature")).toBe(
      createHmac("sha256", "signing-secret").update(sent.body).digest("hex"),
    );
  }
  expect(delivery.attempts().map((attempt) => attempt.number)).toEqual([1, 2, 3, 4]);
  expect(new Set(delivery.attempts().map((attempt) => attempt.id)).size).toBe(4);
  expect(target.captures).toHaveLength(4);
  expect(delivery.deliveries()[0]!.status).toBe("exhausted");
  expect(delivery.nextDueAt()).toBeNull();
  await delivery.runDue();
  expect(target.captures).toHaveLength(4);
});

test("reopen resumes committed fanout with fixed recipients and stops retrying after acknowledgment", async () => {
  const { runtime, delivery, reopen } = setup();
  const target = receiver(500);
  const subscriptionId = subscribe(runtime, target.url);
  append(runtime, {
    resourceType: "Project",
    data: { id: "project-1", name: "Original" },
    teamId: null,
    source: { teamIds: [ids.team] },
  });
  await delivery.runDue();
  const original = delivery.deliveries()[0]!;
  deleteSubscription(runtime, principal, subscriptionId);
  await delivery.close();
  runtime.close();
  const resumed = reopen();
  subscribe(resumed.runtime, target.url);
  resumed.runtime.clock.advance(60_000);
  target.state.status = 200;
  await resumed.delivery.runDue();
  expect(target.captures).toHaveLength(2);
  expect(resumed.delivery.deliveries()).toHaveLength(1);
  expect(resumed.delivery.deliveries()[0]!.id).toBe(original.id);
  expect(resumed.delivery.deliveries()[0]!.status).toBe("acknowledged");
  expect(JSON.parse(target.captures[1]!.body).data).toEqual({ id: "project-1", name: "Original" });
  resumed.runtime.clock.advance(30_000_000);
  await resumed.delivery.runDue();
  expect(target.captures).toHaveLength(2);
});

test("outbox commits survive reopen and rolled-back events never fan out", async () => {
  const { runtime, delivery, reopen } = setup();
  const target = receiver();
  subscribe(runtime, target.url);
  append(runtime, { resourceType: "Comment", data: { id: "comment-1", body: "Frozen comment" } });
  expect(() =>
    runtime.database.transaction((tx) => {
      tx.appendEvent({
        organizationId: ids.organization,
        resourceType: "Issue",
        action: "create",
        occurredAt: tx.now,
        data: { id: "aborted" },
      });
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  await delivery.close();
  runtime.close();
  const resumed = reopen();
  await resumed.delivery.runDue();
  expect(target.captures).toHaveLength(1);
  expect(JSON.parse(target.captures[0]!.body).data).toEqual({
    id: "comment-1",
    body: "Frozen comment",
  });
});

test("team/public filters and organizations isolate subscriptions", async () => {
  const { runtime, delivery } = setup();
  const target = receiver();
  const publicId = subscribe(runtime, target.url);
  const teamId = subscribe(runtime, target.url, { teamId: "ENG", allPublicTeams: false });
  const organizationId = subscribe(runtime, target.url, { allPublicTeams: false });
  append(runtime, { data: { id: "public" } });
  append(runtime, { teamId: ids.privateTeam, data: { id: "private" } });
  append(runtime, {
    organizationId: fixtureIds.secondary.organization,
    teamId: fixtureIds.secondary.team,
    data: { id: "other-workspace" },
  });
  append(runtime, {
    teamId: null,
    resourceType: "Project",
    data: { id: "private-project" },
    source: { teamIds: [ids.privateTeam] },
  });
  await delivery.runDue();
  expect(delivery.deliveries().filter((row) => row.subscription_id === publicId)).toHaveLength(1);
  expect(delivery.deliveries().filter((row) => row.subscription_id === teamId)).toHaveLength(1);
  expect(
    delivery.deliveries().filter((row) => row.subscription_id === organizationId),
  ).toHaveLength(3);
  expect(
    target.captures.some((capture) => JSON.parse(capture.body).data.id === "other-workspace"),
  ).toBe(false);
});

test("owning app receives native session events and revocation before ordinary app events are disabled", async () => {
  const { runtime, delivery } = setup();
  const a = receiver();
  const b = receiver();
  const admin = receiver();
  const aId = app(runtime, a.url);
  app(runtime, b.url, appB, "client-b");
  subscribe(runtime, admin.url, { resourceTypes: ["AgentSessionEvent", "OAuthApp"] });
  const data = {
    agentSession: { id: "session-1", status: "pending" },
    promptContext: "Issue context",
  };
  append(runtime, {
    resourceType: "AgentSessionEvent",
    action: "created",
    targetAppUserId: appA,
    oauthClientId: "client-a",
    data,
  });
  append(runtime, {
    resourceType: "AgentSessionEvent",
    action: "prompted",
    targetAppUserId: appA,
    oauthClientId: "client-a",
    data: {
      agentSession: { id: "session-1" },
      agentActivity: { id: "activity-1", content: { type: "prompt", body: "Human reply" } },
    },
  });
  append(runtime, {
    resourceType: "AgentSessionEvent",
    action: "prompted",
    targetAppUserId: appA,
    oauthClientId: "client-b",
    data,
  });
  append(runtime, {
    resourceType: "OAuthApp",
    action: "revoked",
    targetAppUserId: appA,
    oauthClientId: "client-a",
    data: {},
  });
  append(runtime, { data: { id: "after-revocation" } });
  await delivery.runDue();
  expect(a.captures).toHaveLength(3);
  expect(admin.captures).toHaveLength(0);
  expect(b.captures).toHaveLength(1);
  const created = JSON.parse(a.captures[0]!.body);
  expect(created.agentSession).toEqual(data.agentSession);
  expect(created.data).toBeUndefined();
  expect(created.appUserId).toBe(appA);
  expect(created.oauthClientId).toBe("client-a");
  expect(created.webhookId).toBe(aId);
  const prompted = JSON.parse(a.captures[1]!.body);
  expect(prompted.agentActivity.content.body).toBe("Human reply");
  expect(prompted.agentActivity.body).toBeUndefined();
  const revoked = JSON.parse(a.captures[2]!.body);
  expect(revoked.type).toBe("OAuthApp");
  expect(revoked.action).toBe("revoked");
  expect(revoked.data).toBeUndefined();
  expect(revoked.oauthClientId).toBe("client-a");
  expect(
    runtime.database
      .query<{ enabled: number }>("SELECT enabled FROM webhook_subscriptions WHERE id = ?")
      .get(aId)!.enabled,
  ).toBe(0);
});

test("app session opt-in and private team membership are enforced for ordinary app events", async () => {
  const { runtime, delivery } = setup();
  const target = receiver();
  app(runtime, target.url, appA, "client-a", false);
  append(runtime, {
    resourceType: "AgentSessionEvent",
    action: "created",
    targetAppUserId: appA,
    oauthClientId: "client-a",
    data: { agentSession: { id: "session" } },
  });
  append(runtime, { teamId: ids.privateTeam });
  await delivery.runDue();
  expect(target.captures).toHaveLength(0);
  runtime.database.transaction((tx) =>
    tx.run(
      "INSERT INTO team_memberships VALUES (?, ?, ?)",
      ids.organization,
      ids.privateTeam,
      appA,
    ),
  );
  append(runtime, { teamId: ids.privateTeam });
  await delivery.runDue();
  expect(target.captures).toHaveLength(1);
});

test("concurrent drainage serializes HTTP outside SQLite transactions", async () => {
  const { runtime, delivery } = setup();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests++;
      runtime.database.transaction((tx) =>
        tx.run("UPDATE organizations SET name = name WHERE id = ?", ids.organization),
      );
      await Bun.sleep(20);
      return new Response("ok");
    },
  });
  receivers.push(server);
  subscribe(runtime, server.url.href);
  append(runtime);
  const second = createDelivery(runtime);
  deliveries.push(second);
  await Promise.all([delivery.runDue(), delivery.runDue(), second.runDue()]);
  expect(requests).toBe(1);
  expect(delivery.attempts()).toHaveLength(1);
  await delivery.close();
  await expect(delivery.runDue()).rejects.toThrow("closed");
});

test("response deadline is five real seconds even when virtual time is stationary", async () => {
  const { runtime, delivery, now } = setup();
  const target = receiver(200, 6000);
  subscribe(runtime, target.url);
  append(runtime);
  const start = performance.now();
  await delivery.runDue();
  const elapsed = performance.now() - start;
  expect(elapsed).toBeGreaterThanOrEqual(4900);
  expect(elapsed).toBeLessThan(5900);
  expect(runtime.clock.now()).toBe(now);
  expect(delivery.attempts()[0]!.error).toBe("Response deadline exceeded (5000ms)");
  expect(delivery.nextDueAt()).toBe(now + 60_000);
}, 10000);
