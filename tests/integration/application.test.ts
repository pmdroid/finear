import { afterEach, expect, test } from "bun:test";
import { LinearClient } from "@linear/sdk";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type Application } from "../../src/application";
import { fixtureOAuthClient, type ClientRegistration } from "../../src/identity";
import { fixtureApiKeys } from "../../src/identity/fixture";
import { fixtureIds } from "../../src/workspace/fixtures";

const applications: Application[] = [];
const receivers: ReturnType<typeof Bun.serve>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const application of applications.splice(0)) await application.close();
  for (const receiver of receivers.splice(0)) await receiver.stop(true);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function receiver(status = 200) {
  const captures: { body: string; headers: Headers }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captures.push({ body: await request.text(), headers: request.headers });
      return new Response("received", { status });
    },
  });
  receivers.push(server);
  return { server, captures };
}
async function application(options: Partial<Parameters<typeof createApplication>[0]> = {}) {
  const app = await createApplication({
    databasePath: ":memory:",
    port: 0,
    controlToken: "control-only",
    ...options,
  });
  applications.push(app);
  return app;
}
function sdk(app: Application, accessToken?: string) {
  return new LinearClient({
    apiUrl: new URL("/graphql", app.url).href,
    ...(accessToken ? { accessToken } : { apiKey: fixtureApiKeys.primary }),
  });
}
async function authorize(
  app: Application,
  client: ClientRegistration,
  actor: "user" | "app" = "app",
  requestedScope?: string,
) {
  const response = await fetch(
    new URL(
      "/oauth/authorize?" +
        new URLSearchParams({
          client_id: client.id,
          redirect_uri: client.redirectUris[0]!,
          response_type: "code",
          scope:
            requestedScope ?? (actor === "app" ? "read,write,app:assignable" : "read,write,admin"),
          actor,
          state: "integration-state",
        }),
      app.url,
    ),
  );
  expect(response.status).toBe(200);
  const consent = /name="consent" value="([^"]+)"/.exec(await response.text())![1]!;
  const allowed = await fetch(new URL("/oauth/authorize", app.url), {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      consent,
      decision: "allow",
      user_id: fixtureIds.primary.user,
      workspace_id: fixtureIds.primary.organization,
      team_id: fixtureIds.primary.team,
    }),
  });
  expect(allowed.status).toBe(302);
  const callback = new URL(allowed.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe("integration-state");
  const exchanged = await fetch(new URL("/oauth/token", app.url), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.id,
      client_secret: client.secret!,
      code: callback.searchParams.get("code")!,
      redirect_uri: client.redirectUris[0]!,
    }),
  });
  expect(exchanged.status).toBe(200);
  return (await exchanged.json()) as { access_token: string; refresh_token: string };
}
async function control(app: Application, path: string, body?: unknown, method = "POST") {
  return fetch(new URL(path, app.url), {
    method,
    headers: { authorization: "Bearer control-only", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

function append(app: Application) {
  app.runtime.database.transaction((tx) =>
    tx.appendEvent({
      organizationId: fixtureIds.primary.organization,
      teamId: fixtureIds.primary.team,
      resourceType: "Issue",
      action: "update",
      occurredAt: tx.now,
      data: { id: "integration-issue", title: "Snapshot" },
    }),
  );
}

test("OAuth app installation provisions webhook and revocation automatically delivers SDK-verified event", async () => {
  const target = receiver();
  const client = {
    ...fixtureOAuthClient,
    webhook: {
      url: target.server.url.href,
      secret: "app-signing",
      resourceTypes: ["Issue"],
      agentSessionEvents: true,
    },
  };
  const app = await application({ clients: [client] });
  const tokens = await authorize(app, client);
  const agent = sdk(app, tokens.access_token);
  const viewer = await agent.viewer;
  expect(viewer.app).toBe(true);
  expect(viewer.id).not.toBe(fixtureIds.primary.user);
  expect(viewer.isAssignable).toBe(true);
  expect((await sdk(app).webhooks()).nodes).toHaveLength(1);
  const revoked = await fetch(new URL("/oauth/revoke", app.url), {
    method: "POST",
    body: new URLSearchParams({ token: tokens.access_token }),
  });
  expect(revoked.status).toBe(200);
  await until(() => target.captures.length === 1);
  const capture = target.captures[0]!;
  expect(
    new LinearWebhookClient("app-signing").verify(
      Buffer.from(capture.body),
      capture.headers.get("linear-signature")!,
    ),
  ).toBe(true);
  expect(JSON.parse(capture.body)).toMatchObject({
    type: "OAuthApp",
    action: "revoked",
    oauthClientId: client.id,
  });
  await expect(agent.viewer).rejects.toThrow();
  await app.drain();
  const inspected = await control(app, "/__test/deliveries", undefined, "GET");
  expect((await inspected.json()).deliveries[0].status).toBe("acknowledged");
});

test("OAuth user SDK manages real webhook CRUD and automatic scheduler sends committed event", async () => {
  const target = receiver();
  const app = await application();
  const tokens = await authorize(app, fixtureOAuthClient, "user");
  const client = sdk(app, tokens.access_token);
  expect((await client.viewer).id).toBe(fixtureIds.primary.user);
  const created = await client.createWebhook({
    url: target.server.url.href,
    secret: "crud-signing",
    resourceTypes: ["Issue"],
    allPublicTeams: true,
  });
  const webhook = await created.webhook;
  expect(webhook?.enabled).toBe(true);
  expect((await client.updateWebhook(webhook!.id, { label: "Updated" })).success).toBe(true);
  expect((await client.webhook(webhook!.id)).label).toBe("Updated");
  append(app);
  await until(() => target.captures.length === 1);
  expect(
    new LinearWebhookClient("crud-signing").verify(
      Buffer.from(target.captures[0]!.body),
      target.captures[0]!.headers.get("linear-signature")!,
    ),
  ).toBe(true);
  expect((await client.deleteWebhook(webhook!.id)).success).toBe(true);
  expect((await client.webhooks()).nodes).toHaveLength(0);
});

test("clock control drains chronological retries and restart retains tokens and retry state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finear-application-"));
  directories.push(directory);
  const databasePath = join(directory, "workspace.sqlite");
  const now = Date.now();
  const target = receiver(503);
  const first = await application({ databasePath, clockSource: () => now });
  const tokens = await authorize(first, fixtureOAuthClient, "user");
  await sdk(first).createWebhook({
    url: target.server.url.href,
    secret: "retry-signing",
    resourceTypes: ["Issue"],
    allPublicTeams: true,
  });
  append(first);
  await first.drain();
  expect(target.captures).toHaveLength(1);
  await first.close();
  const second = await application({ databasePath, clockSource: () => now });
  expect((await sdk(second, tokens.access_token).viewer).id).toBe(fixtureIds.primary.user);
  expect(
    (
      await control(second, "/__test/clock/advance", {
        milliseconds: 25_260_000,
      })
    ).status,
  ).toBe(200);
  expect(target.captures).toHaveLength(4);
  const attempts = (await (await control(second, "/__test/attempts", undefined, "GET")).json())
    .attempts;
  expect(attempts.map((attempt: { sent_at: number }) => attempt.sent_at)).toEqual([
    now,
    now + 60_000,
    now + 3_660_000,
    now + 25_260_000,
  ]);
  expect(second.delivery.deliveries()[0]?.status).toBe("exhausted");
  expect((await control(second, "/__test/reset")).status).toBe(200);
  expect(second.runtime.clock.now()).toBe(now);
  expect(second.delivery.attempts()).toEqual([]);
  expect((await sdk(second).webhooks()).nodes).toEqual([]);
  await expect(sdk(second, tokens.access_token).viewer).rejects.toThrow();
  await second.close();
  const third = await application({ databasePath, clockSource: () => now });
  expect((await sdk(third).viewer).name).toBe("Human 1");
  expect(third.delivery.attempts()).toEqual([]);
});

test("control routes reject API and OAuth credentials and disable when absent", async () => {
  const app = await application();
  const tokens = await authorize(app, fixtureOAuthClient, "user");
  for (const authorization of [fixtureApiKeys.primary, `Bearer ${tokens.access_token}`]) {
    for (const path of [
      "/__test/reset",
      "/__test/drain",
      "/__test/clock/advance",
      "/__test/deliveries",
      "/__test/attempts",
    ]) {
      const response = await fetch(new URL(path, app.url), {
        method: "POST",
        headers: { authorization },
        body: "invalid",
      });
      expect(response.status).toBe(401);
    }
  }
  expect((await control(app, "/__test/clock/advance", { milliseconds: -1 })).status).toBe(400);
  const disabled = await application({ controlToken: undefined });
  expect((await control(disabled, "/__test/reset")).status).toBe(404);
  await Promise.all([app.close(), app.close()]);
});

test("delivery receivers can call the application SDK while dispatch is in flight", async () => {
  const app = await application();
  let observed: string | undefined;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.text();
      observed = (await sdk(app).viewer).id;
      return new Response("ok");
    },
  });
  receivers.push(target);
  await sdk(app).createWebhook({
    url: target.url.href,
    secret: "callback-signing",
    resourceTypes: ["Issue"],
    allPublicTeams: true,
  });
  append(app);
  await app.drain();
  expect(observed).toBe(fixtureIds.primary.user);
  expect(app.delivery.deliveries()[0]?.status).toBe("acknowledged");
});

