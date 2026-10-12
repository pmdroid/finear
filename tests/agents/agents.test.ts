import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearClient, LinearDocument } from "@linear/sdk";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { planFixture } from "./fixtures";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import {
  createIdentity,
  identityMigrations,
  fixtureOAuthClient,
  requireDelegate,
  requireIdentityAccess,
} from "../../src/identity";
import { fixtureApiKeys } from "../../src/identity/fixture";
import {
  createDelivery,
  deliveryMigrations,
  deliveryResetOwner,
  provisionAppWebhook,
} from "../../src/delivery";
import { Workspace } from "../../src/workspace/entities";
import {
  workspaceEntityMigrations,
  workspaceEntityResetOwner,
} from "../../src/workspace/entity-schema";
import {
  workspaceEntityResolvers,
  workspaceEntityRoots,
  workspaceEntityOperations,
} from "../../src/workspace/entity-resolvers";
import { fixtureIds } from "../../src/workspace/fixtures";
import { supportingResolvers } from "../../src/workspace/supporting";
import { createGraphQLHandler } from "../../src/graphql/http";
import { supportingRoots, deliveredOperations } from "../../src/graphql/contract";
import {
  agentMigrations,
  agentsResetOwner,
  createAgents,
  agentsResolvers,
  agentsRoots,
  agentsOperations,
} from "../../src/workspace/agents";
import { startServer } from "../../src/server";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const primary = fixtureIds.primary;
const migrations = [
  workspaceEntityMigrations,
  identityMigrations,
  deliveryMigrations,
  agentMigrations,
];

async function setup(path = ":memory:") {
  const captured: { body: string; signature: string; event: string | null }[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captured.push({
        body: await request.text(),
        signature: request.headers.get("linear-signature")!,
        event: request.headers.get("linear-event"),
      });
      return new Response("ok");
    },
  });
  cleanup.push(() => {
    receiver.stop(true);
  });
  const epoch = Date.now();
  const runtime = createRuntime({ databasePath: path, clockSource: () => epoch, migrations });
  cleanup.push(() => runtime.close());
  const delivery = createDelivery(runtime);
  cleanup.push(() => delivery.close());
  const secondClient = {
    ...fixtureOAuthClient,
    id: "30000000-0000-4000-8000-000000000099",
    name: "Other Agent",
  };
  const clients = [fixtureOAuthClient, secondClient].map((client) => ({
    ...client,
    webhook: {
      url: receiver.url.href,
      secret: "agent-webhook-secret",
      resourceTypes: ["Comment", "Issue"],
      agentSessionEvents: true,
    },
  }));
  const identity = createIdentity(runtime, { clients, provisionAppWebhook });
  const owners = [
    workspaceEntityResetOwner,
    identity.resetOwner,
    deliveryResetOwner,
    agentsResetOwner,
  ];
  resetRuntime(runtime, owners);
  const workspace = new Workspace(runtime, {
    requireAccess: requireIdentityAccess,
    requireDelegate,
    onDelegated: (...args) => agents.onDelegated(...args),
  });
  const agents = createAgents(runtime, workspace, identity);
  const graphql = await createGraphQLHandler(runtime, {
    authenticate: identity.authenticate,
    roots: {
      query: [...supportingRoots, ...workspaceEntityRoots, ...agentsRoots.query],
      mutation: [
        ...Object.keys(workspaceEntityResolvers(workspace).Mutation!),
        ...agentsRoots.mutation,
      ],
    },
    operations: [...deliveredOperations, ...workspaceEntityOperations, ...agentsOperations],
    resolverMaps: [
      supportingResolvers(),
      workspaceEntityResolvers(workspace),
      agentsResolvers(agents),
    ],
  });
  const server = startServer({ port: 0, handlers: [identity.handler, graphql] });
  cleanup.push(() => {
    server.stop(true);
  });
  const base = server.url.origin;
  const client = new LinearClient({ apiUrl: base + "/graphql", apiKey: fixtureApiKeys.primary });
  const human = identity.authenticate(
    new Request(base, { headers: { authorization: fixtureApiKeys.primary } }),
  );
  const foreign = identity.authenticate(
    new Request(base, { headers: { authorization: fixtureApiKeys.secondary } }),
  );
  const post = (path: string, values: URLSearchParams) =>
    fetch(base + path, { method: "POST", body: values, redirect: "manual" });
  const install = async (
    clientId = fixtureOAuthClient.id as string,
    ids = primary as typeof fixtureIds.primary | typeof fixtureIds.secondary,
    scope = "read,write,app:assignable,app:mentionable",
    actor = "app",
  ) => {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: fixtureOAuthClient.redirectUris[0],
      response_type: "code",
      scope,
      actor,
      state: "agent-state",
    });
    const page = await fetch(base + "/oauth/authorize?" + query);
    expect(page.status).toBe(200);
    const html = await page.text();
    const approval = await post(
      "/oauth/authorize",
      new URLSearchParams({
        consent: /name="consent" value="([^"]+)"/.exec(html)![1]!,
        decision: "allow",
        user_id: ids.user,
        workspace_id: ids.organization,
        team_id: ids.team,
      }),
    );
    expect(approval.status).toBe(302);
    const callback = new URL(approval.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("agent-state");
    const response = await post(
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        redirect_uri: fixtureOAuthClient.redirectUris[0],
        client_id: clientId,
        client_secret: fixtureOAuthClient.secret,
      }),
    );
    expect(response.status).toBe(200);
    const token = (await response.json()).access_token as string;
    const principal = identity.authenticate(
      new Request(base, { headers: { authorization: `Bearer ${token}` } }),
    );
    return {
      token,
      principal,
      sdk: new LinearClient({ apiUrl: base + "/graphql", accessToken: token }),
    };
  };
  const app = await install();
  const issue = (await (
    await client.createIssue({
      teamId: primary.team,
      title: "Agent work",
      description: "Implement safely",
      assigneeId: primary.user,
    })
  ).issue)!;
  const raw = async (query: string, variables: Record<string, unknown> = {}, token = app.token) => {
    const response = await fetch(base + "/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    runtime,
    delivery,
    identity,
    workspace,
    agents,
    client,
    human,
    foreign,
    issue,
    app,
    captured,
    raw,
    owners,
    install,
    secondClient,
  };
}

