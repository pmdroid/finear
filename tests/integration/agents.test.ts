import { afterEach, expect, test } from "bun:test";
import { LinearClient, LinearDocument } from "@linear/sdk";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type Application } from "../../src/application";
import { fixtureOAuthClient, type ClientRegistration } from "../../src/identity";
import { fixtureIds } from "../../src/workspace/fixtures";
import { fixtureApiKeys } from "../../src/identity/fixture";

const applications: Application[] = [];
const receivers: ReturnType<typeof Bun.serve>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const application of applications.splice(0)) await application.close();
  for (const receiver of receivers.splice(0)) await receiver.stop(true);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function setup(persistent = false) {
  const captured: { body: string; signature: string }[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captured.push({
        body: await request.text(),
        signature: request.headers.get("linear-signature")!,
      });
      return new Response("ok");
    },
  });
  receivers.push(receiver);
  const clients = [
    fixtureOAuthClient,
    { ...fixtureOAuthClient, id: "30000000-0000-4000-8000-000000000003", name: "Second Agent" },
  ].map((client) => ({
    ...client,
    webhook: {
      url: receiver.url.href,
      secret: "integrated-agent-signing",
      resourceTypes: ["Issue", "Project", "Comment"],
      agentSessionEvents: true,
    },
  }));
  const directory = mkdtempSync(join(tmpdir(), "finear-agent-integration-"));
  directories.push(directory);
  const options = {
    databasePath: persistent ? join(directory, "workspace.sqlite") : ":memory:",
    port: 0,
    controlToken: "agent-control",
    clockSource: () => now,
    clients,
  };
  const now = Date.now();
  const application = await createApplication(options);
  applications.push(application);
  const human = new LinearClient({
    apiUrl: new URL("/graphql", application.url).href,
    apiKey: fixtureApiKeys.primary,
  });
  return { application, human, clients, captured, options };
}
async function install(
  application: Application,
  client: ClientRegistration,
  scope = "read,write,app:assignable,app:mentionable",
) {
  const authorize = new URL("/oauth/authorize", application.url);
  authorize.search = new URLSearchParams({
    client_id: client.id,
    redirect_uri: client.redirectUris[0]!,
    response_type: "code",
    scope,
    actor: "app",
    state: "agent-state",
  }).toString();
  const page = await fetch(authorize);
  expect(page.status).toBe(200);
  const consent = /name="consent" value="([^"]+)"/.exec(await page.text())![1]!;
  const approval = await fetch(new URL("/oauth/authorize", application.url), {
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
  expect(approval.status).toBe(302);
  const callback = new URL(approval.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe("agent-state");
  const exchanged = await fetch(new URL("/oauth/token", application.url), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.id,
      client_secret: client.secret!,
      redirect_uri: client.redirectUris[0]!,
      code: callback.searchParams.get("code")!,
    }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json();
  const sdk = new LinearClient({
    apiUrl: new URL("/graphql", application.url).href,
    accessToken: tokens.access_token,
  });
  return { sdk, token: String(tokens.access_token), user: await sdk.viewer };
}
async function control(application: Application, action: string, body: unknown) {
  return fetch(new URL(`/__test/agents/${action}`, application.url), {
    method: "POST",
    headers: { authorization: "Bearer agent-control", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function events(captured: { body: string }[]) {
  return captured
    .map((capture) => JSON.parse(capture.body))
    .filter((event) => event.type === "AgentSessionEvent");
}

test("repository suggestions filter persisted issue fixtures and validate session access", async () => {
  const c = await setup(true);
  const agent = await install(c.application, c.clients[0]!);
  const other = await install(c.application, c.clients[1]!);
  const issue = (await (
    await c.human.createIssue({ teamId: fixtureIds.primary.team, title: "Repository selection" })
  ).issue)!;
  const another = (await (
    await c.human.createIssue({ teamId: fixtureIds.primary.team, title: "Another issue" })
  ).issue)!;
  await c.human.updateIssue(issue.id, { delegateId: agent.user.id });
  await c.application.drain();
  const session = (await agent.sdk.agentSessions()).nodes[0]!;
  const chosen = { hostname: "github.com", repositoryFullName: "fixture/chosen" };
  const excluded = { hostname: "github.com", repositoryFullName: "fixture/excluded" };
  const suggestions = [
    { ...chosen, confidence: 0.9 },
    { ...excluded, confidence: 0.2 },
  ];
  const query = `query IssueRepositorySuggestions($issueId: String!, $agentSessionId: String, $candidateRepositories: [CandidateRepository!]!) {
    issueRepositorySuggestions(issueId: $issueId, agentSessionId: $agentSessionId, candidateRepositories: $candidateRepositories) {
      suggestions { hostname repositoryFullName confidence }
    }
  }`;
  async function request(
    application: Application,
    token: string,
    issueId = issue.id,
    agentSessionId: string | null = session.id,
  ) {
    const response = await fetch(new URL("/graphql", application.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { issueId, agentSessionId, candidateRepositories: [chosen] },
      }),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  expect((await request(c.application, agent.token)).data).toEqual({
    issueRepositorySuggestions: { suggestions: [] },
  });
  const configure = (body: unknown, token = "agent-control") =>
    fetch(new URL("/__test/repository-suggestions", c.application.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await configure({ issueId: issue.id, suggestions }, "wrong-control")).status).toBe(401);
  expect((await configure({ issueId: issue.id, suggestions })).status).toBe(200);
  expect((await request(c.application, agent.token)).data).toEqual({
    issueRepositorySuggestions: { suggestions: [suggestions[0]] },
  });
  expect((await request(c.application, agent.token, another.id, null)).data).toEqual({
    issueRepositorySuggestions: { suggestions: [] },
  });
  expect((await request(c.application, agent.token, another.id)).errors).toBeDefined();
  expect((await request(c.application, other.token)).errors).toBeDefined();
  const secondary = new LinearClient({
    apiUrl: new URL("/graphql", c.application.url).href,
    apiKey: fixtureApiKeys.secondary,
  });
  const foreign = (await (
    await secondary.createIssue({
      teamId: fixtureIds.secondary.team,
      title: "Foreign repository selection",
    })
  ).issue)!;
  expect((await request(c.application, agent.token, foreign.id, null)).errors).toBeDefined();
  expect((await request(c.application, agent.token, issue.id, "")).errors).toBeDefined();
  expect((await configure({ fixture: "secondary", issueId: issue.id, suggestions })).status).toBe(
    404,
  );
  expect(
    (await configure({ issueId: issue.id, suggestions: [{ ...chosen, confidence: 2 }] })).status,
  ).toBe(400);
  expect(
    (await request(c.application, agent.token)).data.issueRepositorySuggestions.suggestions,
  ).toEqual([suggestions[0]]);
  await c.application.close();
  const reopened = await createApplication(c.options);
  applications.push(reopened);
  expect(
    (await request(reopened, agent.token)).data.issueRepositorySuggestions.suggestions,
  ).toEqual([suggestions[0]]);
  await reopened.reset();
  const human = new LinearClient({
    apiUrl: new URL("/graphql", reopened.url).href,
    apiKey: fixtureApiKeys.primary,
  });
  const resetIssue = (await (
    await human.createIssue({ teamId: fixtureIds.primary.team, title: "After reset" })
  ).issue)!;
  const response = await fetch(new URL("/graphql", reopened.url), {
    method: "POST",
    headers: { authorization: fixtureApiKeys.primary, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { issueId: resetIssue.id, candidateRepositories: [chosen] },
    }),
  });
  expect((await response.json()).data.issueRepositorySuggestions.suggestions).toEqual([]);
});

test("integrated OAuth delegation and signed agent interaction complete and persist with threaded comments", async () => {
  const c = await setup(true);
  const agent = await install(c.application, c.clients[0]!);
  const other = await install(c.application, c.clients[1]!);
  const project = (await (
    await agent.sdk.createProject({ name: "Agent project", teamIds: [fixtureIds.primary.team] })
  ).project)!;
  const parent = (await (
    await agent.sdk.createIssue({
      teamId: fixtureIds.primary.team,
      projectId: project.id,
      title: "Parent",
    })
  ).issue)!;
  const children = [];
  for (const title of ["Agent child", "Second child"])
    children.push(
      (await (
        await agent.sdk.createIssue({
          teamId: fixtureIds.primary.team,
          projectId: project.id,
          parentId: parent.id,
          title,
          assigneeId: fixtureIds.primary.user,
        })
      ).issue)!,
    );
  const child = children[0]!;
  await c.human.updateIssue(child.id, { delegateId: agent.user.id });
  await c.application.drain();
  const created = events(c.captured).filter((event) => event.action === "created");
  expect(created).toHaveLength(1);
  expect(created[0].appUserId).toBe(agent.user.id);
  expect(created[0].oauthClientId).toBe(c.clients[0]!.id);
  const sessionId = String(created[0].agentSession.id);
  expect((await agent.sdk.agentSession(sessionId)).status).toBe(
    LinearDocument.AgentSessionStatus.Pending,
  );
  expect((await (await c.human.issue(child.id)).assignee)?.id).toBe(fixtureIds.primary.user);
  expect((await (await c.human.issue(child.id)).delegate)?.id).toBe(agent.user.id);
  await c.human.updateIssue(child.id, { title: "Title edit" });
  await c.human.updateIssue(child.id, { delegateId: agent.user.id });
  await c.application.drain();
  expect(events(c.captured).filter((event) => event.action === "created")).toHaveLength(1);
  await agent.sdk.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "thought", body: "Working" },
    ephemeral: true,
  });
  expect((await agent.sdk.agentSession(sessionId)).status).toBe(
    LinearDocument.AgentSessionStatus.Active,
  );
  await agent.sdk.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "elicitation", body: "Which branch?" },
  });
  expect((await agent.sdk.agentSession(sessionId)).status).toBe(
    LinearDocument.AgentSessionStatus.AwaitingInput,
  );
  const prompted = await control(c.application, "prompt", { sessionId, body: "Use main" });
  expect(prompted.status).toBe(200);
  await c.application.drain();
  const humanEvent = events(c.captured).find((event) => event.action === "prompted");
  expect(humanEvent.agentActivity.content).toEqual({ type: "prompt", body: "Use main" });
  expect(humanEvent.agentActivity.user.id).toBe(fixtureIds.primary.user);
  await expect(other.sdk.updateAgentSession(sessionId, { summary: "Denied" })).rejects.toThrow();
  await expect(
    other.sdk.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: "response", body: "Denied" },
    }),
  ).rejects.toThrow();
  await agent.sdk.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "response", body: "Finished" },
  });
  const completed = await agent.sdk.agentSession(sessionId);
  expect(completed.status).toBe(LinearDocument.AgentSessionStatus.Complete);
  const root = (await completed.comment)!;
  expect(root.body).toBe("Which branch?");
  expect(
    (await root.children({ id: root.id })).nodes.map((comment) => comment.body).sort(),
  ).toEqual(["Finished", "Use main"]);
  await c.application.drain();
  const verifier = new LinearWebhookClient("integrated-agent-signing");
  for (const capture of c.captured)
    expect(verifier.verify(Buffer.from(capture.body), capture.signature)).toBe(true);
  expect(events(c.captured)).toHaveLength(2);
  await c.application.close();
  const reopened = await createApplication(c.options);
  applications.push(reopened);
  const persisted = new LinearClient({
    apiUrl: new URL("/graphql", reopened.url).href,
    accessToken: agent.token,
  });
  expect((await persisted.agentSession(sessionId)).status).toBe(
    LinearDocument.AgentSessionStatus.Complete,
  );
  expect((await (await persisted.agentSession(sessionId)).activities()).nodes).toHaveLength(4);
  expect((await (await persisted.issue(parent.id)).children()).nodes).toHaveLength(2);
  await reopened.reset();
  const fresh = new LinearClient({
    apiUrl: new URL("/graphql", reopened.url).href,
    apiKey: fixtureApiKeys.primary,
  });
  expect((await fresh.agentSessions()).nodes).toHaveLength(0);
  expect((await fresh.issues()).nodes).toHaveLength(0);
  expect(reopened.delivery.attempts()).toEqual([]);
  await expect(persisted.viewer).rejects.toThrow();
});

