import { afterEach, expect, test } from "bun:test";
import { createRuntime, resetRuntime, type Runtime } from "../../src/core/runtime";
import {
  createIdentity,
  fixtureOAuthClient,
  identityMigrations,
  requireDelegate,
  requireMention,
} from "../../src/identity";
import { createAppUser } from "../../src/workspace/directory";
import { requireAdmin } from "../../src/core/principal";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { startServer } from "../../src/server";

let runtime: Runtime | undefined;
let server: ReturnType<typeof startServer> | undefined;
afterEach(() => {
  server?.stop(true);
  runtime?.close();
  server = undefined;
  runtime = undefined;
});

function setup() {
  runtime = createRuntime({
    databasePath: ":memory:",
    clockSource: () => fixtureTime,
    migrations: [identityMigrations],
  });
  const identity = createIdentity(runtime, {
    clients: [
      fixtureOAuthClient,
      { ...fixtureOAuthClient, id: "other-client", secret: "other-secret" },
    ],
  });
  resetRuntime(runtime, [identity.resetOwner]);
  server = startServer({ port: 0, handlers: [identity.handler] });
  const base = server.url.origin;
  const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      body: new URLSearchParams(form),
      headers,
      redirect: "manual",
    });
  const consent = async (actor: string, scope: string) => {
    const result = await fetch(
      base +
        "/oauth/authorize?" +
        new URLSearchParams({
          client_id: fixtureOAuthClient.id,
          redirect_uri: fixtureOAuthClient.redirectUris[0],
          response_type: "code",
          actor,
          scope,
        }),
    );
    return /name="consent" value="([^"]+)"/.exec(await result.text())![1]!;
  };
  const approve = (nonce: string, fixture: keyof typeof fixtureIds = "secondary") =>
    post("/oauth/authorize", {
      consent: nonce,
      decision: "allow",
      user_id: fixtureIds[fixture].user,
      workspace_id: fixtureIds[fixture].organization,
      team_id: fixtureIds[fixture].team,
    });
  const exchange = (
    code: string,
    client = fixtureOAuthClient.id as string,
    secret = fixtureOAuthClient.secret as string,
  ) =>
    post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: fixtureOAuthClient.redirectUris[0],
      client_id: client,
      client_secret: secret,
    });
  return { identity, base, post, consent, approve, exchange };
}