function sessionId(payload: { entity: { id: string } } | null) {
  if (!payload) throw new Error("Expected session");
  return payload.entity.id;
}

async function create(c: Awaited<ReturnType<typeof setup>>) {
  const payload = await c.app.sdk.agentSessionCreateOnIssue({ issueId: c.issue.id });
  expect(payload.success).toBe(true);
  const session = (await payload.agentSession)!;
  expect(session.status).toBe(LinearDocument.AgentSessionStatus.Pending);
  return session;
}

test("SDK delegation, signed created/prompted delivery, lifecycle and ordinary threaded comments", async () => {
  const c = await setup();
  await c.install(c.secondClient.id);
  const id = sessionId(c.agents.delegate(c.human, c.issue.id, c.app.principal.userId));
  const issue = await c.client.issue(c.issue.id);
  expect((await issue.delegate)?.id).toBe(c.app.principal.userId);
  expect((await issue.assignee)?.id).toBe(primary.user);
  await c.delivery.runDue();
  const verifier = new LinearWebhookClient("agent-webhook-secret");
  const events = () =>
    c.captured
      .map((capture) => JSON.parse(capture.body))
      .filter((event) => event.type === "AgentSessionEvent");
  const created = events()[0];
  expect(created.action).toBe("created");
  expect(created.appUserId).toBe(c.app.principal.userId);
  expect(created.agentSession.issue.title).toBe("Agent work");
  expect(events()).toHaveLength(1);
  expect(events().every((event) => event.oauthClientId === fixtureOAuthClient.id)).toBe(true);
  for (const capture of c.captured)
    expect(verifier.verify(Buffer.from(capture.body), capture.signature)).toBe(true);
  const thought = await c.app.sdk.createAgentActivity({
    agentSessionId: id,
    content: { type: "thought", body: "Thinking" },
    ephemeral: true,
  });
  expect((await thought.agentActivity)?.content.type).toBe(
    LinearDocument.AgentActivityType.Thought,
  );
  expect((await c.app.sdk.agentSession(id)).status).toBe(LinearDocument.AgentSessionStatus.Active);
  await c.app.sdk.createAgentActivity({
    agentSessionId: id,
    content: { type: "action", action: "search", parameter: "source", result: "found" },
  });
  await c.app.sdk.createAgentActivity({
    agentSessionId: id,
    content: { type: "elicitation", body: "Which branch?" },
    signal: LinearDocument.AgentActivitySignal.Select,
    signalMetadata: { choices: ["main"] },
  });
  const waiting = await c.app.sdk.agentSession(id);
  expect(waiting.status).toBe(LinearDocument.AgentSessionStatus.AwaitingInput);
  const root = (await waiting.comment)!;
  expect(root.body).toBe("Which branch?");
  c.agents.prompt(c.human, id, "Use main");
  await c.delivery.runDue();
  const prompted = events().find((event) => event.action === "prompted");
  expect(prompted.agentActivity.content).toEqual({ type: "prompt", body: "Use main" });
  expect(prompted.agentActivity.user.id).toBe(primary.user);
  expect(prompted.agentActivity.sourceCommentId).toBeTruthy();
  expect(events()).toHaveLength(2);
  for (const capture of c.captured.filter(
    (item) => JSON.parse(item.body).type === "AgentSessionEvent",
  ))
    expect(verifier.verify(Buffer.from(capture.body), capture.signature)).toBe(true);
  const response = await c.app.sdk.createAgentActivity({
    agentSessionId: id,
    content: { type: "response", body: "Done" },
  });
  expect((await response.agentActivity)?.content.type).toBe(
    LinearDocument.AgentActivityType.Response,
  );
  const completed = await c.app.sdk.agentSession(id);
  expect(completed.status).toBe(LinearDocument.AgentSessionStatus.Complete);
  expect(completed.endedAt).toBeInstanceOf(Date);
  const comments = await root.children({ id: root.id });
  expect(comments.nodes.map((comment) => comment.body).sort()).toEqual(["Done", "Use main"]);
  const activities = await completed.activities({ first: 2 });
  expect(activities.nodes).toHaveLength(2);
  expect(activities.pageInfo.hasNextPage).toBe(true);
  const all = await c.app.sdk.agentActivities({
    filter: { agentSessionId: { eq: id } },
    first: 50,
  });
  expect(all.nodes).toHaveLength(5);
  expect(all.nodes.find((activity) => activity.content.type === "thought")?.ephemeral).toBe(true);
  expect((await c.app.sdk.agentSessions()).nodes.map((session) => session.id)).toContain(id);
  expect((await c.app.sdk.agentActivity(all.nodes[0]!.id)).id).toBe(all.nodes[0]!.id);
  const custom = await c.raw(`query($id:String!){issue(id:$id){agentSessions{nodes{id status}}}}`, {
    id: c.issue.id,
  });
  expect(custom.body.errors).toBeUndefined();
  expect(custom.body.data.issue.agentSessions.nodes[0].id).toBe(id);
  await c.delivery.runDue();
  expect(c.captured.some((capture) => JSON.parse(capture.body).type === "Comment")).toBe(true);
});