test("agent controls authenticate fixture humans, validate input, and enforce workspace isolation", async () => {
  const c = await setup();
  const agent = await install(c.application, c.clients[0]!);
  const issue = (await (
    await c.human.createIssue({ teamId: fixtureIds.primary.team, title: "Controls" })
  ).issue)!;
  for (const authorization of [fixtureApiKeys.primary, `Bearer ${agent.token}`]) {
    for (const action of ["delegate", "mention", "prompt", "stop"]) {
      expect(
        (
          await fetch(new URL(`/__test/agents/${action}`, c.application.url), {
            method: "POST",
            headers: { authorization },
            body: "invalid",
          })
        ).status,
      ).toBe(401);
    }
  }
  for (const body of [
    { issueId: issue.id, appUserId: agent.user.id, fixture: "unknown" },
    { issueId: issue.id, appUserId: agent.user.id, principal: {} },
    { issueId: issue.id },
    { issueId: issue.id, appUserId: 1 },
  ])
    expect((await control(c.application, "delegate", body)).status).toBe(400);
  expect(
    (
      await control(c.application, "delegate", {
        fixture: "secondary",
        issueId: issue.id,
        appUserId: agent.user.id,
      })
    ).status,
  ).not.toBe(200);
  const delegated = await control(c.application, "delegate", {
    issueId: issue.id,
    appUserId: agent.user.id,
  });
  expect(delegated.status).toBe(200);
  expect((await agent.sdk.agentSessions()).nodes).toHaveLength(1);
  const mentioned = await control(c.application, "mention", {
    issueId: issue.id,
    appUserId: agent.user.id,
  });
  expect(mentioned.status).toBe(200);
  const mentionedId = String((await mentioned.json()).entity.id);
  expect((await control(c.application, "stop", { sessionId: mentionedId })).status).toBe(200);
  expect((await agent.sdk.agentSession(mentionedId)).status).toBe(
    LinearDocument.AgentSessionStatus.Stopping,
  );
  await agent.sdk.createAgentActivity({
    agentSessionId: mentionedId,
    content: { type: "response", body: "Stopped" },
  });
  expect((await agent.sdk.agentSession(mentionedId)).status).toBe(
    LinearDocument.AgentSessionStatus.Complete,
  );
});