test("secondary fixture approval authenticates that workspace; wrong valid client cannot exchange", async () => {
  const c = setup();
  const approved = await c.approve(await c.consent("user", "admin"));
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  expect((await c.exchange(code, "other-client", "other-secret")).status).toBe(400);
  const response = await c.exchange(code);
  expect(response.status).toBe(200);
  const tokens = await response.json();
  const principal = c.identity.authenticate(
    new Request(c.base, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
  );
  expect(principal.organizationId).toBe(fixtureIds.secondary.organization);
  expect(principal.userId).toBe(fixtureIds.secondary.user);
  expect(principal.teamIds).toEqual([fixtureIds.secondary.team]);
  expect(() => requireAdmin(principal)).not.toThrow();
  const refreshed = await c.post(
    "/oauth/token",
    { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    {
      authorization:
        "Basic " +
        Buffer.from(`${fixtureOAuthClient.id}:${fixtureOAuthClient.secret}`).toString("base64"),
    },
  );
  expect(refreshed.status).toBe(200);
});

test("non-admin humans cannot install app actors or approve admin scope", async () => {
  const c = setup();
  runtime!.database.transaction((tx) =>
    tx.run("UPDATE users SET admin = 0 WHERE id = ?", fixtureIds.secondary.user),
  );
  expect((await c.approve(await c.consent("app", "read"))).status).toBe(403);
  expect((await c.approve(await c.consent("user", "admin"))).status).toBe(403);
  expect((await c.approve(await c.consent("user", "read"))).status).toBe(302);
});

test("revocation and pending authorization code writes roll back together on outbox failure", async () => {
  const c = setup();
  const approved = await c.approve(await c.consent("app", "read"));
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const tokens = await (await c.exchange(code)).json();
  runtime!.database.transaction((tx) =>
    tx.run(
      "CREATE TRIGGER reject_revocation BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'outbox rejected'); END",
    ),
  );
  expect((await c.post("/oauth/revoke", { token: tokens.access_token })).status).toBe(500);
  expect(
    c.identity.authenticate(
      new Request(c.base, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
    ).actor,
  ).toBe("app");
  expect(
    runtime!.database.query("SELECT * FROM oauth_installations WHERE revoked_at IS NOT NULL").all(),
  ).toHaveLength(0);
  expect(runtime!.database.query("SELECT * FROM outbox").all()).toHaveLength(0);
});

test("delegate target resolves actual installation and rejects invalid targets inside writes", async () => {
  const c = setup();
  const ids = fixtureIds.secondary;
  const approved = await c.approve(await c.consent("app", "read,app:assignable"));
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const tokens = await (await c.exchange(code)).json();
  const principal = c.identity.authenticate(
    new Request(c.base, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
  );
  const target: Parameters<typeof requireDelegate>[1] = {
    organizationId: ids.organization,
    teamId: ids.team,
    appUserId: principal.userId,
  };
  const expected = {
    organizationId: ids.organization,
    appUserId: principal.userId,
    oauthClientId: fixtureOAuthClient.id,
    installationId: principal.installationId!,
  };
  runtime!.database.transaction((tx) => expect(requireDelegate(tx, target)).toEqual(expected));
  const rejected = (input: typeof target) =>
    expect(() => runtime!.database.transaction((tx) => requireDelegate(tx, input))).toThrow("app");
  rejected({ ...target, appUserId: ids.user });
  rejected({ ...target, appUserId: "missing-app" });
  rejected({ ...target, teamId: ids.privateTeam });
  rejected({ ...target, organizationId: fixtureIds.primary.organization });
  rejected({ ...target, teamId: fixtureIds.primary.team });
  runtime!.database.transaction((tx) =>
    createAppUser(tx, {
      id: "uninstalled-app",
      organizationId: ids.organization,
      name: "Uninstalled",
      email: "uninstalled@example.test",
      createdAt: tx.now,
    }),
  );
  rejected({ ...target, appUserId: "uninstalled-app" });
  const changes = [
    "UPDATE users SET settings = json_set(settings, '$.isAssignable', json('false')) WHERE app = 1",
    "UPDATE oauth_grants SET scopes = '[\"read\"]'",
    "UPDATE oauth_grants SET team_ids = '[]'",
    "UPDATE oauth_grants SET revoked_at = 1",
    "UPDATE oauth_grants SET actor = 'user'",
    "UPDATE oauth_grants SET client_id = 'other-client'",
    "DELETE FROM team_memberships WHERE user_id IN (SELECT id FROM users WHERE app = 1)",
    "UPDATE oauth_installations SET revoked_at = 1",
  ];
  for (const sql of changes) {
    expect(() =>
      runtime!.database.transaction((tx) => {
        tx.run("UPDATE organizations SET name = 'must roll back' WHERE id = ?", ids.organization);
        tx.run(sql);
        requireDelegate(tx, target);
      }),
    ).toThrow();
    runtime!.database.transaction((tx) => expect(requireDelegate(tx, target)).toEqual(expected));
    expect(
      runtime!.database
        .query<{ name: string }>("SELECT name FROM organizations WHERE id = ?")
        .get(ids.organization)!.name,
    ).toBe("Workspace 2");
  }
  expect((await c.post("/oauth/revoke", { token: tokens.access_token })).status).toBe(200);
  rejected(target);
});

test("delegate target requires assignable grant and approved membership together", async () => {
  const c = setup();
  const ids = fixtureIds.secondary;
  const approved = await c.approve(await c.consent("app", "read"));
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const tokens = await (await c.exchange(code)).json();
  const principal = c.identity.authenticate(
    new Request(c.base, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
  );
  const target: Parameters<typeof requireDelegate>[1] = {
    organizationId: ids.organization,
    teamId: ids.team,
    appUserId: principal.userId,
  };
  expect(() => runtime!.database.transaction((tx) => requireDelegate(tx, target))).toThrow();
  expect(() =>
    runtime!.database.transaction((tx) => {
      tx.run(
        "UPDATE users SET settings = json_set(settings, '$.isAssignable', json('true')) WHERE id = ?",
        principal.userId,
      );
      requireDelegate(tx, target);
    }),
  ).toThrow("not approved");
  const assignable = await c.approve(await c.consent("app", "read,app:assignable"));
  expect(assignable.status).toBe(302);
  runtime!.database.transaction((tx) =>
    expect(requireDelegate(tx, target).appUserId).toBe(principal.userId),
  );
});

test("mention and delegate resolve any matching grant without conflating capabilities", async () => {
  const c = setup();
  const ids = fixtureIds.secondary;
  const install = async (scope: string) => {
    const approved = await c.approve(await c.consent("app", scope));
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const tokens = await (await c.exchange(code)).json();
    return c.identity.authenticate(
      new Request(c.base, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
    );
  };
  const reader = await install("read");
  const target = { organizationId: ids.organization, teamId: ids.team, appUserId: reader.userId };
  await install("read,app:assignable");
  runtime!.database.transaction((tx) =>
    expect(requireDelegate(tx, target).appUserId).toBe(reader.userId),
  );
  expect(() => runtime!.database.transaction((tx) => requireMention(tx, target))).toThrow(
    "Mentionable",
  );
  await install("read,app:mentionable");
  runtime!.database.transaction((tx) =>
    expect(requireMention(tx, target).appUserId).toBe(reader.userId),
  );
  expect(() => runtime!.database.transaction((tx) => requireDelegate(tx, target))).toThrow(
    "Assignable",
  );
  await install("read,app:assignable,app:mentionable");
  runtime!.database.transaction((tx) => {
    tx.run("DELETE FROM oauth_tokens");
    tx.run("DELETE FROM oauth_codes");
    tx.run(
      "UPDATE oauth_grants SET id = CASE scopes WHEN '[\"read\"]' THEN '00-reader' WHEN '[\"read\",\"app:assignable\"]' THEN '10-assignable' WHEN '[\"read\",\"app:mentionable\"]' THEN '20-mentionable' ELSE '30-both' END",
    );
  });
  const grants = runtime!.database
    .query<{ id: string; scopes: string }>("SELECT id, scopes FROM oauth_grants ORDER BY id")
    .all();
  expect(grants.map((row) => row.id)).toEqual([
    "00-reader",
    "10-assignable",
    "20-mentionable",
    "30-both",
  ]);
  expect(JSON.parse(grants[0]!.scopes)).toEqual(["read"]);
  runtime!.database.transaction((tx) => {
    expect(requireMention(tx, target)).toEqual(requireDelegate(tx, target));
    tx.run("UPDATE oauth_grants SET revoked_at = 1 WHERE id = '30-both'");
    expect(requireMention(tx, target)).toEqual(requireDelegate(tx, target));
  });
});

test("mention validates active installation, tuple, team and grant capability with rollback", async () => {
  const c = setup();
  const ids = fixtureIds.secondary;
  const approved = await c.approve(await c.consent("app", "read,app:mentionable"));
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const tokens = await (await c.exchange(code)).json();
  const principal = c.identity.authenticate(
    new Request(c.base, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
  );
  const target: Parameters<typeof requireMention>[1] = {
    organizationId: ids.organization,
    teamId: ids.team,
    appUserId: principal.userId,
  };
  runtime!.database.transaction((tx) =>
    expect(requireMention(tx, target)).toEqual({
      organizationId: ids.organization,
      appUserId: principal.userId,
      installationId: principal.installationId!,
      oauthClientId: fixtureOAuthClient.id,
    }),
  );
  for (const invalid of [
    { ...target, appUserId: ids.user },
    { ...target, appUserId: "missing" },
    { ...target, organizationId: fixtureIds.primary.organization },
    { ...target, teamId: ids.privateTeam },
    { ...target, teamId: fixtureIds.primary.team },
  ]) {
    expect(() => runtime!.database.transaction((tx) => requireMention(tx, invalid))).toThrow();
  }
  for (const sql of [
    "UPDATE users SET settings = json_set(settings, '$.isMentionable', json('false')) WHERE app = 1",
    'UPDATE oauth_grants SET scopes = \'["read","app:assignable"]\'',
    "UPDATE oauth_grants SET team_ids = '[]'",
    "UPDATE oauth_grants SET revoked_at = 1",
    "UPDATE oauth_grants SET actor = 'user'",
    "UPDATE oauth_grants SET client_id = 'other-client'",
    "UPDATE oauth_grants SET installation_id = NULL",
    "DELETE FROM team_memberships WHERE user_id IN (SELECT id FROM users WHERE app = 1)",
    "UPDATE oauth_installations SET revoked_at = 1",
  ]) {
    expect(() =>
      runtime!.database.transaction((tx) => {
        tx.run("UPDATE organizations SET name = 'must roll back' WHERE id = ?", ids.organization);
        tx.run(sql);
        requireMention(tx, target);
      }),
    ).toThrow();
    runtime!.database.transaction((tx) =>
      expect(requireMention(tx, target).appUserId).toBe(principal.userId),
    );
    expect(
      runtime!.database
        .query<{ name: string }>("SELECT name FROM organizations WHERE id = ?")
        .get(ids.organization)!.name,
    ).toBe("Workspace 2");
  }
  expect((await c.post("/oauth/revoke", { token: tokens.access_token })).status).toBe(200);
  expect(() =>
    runtime!.database.transaction((tx) => {
      tx.run("UPDATE organizations SET name = 'revoked rollback' WHERE id = ?", ids.organization);
      requireMention(tx, target);
    }),
  ).toThrow();
  expect(
    runtime!.database
      .query<{ name: string }>("SELECT name FROM organizations WHERE id = ?")
      .get(ids.organization)!.name,
  ).toBe("Workspace 2");
});