test("SDK plan-array choice, JSON and typed links, replacement precedence, summary does not acknowledge", async () => {
  const c = await setup();
  const session = await create(c);
  const plan = planFixture.value;
  expect(planFixture.provenance.sdkVersion).toBe("97.1.0");
  await c.app.sdk.updateAgentSession(session.id, { summary: "Working", plan });
  expect((await c.app.sdk.agentSession(session.id)).plan as unknown).toEqual(plan);
  c.runtime.clock.advance(9_999);
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe(
    LinearDocument.AgentSessionStatus.Pending,
  );
  c.runtime.clock.advance(1);
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe("stale");
  const link = { label: "Job", url: "https://example.com/job" };
  await c.app.sdk.updateAgentSession(session.id, { addedExternalUrls: [link] });
  const acknowledged = await c.app.sdk.agentSession(session.id);
  expect(acknowledged.status).toBe(LinearDocument.AgentSessionStatus.Active);
  expect(acknowledged.externalUrls as unknown).toEqual([link]);
  expect(acknowledged.externalLinks.map(({ label, url }) => ({ label, url }))).toEqual([link]);
  expect(acknowledged.context as unknown).toEqual([]);
  const raw = await c.raw(
    `query($id:String!){agentSession(id:$id){plan context externalUrls externalLinks{label url}}}`,
    { id: session.id },
  );
  expect(raw.body.data.agentSession.plan).toBe(JSON.stringify(plan));
  expect(raw.body.data.agentSession.externalUrls).toBe(JSON.stringify([link]));
  await c.app.sdk.updateAgentSession(session.id, {
    externalUrls: [link],
    addedExternalUrls: [{ label: "Ignored", url: "https://example.com/ignored" }],
    removedExternalUrls: [link.url],
  });
  expect((await c.app.sdk.agentSession(session.id)).externalUrls as unknown).toEqual([link]);
  await c.app.sdk.updateAgentSession(session.id, {
    removedExternalUrls: [link.url],
    summary: null,
    plan: null,
  });
  const cleared = await c.app.sdk.agentSession(session.id);
  expect(cleared.externalUrls as unknown).toEqual([]);
  expect(cleared.plan).toBeUndefined();
  for (const input of [
    { summary: " \n" },
    { summary: "a".repeat(256) },
    { plan: { steps: [] } },
    { plan: [{ content: "", status: "done" }] },
    { externalUrls: [{ label: "Bad", url: "javascript:alert(1)" }] },
  ])
    expect(() => c.agents.updateSession(c.app.principal, session.id, input)).toThrow();
});