test("integrated acknowledgment and inactivity clocks recover through activity and external links", async () => {
  const c = await setup();
  const agent = await install(c.application, c.clients[0]!);
  const issue = (await (
    await c.human.createIssue({ teamId: fixtureIds.primary.team, title: "Timed" })
  ).issue)!;
  const session = (await (
    await agent.sdk.agentSessionCreateOnIssue({ issueId: issue.id })
  ).agentSession)!;
  await c.application.advance(9999);
  expect((await agent.sdk.agentSession(session.id)).status).toBe(
    LinearDocument.AgentSessionStatus.Pending,
  );
  await c.application.advance(1);
  expect((await agent.sdk.agentSession(session.id)).status).toBe(
    LinearDocument.AgentSessionStatus.Stale,
  );
  await agent.sdk.updateAgentSession(session.id, {
    addedExternalUrls: [{ label: "Run", url: "https://example.test/run" }],
  });
  expect((await agent.sdk.agentSession(session.id)).status).toBe(
    LinearDocument.AgentSessionStatus.Active,
  );
  await c.application.advance(1800000);
  expect((await agent.sdk.agentSession(session.id)).status).toBe(
    LinearDocument.AgentSessionStatus.Stale,
  );
  await agent.sdk.createAgentActivity({
    agentSessionId: session.id,
    content: { type: "thought", body: "Recovered" },
  });
  expect((await agent.sdk.agentSession(session.id)).status).toBe(
    LinearDocument.AgentSessionStatus.Active,
  );
  const plan = [
    { content: "Implement", status: "inProgress" },
    { content: "Verify", status: "pending" },
  ];
  await agent.sdk.updateAgentSession(session.id, { plan });
  expect((await agent.sdk.agentSession(session.id)).plan as unknown).toEqual(plan);
});

