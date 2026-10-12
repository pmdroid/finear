import { expect, test } from "bun:test";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import type { Principal } from "../../src/core/principal";
import { DomainError } from "../../src/core/errors";
import {
  createIdentity,
  fixtureOAuthClient,
  identityMigrations,
  requireIdentityAccess,
  requireDelegate,
} from "../../src/identity";
import { Workspace } from "../../src/workspace/entities";
import {
  workspaceEntityMigrations,
  workspaceEntityResetOwner,
} from "../../src/workspace/entity-schema";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { createAppUser } from "../../src/workspace/directory";
import type { OnDelegated } from "../../src/workspace/types";

const ids = fixtureIds.primary;
const principal: Principal = {
  organizationId: ids.organization,
  userId: ids.user,
  actor: "apiKey",
  oauthClientId: null,
  installationId: null,
  grantId: null,
  scopes: ["read", "write"],
  teamIds: [ids.team, ids.privateTeam],
  admin: true,
};
function setup(onDelegated?: OnDelegated) {
  const runtime = createRuntime({
    databasePath: ":memory:",
    clockSource: () => fixtureTime,
    migrations: [workspaceEntityMigrations, identityMigrations],
  });
  const identity = createIdentity(runtime);
  resetRuntime(runtime, [workspaceEntityResetOwner, identity.resetOwner]);
  const workspace = new Workspace(runtime, {
    requireAccess: requireIdentityAccess,
    requireDelegate,
    onDelegated,
  });
  return { runtime, workspace };
}
function addUserGrant(runtime: ReturnType<typeof setup>["runtime"], scopes: string[]) {
  const id = crypto.randomUUID();
  runtime.database.transaction((tx) =>
    tx.run(
      "INSERT INTO oauth_grants(id, organization_id, client_id, user_id, actor, scopes, team_ids, pkce) VALUES(?, ?, ?, ?, 'user', ?, ?, 0)",
      id,
      ids.organization,
      fixtureOAuthClient.id,
      ids.user,
      JSON.stringify(scopes),
      JSON.stringify([ids.team, ids.privateTeam]),
    ),
  );
  return {
    ...principal,
    actor: "user" as const,
    oauthClientId: fixtureOAuthClient.id,
    grantId: id,
    scopes,
  };
}
function addDelegate(runtime: ReturnType<typeof setup>["runtime"]) {
  const appUserId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  runtime.database.transaction((tx) => {
    createAppUser(tx, {
      id: appUserId,
      organizationId: ids.organization,
      name: "Agent",
      email: "agent@example.test",
      createdAt: tx.now,
    });
    tx.run(
      "UPDATE users SET settings = ? WHERE id = ?",
      JSON.stringify({ isAssignable: true }),
      appUserId,
    );
    tx.run("INSERT INTO team_memberships VALUES(?, ?, ?)", ids.organization, ids.team, appUserId);
    tx.run(
      "INSERT INTO oauth_installations(id, organization_id, client_id, app_user_id, installer_id) VALUES(?, ?, ?, ?, ?)",
      installationId,
      ids.organization,
      fixtureOAuthClient.id,
      appUserId,
      ids.user,
    );
    tx.run(
      "INSERT INTO oauth_grants(id, organization_id, client_id, user_id, actor, installation_id, scopes, team_ids, pkce) VALUES(?, ?, ?, ?, 'app', ?, ?, ?, 0)",
      grantId,
      ids.organization,
      fixtureOAuthClient.id,
      appUserId,
      installationId,
      JSON.stringify(["read", "write", "app:assignable"]),
      JSON.stringify([ids.team]),
    );
  });
  return { appUserId, installationId, grantId };
}

test("injected Identity guard rejects stale captured grants and removed teams inside mutation tx", () => {
  const { runtime, workspace } = setup();
  try {
    const captured = addUserGrant(runtime, ["read", "write"]);
    const issue = workspace.createIssue(captured, {
      teamId: ids.team,
      title: "Before revoke",
    }).entity;
    runtime.database.transaction((tx) =>
      tx.run("UPDATE oauth_grants SET revoked_at = ? WHERE id = ?", tx.now, captured.grantId),
    );
    expect(() => workspace.updateIssue(captured, issue.id, { title: "After revoke" })).toThrow(
      "inactive",
    );
    expect(workspace.requireIssue(principal, issue.id).title).toBe("Before revoke");
    const capturedScope = addUserGrant(runtime, ["read", "write"]);
    runtime.database.transaction((tx) =>
      tx.run(
        "UPDATE oauth_grants SET scopes = ? WHERE id = ?",
        JSON.stringify(["read"]),
        capturedScope.grantId,
      ),
    );
    expect(() =>
      workspace.updateIssue(capturedScope, issue.id, { title: "Scope removed" }),
    ).toThrow("scope");
    runtime.database.transaction((tx) =>
      tx.run("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?", ids.team, ids.user),
    );
    expect(() => workspace.archiveIssue(principal, issue.id)).toThrow("Team access");
    expect(() => workspace.createComment(principal, { issueId: issue.id, body: "Denied" })).toThrow(
      "Team access",
    );
    expect(() => workspace.updateIssue(principal, issue.id, { teamId: ids.privateTeam })).toThrow(
      "Team access",
    );
  } finally {
    runtime.close();
  }
});