test("ten-second and thirty-minute boundaries, recovery, stop and explicit terminal reopening", async () => {
  const c = await setup();
  const session = await create(c);
  c.runtime.clock.advance(10_000);
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe("stale");
  c.agents.createActivity(c.app.principal, {
    agentSessionId: session.id,
    content: { type: "thought", body: "Recovered" },
  });
  c.runtime.clock.advance(1_799_999);
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe(
    LinearDocument.AgentSessionStatus.Active,
  );
  c.runtime.clock.advance(1);
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe("stale");
  c.agents.createActivity(c.app.principal, {
    agentSessionId: session.id,
    content: { type: "action", action: "run", parameter: "checks" },
  });
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe(
    LinearDocument.AgentSessionStatus.Active,
  );
  c.agents.stop(c.human, session.id);
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe("stopping");
  expect(() =>
    c.agents.createActivity(c.app.principal, {
      agentSessionId: session.id,
      content: { type: "thought", body: "Keep working" },
    }),
  ).toThrow();
  c.agents.createActivity(c.app.principal, {
    agentSessionId: session.id,
    content: { type: "error", body: "Stopped", reasonCode: "cancelled" },
  });
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe("error");
  expect(() =>
    c.agents.createActivity(c.app.principal, {
      agentSessionId: session.id,
      content: { type: "thought", body: "Reopen" },
    }),
  ).toThrow();
  c.agents.prompt(c.human, session.id, "Try again");
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe(
    LinearDocument.AgentSessionStatus.Pending,
  );
  c.runtime.clock.advance(10_000);
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe("stale");
  c.agents.createActivity(c.app.principal, {
    agentSessionId: session.id,
    content: { type: "response", body: "Finished" },
  });
  c.runtime.clock.advance(1_800_000);
  expect(c.agents.requireSession(c.app.principal, session.id).status).toBe(
    LinearDocument.AgentSessionStatus.Complete,
  );
});

