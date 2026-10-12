import { expect, test } from "bun:test";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import { createIdentity, identityMigrations, fixtureOAuthClient } from "../../src/identity";
import { fixtureApiKeys } from "../../src/identity/fixture";
import { Workspace } from "../../src/workspace/entities";
import {
  workspaceEntityMigrations,
  workspaceEntityResetOwner,
} from "../../src/workspace/entity-schema";
import { fixtureIds } from "../../src/workspace/fixtures";
import { agentMigrations, agentsResetOwner, createAgents } from "../../src/workspace/agents";
import { startServer } from "../../src/server";

test("child mention preserves source and root, delegation callback is transactional and idempotent", async () => {
  const runtime = createRuntime({
    databasePath: ":memory:",
    migrations: [workspaceEntityMigrations, identityMigrations, agentMigrations],
  });
  const identity = createIdentity(runtime);
  resetRuntime(runtime, [workspaceEntityResetOwner, identity.resetOwner, agentsResetOwner]);
  const server = startServer({ port: 0, handlers: [identity.handler] });
  try {
    const base = server.url.origin;
    const query = new URLSearchParams({
      client_id: fixtureOAuthClient.id,
      redirect_uri: fixtureOAuthClient.redirectUris[0],
      response_type: "code",
      actor: "app",
      scope: "read,write,app:mentionable,app:assignable",
    });
    const html = await (await fetch(base + "/oauth/authorize?" + query)).text();
    const post = (path: string, values: Record<string, string>) =>
      fetch(base + path, { method: "POST", body: new URLSearchParams(values), redirect: "manual" });
    const approved = await post("/oauth/authorize", {
      consent: /name="consent" value="([^"]+)"/.exec(html)![1]!,
      decision: "allow",
      user_id: fixtureIds.primary.user,
      workspace_id: fixtureIds.primary.organization,
      team_id: fixtureIds.primary.team,
    });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const token = await (
      await post("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: fixtureOAuthClient.id,
        client_secret: fixtureOAuthClient.secret,
        redirect_uri: fixtureOAuthClient.redirectUris[0],
      })
    ).json();
    const app = identity.authenticate(
      new Request(base, { headers: { authorization: `Bearer ${token.access_token}` } }),
    );
    const human = identity.authenticate(
      new Request(base, { headers: { authorization: fixtureApiKeys.primary } }),
    );
    const workspace = new Workspace(runtime);
    const agents = createAgents(runtime, workspace, identity);
    const issue = workspace.createIssue(human, {
      teamId: fixtureIds.primary.team,
      title: "Mention",
    }).entity;
    const root = workspace.createComment(human, { issueId: issue.id, body: "Root" }).entity;
    const child = workspace.createComment(human, {
      issueId: issue.id,
      parentId: root.id,
      body: "@Agent please help",
    }).entity;
    const session = agents.mention(human, issue.id, app.userId, child.id).entity;
    expect((session.comment as { id: string }).id).toBe(root.id);
    expect((session.sourceComment as { id: string }).id).toBe(child.id);
    const created = runtime.database
      .query<{ data: string }>("SELECT data FROM outbox WHERE resource_type = 'AgentSessionEvent'")
      .get()!;
    expect(
      JSON.parse(created.data).previousComments.map((comment: { id: string }) => comment.id),
    ).toEqual([root.id]);
    expect(agents.sessionForComment(app, child.id)?.id).toBe(session.id);
    expect(agents.delegate(human, issue.id, app.userId)?.entity.id).toBe(session.id);
    expect(agents.delegate(human, issue.id, app.userId)).toBeNull();
    expect(
      runtime.database
        .query<{ count: number }>("SELECT count(*) AS count FROM agent_sessions")
        .get()!.count,
    ).toBe(1);
    const another = workspace.createIssue(human, {
      teamId: fixtureIds.primary.team,
      title: "Other",
    }).entity;
    expect(() => agents.mention(human, another.id, app.userId, child.id)).toThrow("another issue");
    runtime.database.transaction((tx) =>
      tx.run('UPDATE oauth_grants SET scopes = \'["read","write"]\' WHERE id = ?', app.grantId),
    );
    expect(() => agents.mention(human, another.id, app.userId)).toThrow();
    expect(() => agents.delegate(human, another.id, app.userId)).toThrow();
    expect(workspace.requireIssue(human, another.id).delegateId).toBeNull();
  } finally {
    server.stop(true);
    runtime.close();
  }
});