test("reset and close wait for in-flight delivery before changing or closing persistence", async () => {
  const app = await application();
  let release!: () => void;
  let started = false;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.text();
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response("ok");
    },
  });
  receivers.push(target);
  await sdk(app).createWebhook({
    url: target.url.href,
    secret: "wait-signing",
    resourceTypes: ["Issue"],
    allPublicTeams: true,
  });
  append(app);
  const drain = app.drain();
  await until(() => started);
  let resetDone = false;
  const reset = app.reset().then(() => {
    resetDone = true;
  });
  await Bun.sleep(20);
  expect(resetDone).toBe(false);
  release();
  await Promise.all([drain, reset]);
  expect(app.delivery.attempts()).toEqual([]);
  await sdk(app).createWebhook({
    url: target.url.href,
    secret: "wait-signing",
    resourceTypes: ["Issue"],
    allPublicTeams: true,
  });
  started = false;
  append(app);
  const secondDrain = app.drain();
  await until(() => started);
  let closed = false;
  const close = app.close().then(() => {
    closed = true;
  });
  await Bun.sleep(20);
  expect(closed).toBe(false);
  release();
  await Promise.all([secondDrain, close]);
  expect(closed).toBe(true);
  expect(() => app.runtime.database.query("SELECT id FROM users").all()).toThrow("closed");
});