test("real installations enforce owning app, workspace, live membership, revocation and write scopes", async () => {
  const c = await setup();
  const session = await create(c);
  const other = await c.install(c.secondClient.id);
  const foreign = await c.install(fixtureOAuthClient.id, fixtureIds.secondary);
  for (const actor of [other, foreign]) {
    await expect(actor.sdk.agentSession(session.id)).rejects.toThrow();
    await expect(actor.sdk.updateAgentSession(session.id, { summary: "Stolen" })).rejects.toThrow();
    await expect(
      actor.sdk.createAgentActivity({
        agentSessionId: session.id,
        content: { type: "response", body: "Stolen" },
      }),
    ).rejects.toThrow();
    expect((await actor.sdk.agentSessions()).nodes).toHaveLength(0);
  }
  expect(() => c.agents.requireSession(c.foreign, session.id)).toThrow();
  expect(() => c.agents.updateSession(c.human, session.id, { summary: "Human" })).toThrow();
  expect(() => c.agents.prompt(c.app.principal, session.id, "Agent prompt")).toThrow();
  expect(() => c.agents.createOnIssue(c.human, { issueId: c.issue.id })).toThrow();
  const privatePrincipal = { ...c.human, teamIds: [...c.human.teamIds, primary.privateTeam] };
  c.runtime.database.transaction((tx) =>
    tx.run(
      "INSERT INTO team_memberships VALUES(?, ?, ?)",
      primary.organization,
      primary.privateTeam,
      primary.user,
    ),
  );
  const privateIssue = c.workspace.createIssue(privatePrincipal, {
    teamId: primary.privateTeam,
    title: "Secret",
  }).entity;
  await expect(c.app.sdk.agentSessionCreateOnIssue({ issueId: privateIssue.id })).rejects.toThrow();
  c.runtime.database.transaction((tx) =>
    tx.run("DELETE FROM team_memberships WHERE user_id = ?", c.app.principal.userId),
  );
  expect(() => c.agents.requireSession(c.app.principal, session.id)).toThrow();
  expect(() =>
    c.agents.createActivity(c.app.principal, {
      agentSessionId: session.id,
      content: { type: "thought", body: "No membership" },
    }),
  ).toThrow();
  c.runtime.database.transaction((tx) =>
    tx.run(
      "INSERT INTO team_memberships VALUES(?, ?, ?)",
      primary.organization,
      primary.team,
      c.app.principal.userId,
    ),
  );
  c.runtime.database.transaction((tx) =>
    tx.run("UPDATE oauth_grants SET scopes = '[\"read\"]' WHERE id = ?", c.app.principal.grantId),
  );
  expect(() =>
    c.agents.updateSession(c.app.principal, session.id, { summary: "No write" }),
  ).toThrow();
  c.runtime.database.transaction((tx) =>
    tx.run("UPDATE oauth_grants SET revoked_at = ? WHERE id = ?", tx.now, c.app.principal.grantId),
  );
  expect(() => c.agents.requireSession(c.app.principal, session.id)).toThrow();
});

test("content rules, immutable snapshots, comment creation on root threads and GraphQL unions", async () => {
  const c = await setup();
  const comment = (await (
    await c.client.createComment({ issueId: c.issue.id, body: "Please investigate" })
  ).comment)!;
  const payload = await c.app.sdk.agentSessionCreateOnComment({ commentId: comment.id });
  const session = (await payload.agentSession)!;
  expect((await session.comment)?.id).toBe(comment.id);
  expect((await session.sourceComment)?.id).toBe(comment.id);
  const child = c.workspace.createComment(c.human, {
    issueId: c.issue.id,
    parentId: comment.id,
    body: "Child",
  }).entity;
  expect(() => c.agents.createOnComment(c.app.principal, { commentId: child.id })).toThrow();
  const invalidContents = [
    { type: "prompt", body: "Injected" },
    { type: "thought" },
    { type: "action", action: "run" },
    { type: "error", body: 7 },
    { type: "response", body: "" },
    { type: "unknown", body: "x" },
  ];
  for (const content of invalidContents)
    await expect(
      c.app.sdk.createAgentActivity({ agentSessionId: session.id, content }),
    ).rejects.toThrow();
  for (const type of ["response", "elicitation", "error"])
    expect(() =>
      c.agents.createActivity(c.app.principal, {
        agentSessionId: session.id,
        content: { type, body: "Ephemeral" },
        ephemeral: true,
      }),
    ).toThrow();
  const input = {
    agentSessionId: session.id,
    content: { type: "elicitation", body: "Authenticate" },
    signal: "auth",
    signalMetadata: { url: "https://example.com/auth" },
  };
  const activity = c.agents.createActivity(c.app.principal, input).entity;
  input.content.body = "Changed caller object";
  expect(
    (c.agents.requireActivity(c.app.principal, activity.id).content as { body: string }).body,
  ).toBe("Authenticate");
  const mirror = c.workspace
    .listComments(c.human, {}, c.issue.id)
    .nodes.find((item) => item.body === "Authenticate")!;
  c.runtime.database.transaction((tx) =>
    tx.run("UPDATE comments SET body = 'Edited comment' WHERE id = ?", mirror.id),
  );
  expect(
    (c.agents.requireActivity(c.app.principal, activity.id).content as { body: string }).body,
  ).toBe("Authenticate");
  expect(() =>
    c.runtime.database.transaction((tx) =>
      tx.run("UPDATE agent_activities SET content = '{}' WHERE id = ?", activity.id),
    ),
  ).toThrow("immutable");
  const raw = await c.raw(
    `query($id:String!){agentActivity(id:$id){content{__typename ... on AgentActivityElicitationContent{type body bodyData}} signalMetadata user{id}}}`,
    { id: activity.id },
  );
  expect(raw.body.errors).toBeUndefined();
  expect(raw.body.data.agentActivity.content.__typename).toBe("AgentActivityElicitationContent");
  expect(raw.body.data.agentActivity.content.bodyData.type).toBe("doc");
  expect(JSON.parse(raw.body.data.agentActivity.signalMetadata)).toEqual({
    url: "https://example.com/auth",
  });
  const sdk = await c.app.sdk.agentActivity(activity.id);
  expect(sdk.signalMetadata).toEqual({ url: "https://example.com/auth" });
  expect((await sdk.user)?.id).toBe(c.app.principal.userId);
});

