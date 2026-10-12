import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearClient, LinearDocument } from "@linear/sdk";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { createApplication, type Application } from "../src/application";
import type { ClientRegistration } from "../src/identity";
import { fixtureApiKeys } from "../src/identity/fixture";
import { fixtureIds } from "../src/workspace/fixtures";

interface AgentEvent {
  type: string;
  action: string;
  appUserId: string;
  oauthClientId: string;
  agentSession: { id: string };
  agentActivity?: { content: { type: string; body: string } };
}

async function approveFixtureConsent(origin: URL, registration: ClientRegistration) {
  const state = crypto.randomUUID();
  const redirectUri = registration.redirectUris[0]!;
  const authorize = new URL("/oauth/authorize", origin);
  authorize.search = new URLSearchParams({
    client_id: registration.id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: registration.scopes.join(","),
    actor: "app",
    state,
  }).toString();
  const page = await fetch(authorize);
  assert.equal(page.status, 200);
  const consent = /name="consent" value="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(consent, "Fixture consent form is required");
  const approval = await fetch(new URL("/oauth/authorize", origin), {
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
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location")!);
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get("state"), state, "OAuth state must match");
  assert.equal(callback.searchParams.has("error"), false);
  const code = callback.searchParams.get("code");
  assert.ok(code, "Authorization code is required");
  const exchange = await fetch(new URL("/oauth/token", origin), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.id,
      client_secret: registration.secret!,
      redirect_uri: redirectUri,
      code,
    }),
  });
  assert.equal(exchange.status, 200);
  const tokens = (await exchange.json()) as { access_token: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

export async function runAgentExample() {
  const directory = mkdtempSync(join(tmpdir(), "finear-agent-example-"));
  const signingSecret = crypto.randomUUID();
  const controlToken = crypto.randomUUID();
  const verifier = new LinearWebhookClient(signingSecret);
  const seen = new Set<string>();
  const stats = { verified: 0, rejected: 0, duplicates: 0, processed: 0 };
  const statuses: string[] = [];
  const actions: string[] = [];
  let application: Application | undefined;
  let agent: LinearClient;
  let appUserId: string;
  let sessionId = "";
  let queue = Promise.resolve();
  let processingError: unknown;
  let firstDelivery: { body: Buffer; signature: string; id: string } | undefined;
  const clientId = crypto.randomUUID();

  async function processEvent(event: AgentEvent) {
    assert.equal(event.type, "AgentSessionEvent");
    assert.equal(event.oauthClientId, clientId);
    assert.equal(event.appUserId, appUserId);
    const id = event.agentSession.id;
    if (event.action === "created") {
      sessionId = id;
      statuses.push((await agent.agentSession(id)).status);
      assert.equal(statuses.at(-1), LinearDocument.AgentSessionStatus.Pending);
      assert.ok(
        (
          await agent.createAgentActivity({
            agentSessionId: id,
            content: { type: "thought", body: "I am investigating the delegated issue." },
            ephemeral: true,
          })
        ).success,
      );
      statuses.push((await agent.agentSession(id)).status);
      assert.equal(statuses.at(-1), LinearDocument.AgentSessionStatus.Active);
      assert.ok(
        (
          await agent.createAgentActivity({
            agentSessionId: id,
            content: { type: "elicitation", body: "Which branch should I use?" },
          })
        ).success,
      );
      statuses.push((await agent.agentSession(id)).status);
      assert.equal(statuses.at(-1), LinearDocument.AgentSessionStatus.AwaitingInput);
      console.log("Agent: signed created event → thought → elicitation (awaitingInput)");
    } else {
      assert.equal(event.action, "prompted");
      assert.equal(id, sessionId);
      assert.equal(event.agentActivity?.content.type, "prompt");
      assert.equal(event.agentActivity.content.body, "Use main");
      assert.ok(
        (
          await agent.createAgentActivity({
            agentSessionId: id,
            content: {
              type: "response",
              body: `Finished using ${event.agentActivity.content.body}.`,
            },
          })
        ).success,
      );
      statuses.push((await agent.agentSession(id)).status);
      assert.equal(statuses.at(-1), LinearDocument.AgentSessionStatus.Complete);
      console.log("Agent: signed prompted event → response (complete)");
    }
    actions.push(event.action);
    stats.processed++;
  }

  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/webhook" || request.method !== "POST")
        return new Response("Not found", { status: 404 });
      const body = Buffer.from(await request.arrayBuffer());
      const signature = request.headers.get("linear-signature") ?? "";
      try {
        verifier.verify(body, signature);
      } catch {
        stats.rejected++;
        return new Response("Invalid signature", { status: 401 });
      }
      const id = request.headers.get("linear-delivery");
      if (!id) return new Response("Delivery ID required", { status: 400 });
      stats.verified++;
      if (seen.has(id)) {
        stats.duplicates++;
        return new Response("Already accepted");
      }
      let event: AgentEvent;
      try {
        event = JSON.parse(body.toString()) as AgentEvent;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      seen.add(id);
      firstDelivery ??= { body, signature, id };
      queue = queue
        .then(() => processEvent(event))
        .catch((error: unknown) => {
          processingError ??= error;
        });
      return new Response("Accepted");
    },
  });

  async function waitForProcessed(count: number) {
    const deadline = Date.now() + 10000;
    while (stats.processed < count) {
      if (processingError) throw processingError;
      assert.ok(Date.now() < deadline, "Agent webhook processing timed out");
      await Bun.sleep(10);
    }
    await queue;
    if (processingError) throw processingError;
  }

  try {
    const registration: ClientRegistration = {
      id: clientId,
      name: "Example Agent",
      secret: crypto.randomUUID(),
      redirectUris: [new URL("/callback", receiver.url).href],
      scopes: ["read", "write", "app:assignable", "app:mentionable"],
      webhook: {
        url: new URL("/webhook", receiver.url).href,
        secret: signingSecret,
        resourceTypes: ["Project"],
        agentSessionEvents: true,
      },
    };
    application = await createApplication({
      databasePath: join(directory, "workspace.sqlite"),
      hostname: "127.0.0.1",
      port: 0,
      controlToken,
      clients: [registration],
    });
    console.log(
      `Resources: ${JSON.stringify({ application: application.url.href, receiver: receiver.url.href, directory })}`,
    );
    const apiUrl = new URL("/graphql", application.url).href;
    const human = new LinearClient({ apiUrl, apiKey: fixtureApiKeys.primary });
    agent = new LinearClient({
      apiUrl,
      accessToken: await approveFixtureConsent(application.url, registration),
    });
    const viewer = await agent.viewer;
    appUserId = viewer.id;
    assert.equal(viewer.app, true);
    assert.notEqual(viewer.id, fixtureIds.primary.user);
    console.log("OAuth: approved fixture consent, validated state, installed distinct app viewer");
    const issue = await (
      await human.createIssue({
        teamId: fixtureIds.primary.team,
        title: "Let the example agent investigate",
        assigneeId: fixtureIds.primary.user,
      })
    ).issue;
    assert.ok(issue);
    assert.ok((await human.updateIssue(issue.id, { delegateId: appUserId })).success);
    console.log(`Human: created ${issue.identifier}, kept human assignee, delegated to app`);
    await waitForProcessed(1);

    assert.ok(firstDelivery);
    const replayHeaders = {
      "content-type": "application/json",
      "linear-signature": firstDelivery.signature,
      "linear-delivery": firstDelivery.id,
    };
    const webhookUrl = new URL("/webhook", receiver.url);
    assert.equal(
      (
        await fetch(webhookUrl, {
          method: "POST",
          headers: replayHeaders,
          body: Buffer.concat([firstDelivery.body, Buffer.from(" ")]),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(webhookUrl, {
          method: "POST",
          headers: replayHeaders,
          body: new Uint8Array(firstDelivery.body),
        })
      ).status,
      200,
    );
    assert.equal(stats.processed, 1);
    console.log(
      "Receiver: rejected tampered bytes, acknowledged duplicate without processing twice",
    );

    const prompt = await fetch(new URL("/__test/agents/prompt", application.url), {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fixture: "primary", sessionId, body: "Use main" }),
    });
    assert.equal(prompt.status, 200);
    await prompt.json();
    console.log("Human: protected fixture prompt → Use main");
    await waitForProcessed(2);
    const completed = await agent.agentSession(sessionId);
    const activities = (await completed.activities()).nodes;
    const root = await completed.comment;
    assert.ok(root);
    const replies = (await root.children({ id: root.id })).nodes;
    const updatedIssue = await human.issue(issue.id);
    assert.equal((await updatedIssue.assignee)?.id, fixtureIds.primary.user);
    assert.equal((await updatedIssue.delegate)?.id, appUserId);
    assert.equal(root.body, "Which branch should I use?");
    assert.deepEqual(replies.map((comment) => comment.body).sort(), [
      "Finished using Use main.",
      "Use main",
    ]);
    assert.equal(activities.length, 4);
    assert.deepEqual(stats, { verified: 3, rejected: 1, duplicates: 1, processed: 2 });
    const result = {
      status: completed.status,
      issue: issue.identifier,
      appViewer: viewer.app,
      humanAssigneePreserved: true,
      actions,
      statuses,
      activities: activities.length,
      comments: 1 + replies.length,
      webhooks: stats,
    };
    console.log(`Result: ${JSON.stringify(result)}`);
    return result;
  } finally {
    await queue;
    try {
      await application?.close();
    } finally {
      await receiver.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  try {
    await runAgentExample();
  } catch {
    console.error("Agent example failed; check the local OAuth, SDK and webhook journey.");
    process.exitCode = 1;
  }
}
