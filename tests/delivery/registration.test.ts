import { afterEach, expect, test } from "bun:test";
import { LinearClient } from "@linear/sdk";
import { buildASTSchema, GraphQLScalarType, print, validate } from "graphql";
import { createRuntime, resetRuntime, type Runtime } from "../../src/core/runtime";
import { fixtureIds } from "../../src/workspace/fixtures";
import { supportingResolvers } from "../../src/workspace/supporting";
import { authenticateFixture, fixtureApiKeys } from "../../src/identity/fixture";
import { composeResolvers, executeGraphQL, installResolvers } from "../../src/graphql/composition";
import { loadContract, operationDocument } from "../../src/graphql/contract";
import { deliveryMigrations, deliveryResetOwner, deliveryResolvers } from "../../src/delivery";
import {
  createSubscription,
  updateSubscription,
  subscription,
} from "../../src/delivery/subscriptions";
import type { Principal } from "../../src/core/principal";

const runtimes: Runtime[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const ids = fixtureIds.primary;
function setup() {
  const runtime = createRuntime({ databasePath: ":memory:", migrations: [deliveryMigrations] });
  runtimes.push(runtime);
  resetRuntime(runtime, [deliveryResetOwner]);
  const principal = authenticateFixture(
    new Request("http://localhost", { headers: { authorization: fixtureApiKeys.primary } }),
    runtime,
  );
  return { runtime, principal };
}

test("unchanged SDK registration CRUD and getter refetch execute full pinned webhook fragments over HTTP", async () => {
  const { runtime } = setup();
  const { source, documents } = await loadContract();
  const schema = buildASTSchema(source);
  installResolvers(schema, composeResolvers(supportingResolvers(), deliveryResolvers()), [
    new GraphQLScalarType({
      name: "DateTime",
      serialize: (value) =>
        new Date(typeof value === "number" ? value : String(value)).toISOString(),
    }),
  ]);
  for (const name of ["webhook", "webhooks", "createWebhook", "updateWebhook", "deleteWebhook"])
    expect(validate(schema, operationDocument(documents, name))).toEqual([]);
  const requests: { query: string; variables?: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const principal = authenticateFixture(request, runtime);
      const body = (await request.json()) as { query: string; variables?: Record<string, unknown> };
      requests.push(body);
      return Response.json(await executeGraphQL(schema, body, { runtime, principal }));
    },
  });
  servers.push(server);
  const client = new LinearClient({ apiUrl: server.url.href, apiKey: fixtureApiKeys.primary });
  const payload = await client.createWebhook({
    url: "http://127.0.0.1:12345/events",
    secret: "sdk-secret",
    resourceTypes: ["Issue"],
    teamId: "ENG",
    label: "Initial",
  });
  expect(payload.success).toBe(true);
  expect(payload.lastSyncId).toBeGreaterThan(0);
  const webhook = (await payload.webhook)!;
  expect(webhook.id).toBeDefined();
  expect(webhook.enabled).toBe(true);
  expect(webhook.resourceTypes).toEqual(["Issue"]);
  expect(webhook.url).toBe("http://127.0.0.1:12345/events");
  expect(webhook.secret).toBe("sdk-secret");
  expect((await webhook.team)!.id).toBe(ids.team);
  expect((await webhook.creator)!.id).toBe(ids.user);
  const update = await client.updateWebhook(webhook.id, {
    enabled: false,
    label: "Changed",
    resourceTypes: ["Comment"],
    secret: "changed-secret",
  });
  expect((await update.webhook)!.label).toBe("Changed");
  expect((await client.webhook(webhook.id)).enabled).toBe(false);
  const second = await client.createWebhook({
    url: "http://localhost:12345",
    resourceTypes: ["Project"],
    allPublicTeams: true,
  });
  expect((await client.webhooks({ first: 1 })).nodes).toHaveLength(1);
  const first = await client.webhooks({ first: 1 });
  expect(first.pageInfo.hasNextPage).toBe(true);
  const next = await client.webhooks({ after: first.pageInfo.endCursor, first: 1 });
  expect(next.nodes[0]!.id).not.toBe(first.nodes[0]!.id);
  const raw = await fetch(server.url, {
    method: "POST",
    headers: { authorization: fixtureApiKeys.primary, "content-type": "application/json" },
    body: JSON.stringify({
      query: print(operationDocument(documents, "webhook")),
      variables: { id: webhook.id },
    }),
  });
  const result = await raw.json();
  expect(result.errors).toBeUndefined();
  expect(result.data.webhook.resourceTypes).toEqual(["Comment"]);
  expect(result.data.webhook.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect((await client.deleteWebhook(webhook.id)).entityId).toBe(webhook.id);
  await expect(client.webhook(webhook.id)).rejects.toThrow();
  expect((await client.webhooks()).nodes.map((node) => node.id)).toEqual([
    (await second.webhook)!.id,
  ]);
  const secondary = new LinearClient({ apiUrl: server.url.href, apiKey: fixtureApiKeys.secondary });
  await expect(secondary.webhook((await second.webhook)!.id)).rejects.toThrow();
  expect(
    requests.some(
      (request) =>
        request.query.includes("resourceTypes") && request.query.includes("allPublicTeams"),
    ),
  ).toBe(true);
});

test("registration requires administrator authorization distinct from app provisioning and validates mutable fields", () => {
  const { runtime, principal } = setup();
  const input = { url: "http://localhost:8080", resourceTypes: ["Issue"] };
  for (const denied of [
    { ...principal, admin: false },
    { ...principal, actor: "user", scopes: ["read", "write"] },
    { ...principal, actor: "app", scopes: ["read", "write"] },
  ] as Principal[]) {
    expect(() => createSubscription(runtime, denied, input)).toThrow("Administrator");
    expect(() => subscription(runtime.database, denied, "any")).toThrow("Administrator");
  }
  expect(() =>
    createSubscription(runtime, principal, { ...input, teamId: fixtureIds.secondary.team }),
  ).toThrow("Team not found");
  expect(() =>
    createSubscription(runtime, principal, { ...input, teamId: ids.privateTeam }),
  ).toThrow("Team access");
  expect(() =>
    createSubscription(runtime, principal, { ...input, url: "file:///tmp/webhook" }),
  ).toThrow("URL");
  const created = createSubscription(runtime, principal, input);
  expect(() =>
    updateSubscription(runtime, principal, created.webhook.id, { enabled: null }),
  ).toThrow("boolean");
  expect(() =>
    updateSubscription(runtime, principal, created.webhook.id, { secret: null }),
  ).toThrow("secret");
  expect(() =>
    updateSubscription(runtime, principal, created.webhook.id, { teamId: ids.privateTeam }),
  ).toThrow("update");
  expect(subscription(runtime.database, principal, created.webhook.id).enabled).toBe(1);
  resetRuntime(runtime, [deliveryResetOwner]);
  expect(runtime.database.query("SELECT id FROM webhook_subscriptions").all()).toEqual([]);
});