test("transaction callback and comment/outbox rollback, restart, durable events and atomic reset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finear-agent-db-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "db.sqlite");
  const c = await setup(path);
  const count = (table: string) =>
    c.runtime.database.query<{ count: number }>(`SELECT count(*) AS count FROM ${table}`).get()!
      .count;
  const initial = count("outbox");
  expect(() =>
    c.runtime.database.transaction((tx) => {
      const issue = c.workspace.setDelegate(c.human, c.issue.id, c.app.principal.userId, tx).entity;
      c.agents.onDelegated(tx, c.human, issue, null);
      throw new Error("rollback delegated");
    }),
  ).toThrow("rollback delegated");
  expect(count("agent_sessions")).toBe(0);
  expect(count("outbox")).toBe(initial);
  expect(c.workspace.requireIssue(c.human, c.issue.id).delegateId).toBeNull();
  const id = sessionId(c.agents.delegate(c.human, c.issue.id, c.app.principal.userId));
  const before = {
    outbox: count("outbox"),
    comments: count("comments"),
    activities: count("agent_activities"),
  };
  c.runtime.database.transaction((tx) =>
    tx.run(
      "CREATE TRIGGER reject_agent_activity BEFORE INSERT ON agent_activities BEGIN SELECT RAISE(ABORT, 'injected activity failure'); END",
    ),
  );
  expect(() =>
    c.agents.createActivity(c.app.principal, {
      agentSessionId: id,
      content: { type: "response", body: "Must rollback mirror" },
    }),
  ).toThrow("injected activity failure");
  expect(count("comments")).toBe(before.comments);
  expect(count("outbox")).toBe(before.outbox);
  expect(count("agent_activities")).toBe(before.activities);
  c.runtime.database.transaction((tx) => tx.run("DROP TRIGGER reject_agent_activity"));
  await c.delivery.close();
  c.runtime.close();
  const reopened = createRuntime({ databasePath: path, clockSource: () => Date.now(), migrations });
  cleanup.push(() => reopened.close());
  const identity = createIdentity(reopened);
  const agents = createAgents(reopened, new Workspace(reopened), identity);
  expect(agents.requireSession(c.app.principal, id).status).toBe(
    LinearDocument.AgentSessionStatus.Pending,
  );
  const delivery = createDelivery(reopened);
  cleanup.push(() => delivery.close());
  await delivery.runDue();
  expect(
    c.captured
      .map((capture) => JSON.parse(capture.body))
      .some((event) => event.type === "AgentSessionEvent" && event.action === "created"),
  ).toBe(true);
  const owners = [
    workspaceEntityResetOwner,
    identity.resetOwner,
    deliveryResetOwner,
    agentsResetOwner,
  ];
  expect(() =>
    resetRuntime(reopened, [
      ...owners,
      {
        clear() {
          throw new Error("reset rollback");
        },
      },
    ]),
  ).toThrow();
  expect(agents.requireSession(c.app.principal, id).id).toBe(id);
  resetRuntime(reopened, owners);
  expect(
    reopened.database
      .query<{ count: number }>("SELECT count(*) AS count FROM agent_sessions")
      .get()!.count,
  ).toBe(0);
  expect(
    reopened.database
      .query<{ count: number }>("SELECT count(*) AS count FROM agent_activities")
      .get()!.count,
  ).toBe(0);
  expect(
    reopened.database.query<{ count: number }>("SELECT count(*) AS count FROM outbox").get()!.count,
  ).toBe(0);
  resetRuntime(reopened, owners);
  expect(
    reopened.database.query<{ count: number }>("SELECT count(*) AS count FROM users").get()!.count,
  ).toBe(2);
});