test("OAuth SDK project and parent-child journey delivers native signed events and survives restart/reset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finear-entity-journey-"));
  directories.push(directory);
  const databasePath = join(directory, "workspace.sqlite");
  const target = receiver();
  const clientRegistration = {
    ...fixtureOAuthClient,
    webhook: {
      url: target.server.url.href,
      secret: "entity-signing",
      resourceTypes: ["Issue", "Project", "Comment"],
    },
  };
  const app = await application({ databasePath, clients: [clientRegistration] });
  const tokens = await authorize(app, clientRegistration);
  const client = sdk(app, tokens.access_token);
  const viewer = await client.viewer;
  const project = (await (
    await client.createProject({ name: "Integrated project", teamIds: [fixtureIds.primary.team] })
  ).project)!;
  const parent = (await (
    await client.createIssue({
      title: "Parent",
      teamId: fixtureIds.primary.team,
      projectId: project.id,
    })
  ).issue)!;
  const children = [];
  for (const title of ["First child", "Second child"]) {
    children.push(
      (await (
        await client.createIssue({
          title,
          teamId: fixtureIds.primary.team,
          projectId: project.id,
          parentId: parent.id,
        })
      ).issue)!,
    );
  }
  expect((await parent.children()).nodes.map((child) => child.id)).toEqual(
    children.map((child) => child.id),
  );
  expect((await children[0]!.parent)?.id).toBe(parent.id);
  expect((await children[0]!.creator)?.id).toBe(viewer.id);
  expect((await project.issues()).nodes).toHaveLength(3);
  const comment = (await (
    await client.createComment({ issueId: children[0]!.id, body: "Thread root" })
  ).comment)!;
  const reply = (await (
    await client.createComment({
      issueId: children[0]!.id,
      parentId: comment.id,
      body: "Thread reply",
    })
  ).comment)!;
  expect((await reply.parent)?.id).toBe(comment.id);
  expect((await comment.children({ id: comment.id })).nodes[0]?.id).toBe(reply.id);
  await client.updateIssue(children[0]!.id, { title: "Updated child" });
  await app.drain();
  expect(target.captures).toHaveLength(7);
  const verifier = new LinearWebhookClient("entity-signing");
  for (const capture of target.captures) {
    expect(
      verifier.verify(Buffer.from(capture.body), capture.headers.get("linear-signature")!),
    ).toBe(true);
    expect(JSON.parse(capture.body).actor.id).toBe(viewer.id);
  }
  const bodies = target.captures.map((capture) => JSON.parse(capture.body));
  expect(bodies.filter((body) => body.type === "Project")).toHaveLength(1);
  expect(bodies.filter((body) => body.type === "Issue")).toHaveLength(4);
  expect(bodies.filter((body) => body.type === "Comment")).toHaveLength(2);
  expect(
    bodies.find((body) => body.type === "Issue" && body.action === "update").updatedFrom.title,
  ).toBe("First child");
  expect(bodies.find((body) => body.type === "Project").url).toBe(project.url);
  await app.close();
  const reopened = await application({ databasePath, clients: [clientRegistration] });
  const persisted = sdk(reopened, tokens.access_token);
  expect((await persisted.issue(children[0]!.id)).title).toBe("Updated child");
  expect((await (await persisted.issue(parent.id)).children()).nodes).toHaveLength(2);
  expect((await persisted.comment({ id: reply.id })).body).toBe("Thread reply");
  expect((await persisted.project(project.id)).name).toBe("Integrated project");
  expect(
    reopened.delivery.deliveries().every((delivery) => delivery.status === "acknowledged"),
  ).toBe(true);
  await reopened.reset();
  expect((await sdk(reopened).issues()).nodes).toHaveLength(0);
  expect((await sdk(reopened).projects()).nodes).toHaveLength(0);
  expect(reopened.delivery.deliveries()).toEqual([]);
  await expect(persisted.viewer).rejects.toThrow();
  const repeated = await authorize(reopened, clientRegistration);
  const repeatedClient = sdk(reopened, repeated.access_token);
  const first = (await (
    await repeatedClient.createIssue({ teamId: fixtureIds.primary.team, title: "Repeat" })
  ).issue)!;
  expect(first.identifier).toBe("ENG-1");
});