test("transaction guard preserves create-only scopes and checks new project teams", () => {
  const { runtime, workspace } = setup();
  try {
    const createOnly = addUserGrant(runtime, ["issues:create"]);
    const issue = workspace.createIssue(createOnly, {
      teamId: ids.team,
      title: "Create only",
    }).entity;
    const commentOnly = addUserGrant(runtime, ["comments:create"]);
    expect(
      workspace.createComment(commentOnly, { issueId: issue.id, body: "Create comment only" })
        .success,
    ).toBe(true);
    expect(() => workspace.updateIssue(createOnly, issue.id, { title: "No write" })).toThrow(
      "scope",
    );
    const project = workspace.createProject(principal, {
      name: "Project",
      teamIds: [ids.team],
    }).entity;
    expect(() =>
      workspace.updateProject(principal, project.id, { teamIds: [ids.team, ids.privateTeam] }),
    ).toThrow("Team access");
    expect(
      (workspace.requireProject(principal, project.id).teams as { id: string }[]).map(
        (team) => team.id,
      ),
    ).toEqual([ids.team]);
  } finally {
    runtime.close();
  }
});

test("validated delegation callback fires once and rolls all writes back on failure", () => {
  const calls: { issue: string; previous: string | null; owner: string | undefined }[] = [];
  let reject = false;
  const { runtime, workspace } = setup((tx, _principal, issue, previous, owner) => {
    calls.push({ issue: issue.id, previous, owner: owner?.installationId });
    tx.appendEvent({
      organizationId: ids.organization,
      teamId: ids.team,
      resourceType: "AgentSessionEvent",
      action: "created",
      occurredAt: tx.now,
      data: { issueId: issue.id },
    });
    void tx.syncId;
    if (reject) throw new DomainError("CONFLICT", "Agent creation failed");
  });
  try {
    const delegate = addDelegate(runtime);
    const issue = workspace.createIssue(principal, {
      teamId: ids.team,
      title: "Delegated",
      delegateId: delegate.appUserId,
    }).entity;
    expect(calls).toEqual([{ issue: issue.id, previous: null, owner: delegate.installationId }]);
    workspace.setDelegate(principal, issue.id, delegate.appUserId);
    workspace.updateIssue(principal, issue.id, { title: "Same delegate" });
    workspace.setDelegate(principal, issue.id, null);
    expect(calls).toHaveLength(1);
    runtime.database.transaction((tx) =>
      workspace.setDelegate(principal, issue.id, delegate.appUserId, tx),
    );
    expect(calls).toHaveLength(2);
    const state = () =>
      runtime.database
        .query<{ count: number; sync: number; number: number }>(
          "SELECT (SELECT count(*) FROM outbox) AS count, (SELECT value FROM sync_sequence) AS sync, (SELECT value FROM team_issue_numbers WHERE team_id = ?) AS number",
        )
        .get(ids.team)!;
    const before = state();
    reject = true;
    expect(() =>
      workspace.createIssue(principal, {
        teamId: ids.team,
        title: "Rollback",
        delegateId: delegate.appUserId,
      }),
    ).toThrow("Agent creation failed");
    expect(state()).toEqual(before);
    expect(workspace.listIssues(principal).nodes).toHaveLength(1);
    workspace.setDelegate(principal, issue.id, null);
    const cleared = state();
    expect(() => workspace.setDelegate(principal, issue.id, delegate.appUserId)).toThrow(
      "Agent creation failed",
    );
    expect(state()).toEqual(cleared);
    expect(workspace.requireIssue(principal, issue.id).delegateId).toBeNull();
    runtime.database.transaction((tx) =>
      tx.run(
        "UPDATE oauth_installations SET revoked_at = ? WHERE id = ?",
        tx.now,
        delegate.installationId,
      ),
    );
    expect(() => workspace.setDelegate(principal, issue.id, delegate.appUserId)).toThrow(
      "installation",
    );
  } finally {
    runtime.close();
  }
});

test("async delegation callbacks are rejected without committing writes", () => {
  const { runtime } = setup();
  try {
    const delegate = addDelegate(runtime);
    const workspace = new Workspace(runtime, {
      requireAccess: requireIdentityAccess,
      requireDelegate,
      onDelegated: async () => {},
    });
    expect(() =>
      workspace.createIssue(principal, {
        teamId: ids.team,
        title: "Async denied",
        delegateId: delegate.appUserId,
      }),
    ).toThrow("synchronous");
    expect(workspace.listIssues(principal).nodes).toHaveLength(0);
    expect(
      runtime.database.query<{ count: number }>("SELECT count(*) AS count FROM outbox").get()!
        .count,
    ).toBe(0);
  } finally {
    runtime.close();
  }
});

test("private entity lookups match absent entities without hiding scope denials", () => {
  const { runtime } = setup();
  try {
    const workspace = new Workspace(runtime);
    const issue = workspace.createIssue(principal, {
      teamId: ids.privateTeam,
      title: "Private",
    }).entity;
    const project = workspace.createProject(principal, {
      name: "Private",
      teamIds: [ids.privateTeam],
    }).entity;
    const comment = workspace.createComment(principal, {
      issueId: issue.id,
      body: "Private",
    }).entity;
    const label = workspace.createLabel(principal, {
      name: "Private",
      teamId: ids.privateTeam,
    }).entity;
    const restricted = { ...principal, teamIds: [ids.team] };
    for (const [get, id] of [
      [workspace.requireIssue.bind(workspace), issue.id],
      [workspace.requireProject.bind(workspace), project.id],
      [workspace.requireComment.bind(workspace), comment.id],
      [workspace.requireLabel.bind(workspace), label.id],
    ] as const) {
      for (const candidate of [id, crypto.randomUUID()]) {
        try {
          get(restricted, candidate);
          throw new Error("Expected denial");
        } catch (error) {
          expect((error as DomainError).code).toBe("NOT_FOUND");
        }
      }
      expect(() => get({ ...restricted, scopes: [] }, id)).toThrow("scope");
    }
  } finally {
    runtime.close();
  }
});