test("automatic callback preserves issues:create scopes and uses any canonical approved target grant", async () => {
  const c = await setup();
  const readOnly = await c.install(c.secondClient.id, primary, "read");
  const assigned = await c.install(
    c.secondClient.id,
    primary,
    "read,app:assignable,app:mentionable",
  );
  expect(readOnly.principal.userId).toBe(assigned.principal.userId);
  c.runtime.database.transaction((tx) => {
    const grants = tx
      .query<{ id: string }>("SELECT id FROM oauth_grants WHERE user_id = ? ORDER BY id")
      .all(assigned.principal.userId);
    tx.run("UPDATE oauth_grants SET scopes = '[\"read\"]' WHERE id = ?", grants[0]!.id);
    tx.run(
      'UPDATE oauth_grants SET scopes = \'["read","app:assignable","app:mentionable"]\' WHERE id = ?',
      grants[1]!.id,
    );
  });
  const creators = [
    await c.install(fixtureOAuthClient.id, primary, "issues:create", "app"),
    await c.install(fixtureOAuthClient.id, primary, "issues:create", "user"),
  ];
  for (const creator of creators) {
    expect(creator.principal.scopes).not.toContain("write");
    const payload = await creator.sdk.createIssue({
      teamId: primary.team,
      title: "Create-only delegation",
      delegateId: assigned.principal.userId,
    });
    expect(payload.success).toBe(true);
    const row = c.runtime.database
      .query<{ id: string; issue_id: string; creator_id: string | null }>(
        "SELECT * FROM agent_sessions ORDER BY rowid DESC LIMIT 1",
      )
      .get()!;
    expect(row.creator_id).toBe(creator.principal.actor === "app" ? null : primary.user);
    const session = c.agents.requireSession(assigned.principal, row.id);
    expect(session.issueId).toBe(row.issue_id);
    expect(() => c.agents.createOnIssue(creator.principal, { issueId: row.issue_id })).toThrow();
    expect(() =>
      c.agents.mention(creator.principal, row.issue_id, assigned.principal.userId),
    ).toThrow();
    const event = c.runtime.database
      .query<{ data: string }>(
        "SELECT data FROM outbox WHERE resource_type = 'AgentSessionEvent' ORDER BY sequence DESC LIMIT 1",
      )
      .get()!;
    expect(JSON.parse(event.data).agentSession.issue.title).toBe("Create-only delegation");
  }
  const marker = c.runtime.database
    .query<{ count: number }>("SELECT count(*) AS count FROM issues")
    .get()!.count;
  const events = c.runtime.database
    .query<{ count: number }>("SELECT count(*) AS count FROM outbox")
    .get()!.count;
  c.runtime.database.transaction((tx) =>
    tx.run(
      "CREATE TRIGGER reject_agent_session BEFORE INSERT ON agent_sessions BEGIN SELECT RAISE(ABORT, 'injected session failure'); END",
    ),
  );
  await expect(
    creators[0]!.sdk.createIssue({
      teamId: primary.team,
      title: "Rollback create-only",
      delegateId: assigned.principal.userId,
    }),
  ).rejects.toThrow();
  expect(
    c.runtime.database.query<{ count: number }>("SELECT count(*) AS count FROM issues").get()!
      .count,
  ).toBe(marker);
  expect(
    c.runtime.database.query<{ count: number }>("SELECT count(*) AS count FROM outbox").get()!
      .count,
  ).toBe(events);
  c.runtime.database.transaction((tx) => tx.run("DROP TRIGGER reject_agent_session"));
  const mentioned = c.agents.mention(c.human, c.issue.id, assigned.principal.userId).entity;
  expect(mentioned.appUserId).toBe(assigned.principal.userId);
  const owner = c.runtime.database.transaction((tx) =>
    requireDelegate(tx, {
      organizationId: primary.organization,
      teamId: primary.team,
      appUserId: assigned.principal.userId,
    }),
  );
  const minimal = { ...creators[0]!.principal, scopes: ["issues:create"] };
  c.runtime.database.transaction((tx) => {
    const issue = c.workspace.createIssue(
      creators[0]!.principal,
      { teamId: primary.team, title: "Projection-only" },
      tx,
    ).entity;
    const projection = { ...issue, delegateId: owner.appUserId };
    expect(c.agents.onDelegated(tx, minimal, projection, null, owner)?.entity.issueId).toBe(
      issue.id,
    );
  });
});