test("create-only OAuth delegation authorizes session callback once and never escalates write scope", async () => {
  const c = await setup();
  const agent = await install(c.application, c.clients[0]!);
  const creator = await install(c.application, c.clients[1]!, "read,issues:create");
  const payload = await creator.sdk.createIssue({
    teamId: fixtureIds.primary.team,
    title: "Create-only delegated",
    delegateId: agent.user.id,
  });
  expect(payload.success).toBe(true);
  const issue = (await payload.issue)!;
  expect((await issue.creator)?.id).toBe(creator.user.id);
  expect((await issue.delegate)?.id).toBe(agent.user.id);
  await c.application.drain();
  const created = events(c.captured).filter((event) => event.action === "created");
  expect(created).toHaveLength(1);
  expect(created[0].appUserId).toBe(agent.user.id);
  expect(created[0].oauthClientId).toBe(c.clients[0]!.id);
  expect((await agent.sdk.agentSession(created[0].agentSession.id)).status).toBe(
    LinearDocument.AgentSessionStatus.Pending,
  );
  await expect(creator.sdk.updateIssue(issue.id, { title: "Denied write" })).rejects.toThrow();
  expect((await creator.sdk.issue(issue.id)).title).toBe("Create-only delegated");
});

test("delegation and mention use eligible live installation grants rather than first grant", async () => {
  const c = await setup();
  const restricted = await install(c.application, c.clients[0]!, "read,write");
  const capable = await install(c.application, c.clients[0]!);
  expect(restricted.user.id).toBe(capable.user.id);
  c.application.runtime.database.transaction((tx) => {
    const grants = tx
      .query<{ id: string; scopes: string }>(
        "SELECT id, scopes FROM oauth_grants WHERE user_id = ? ORDER BY id",
      )
      .all(capable.user.id);
    const restrictedGrant = grants.find(
      (grant) => !(JSON.parse(grant.scopes) as string[]).includes("app:assignable"),
    )!;
    const capableGrant = grants.find((grant) =>
      (JSON.parse(grant.scopes) as string[]).includes("app:assignable"),
    )!;
    const ordered = [restrictedGrant.id, capableGrant.id].sort();
    if (restrictedGrant.id !== ordered[0]) {
      tx.run(
        "UPDATE oauth_grants SET scopes = ? WHERE id = ?",
        capableGrant.scopes,
        restrictedGrant.id,
      );
      tx.run(
        "UPDATE oauth_grants SET scopes = ? WHERE id = ?",
        restrictedGrant.scopes,
        capableGrant.id,
      );
    }
  });
  const issue = (await (
    await c.human.createIssue({ teamId: fixtureIds.primary.team, title: "Multiple grant target" })
  ).issue)!;
  expect((await c.human.updateIssue(issue.id, { delegateId: capable.user.id })).success).toBe(true);
  const mentioned = await control(c.application, "mention", {
    issueId: issue.id,
    appUserId: capable.user.id,
  });
  expect(mentioned.status).toBe(200);
  await c.application.drain();
  expect(events(c.captured).filter((event) => event.action === "created")).toHaveLength(2);
});