test("integrated entities deny workspace/private team/missing scope and removed OAuth membership", async () => {
  const app = await application();
  const tokens = await authorize(app, fixtureOAuthClient, "user");
  const client = sdk(app, tokens.access_token);
  const project = (await (
    await client.createProject({ name: "Protected", teamIds: [fixtureIds.primary.team] })
  ).project)!;
  const issue = (await (
    await client.createIssue({
      title: "Protected",
      teamId: fixtureIds.primary.team,
      projectId: project.id,
    })
  ).issue)!;
  await expect(
    client.createIssue({ title: "Private", teamId: fixtureIds.primary.privateTeam }),
  ).rejects.toThrow();
  const secondary = new LinearClient({
    apiUrl: new URL("/graphql", app.url).href,
    apiKey: fixtureApiKeys.secondary,
  });
  await expect(secondary.issue(issue.id)).rejects.toThrow();
  await expect(secondary.project(project.id)).rejects.toThrow();
  const readOnly = await authorize(app, fixtureOAuthClient, "user", "read");
  const reader = sdk(app, readOnly.access_token);
  await expect(
    reader.createIssue({ title: "Denied", teamId: fixtureIds.primary.team }),
  ).rejects.toThrow();
  await expect(
    reader.createProject({ name: "Denied", teamIds: [fixtureIds.primary.team] }),
  ).rejects.toThrow();
  await expect(reader.createComment({ issueId: issue.id, body: "Denied" })).rejects.toThrow();
  app.runtime.database.transaction((tx) =>
    tx.run(
      "DELETE FROM team_memberships WHERE user_id = ? AND team_id = ?",
      fixtureIds.primary.user,
      fixtureIds.primary.team,
    ),
  );
  await expect(client.issue(issue.id)).rejects.toThrow();
  await expect(client.updateIssue(issue.id, { title: "Denied after removal" })).rejects.toThrow();
  expect((await client.issues()).nodes).toHaveLength(0);
});
