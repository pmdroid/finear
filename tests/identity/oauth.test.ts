import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearClient } from "@linear/sdk";
import { GraphQLScalarType } from "graphql";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import { requireAdmin, requireScope } from "../../src/core/principal";
import {
  createIdentity,
  fixtureOAuthClient,
  fixtureOAuthPublicClient,
  identityMigrations,
  identityResolvers,
  oauthLifetimes,
  type IdentityOptions,
} from "../../src/identity";
import { fixtureApiKeys } from "../../src/identity/fixture";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { startServer, type HttpHandler } from "../../src/server";
import { deriveSchema, loadContract } from "../../src/graphql/contract";
import { composeResolvers, executeGraphQL, installResolvers } from "../../src/graphql/composition";
import { supportingResolvers } from "../../src/workspace/supporting";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const verifier = "a".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const primary = fixtureIds.primary;

function setup(options: IdentityOptions = {}, databasePath = ":memory:") {
  const runtime = createRuntime({
    databasePath,
    clockSource: () => fixtureTime,
    migrations: [identityMigrations],
  });
  cleanup.push(() => runtime.close());
  const identity = createIdentity(runtime, options);
  resetRuntime(runtime, [identity.resetOwner]);
  const server = startServer({ port: 0, handlers: [identity.handler] });
  cleanup.push(() => server.stop(true));
  const base = server.url.origin;
  const post = (
    path: string,
    values: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: "POST",
      body: new URLSearchParams(values),
      headers,
      redirect: "manual",
    });
  const bearer = (access: string) =>
    identity.authenticate(new Request(base, { headers: { authorization: `Bearer ${access}` } }));
  const authorize = async (overrides: Record<string, string> = {}) => {
    const query = new URLSearchParams({
      client_id: fixtureOAuthClient.id,
      redirect_uri: fixtureOAuthClient.redirectUris[0],
      response_type: "code",
      scope: "read,write,app:assignable,app:mentionable",
      state: "state & original=?",
      actor: "app",
      ...overrides,
    });
    const response = await fetch(base + "/oauth/authorize?" + query, { redirect: "manual" });
    const body = await response.text();
    return { response, body, consent: /name="consent" value="([^"]+)"/.exec(body)?.[1] ?? "" };
  };
  const approve = (consent: string, overrides: Record<string, string> = {}) =>
    post("/oauth/authorize", {
      consent,
      decision: "allow",
      user_id: primary.user,
      workspace_id: primary.organization,
      team_id: primary.team,
      ...overrides,
    });
  const code = async (overrides: Record<string, string> = {}) => {
    const page = await authorize(overrides);
    expect(page.response.status).toBe(200);
    const response = await approve(page.consent);
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("state & original=?");
    return callback.searchParams.get("code")!;
  };
  const exchange = (
    value: string,
    overrides: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) =>
    post(
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code: value,
        redirect_uri: fixtureOAuthClient.redirectUris[0],
        ...(!headers.authorization
          ? { client_id: fixtureOAuthClient.id, client_secret: fixtureOAuthClient.secret }
          : {}),
        ...overrides,
      },
      headers,
    );
  const token = async (overrides: Record<string, string> = {}) => {
    const response = await exchange(await code(overrides));
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    }>;
  };
  const refresh = (value: string, overrides: Record<string, string> = {}) =>
    post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: value,
      client_id: fixtureOAuthClient.id,
      client_secret: fixtureOAuthClient.secret,
      ...overrides,
    });
  return {
    runtime,
    identity,
    server,
    base,
    post,
    bearer,
    authorize,
    approve,
    code,
    exchange,
    token,
    refresh,
  };
}

test("HTTP consent binds callback/state, creates a distinct app, stores hashes, and rejects replay", async () => {
  const c = setup();
  const page = await c.authorize();
  expect(page.body).toContain("Choose a fixture user and workspace");
  expect(page.body).toContain(fixtureIds.secondary.user);
  expect(page.response.headers.get("location")).toBeNull();
  const approval = await c.approve(page.consent);
  const callback = new URL(approval.headers.get("location")!);
  expect(callback.origin + callback.pathname).toBe(fixtureOAuthClient.redirectUris[0]);
  expect(callback.searchParams.get("state")).toBe("state & original=?");
  expect((await c.approve(page.consent)).status).toBe(400);
  const response = await c.exchange(callback.searchParams.get("code")!);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await response.json();
  expect(result.token_type).toBe("Bearer");
  expect(result.expires_in).toBe(86400);
  const principal = c.bearer(result.access_token);
  expect(principal.actor).toBe("app");
  expect(principal.userId).not.toBe(primary.user);
  expect(principal.admin).toBe(false);
  expect(principal.teamIds).toEqual([primary.team]);
  expect(c.identity.requireInstallation(c.runtime.database, principal).appUserId).toBe(
    principal.userId,
  );
  expect(() => requireAdmin(principal)).toThrow();
  const user = c.runtime.database
    .query<{ app: number; admin: number; settings: string }>("SELECT * FROM users WHERE id = ?")
    .get(principal.userId)!;
  expect(user.app).toBe(1);
  expect(user.admin).toBe(0);
  expect(JSON.parse(user.settings)).toMatchObject({
    active: true,
    guest: false,
    isAssignable: true,
    isMentionable: true,
  });
  const rows = JSON.stringify(c.runtime.database.query("SELECT * FROM oauth_tokens").all());
  expect(rows).not.toContain(result.access_token);
  expect(rows).not.toContain(result.refresh_token);
  expect(JSON.stringify(c.runtime.database.query("SELECT * FROM oauth_codes").all())).not.toContain(
    callback.searchParams.get("code")!,
  );
  expect(
    JSON.stringify(c.runtime.database.query("SELECT * FROM oauth_clients").all()),
  ).not.toContain(fixtureOAuthClient.secret);
  expect((await c.exchange(callback.searchParams.get("code")!)).status).toBe(400);
  expect(
    c.identity.authenticate(
      new Request(c.base, { headers: { authorization: fixtureApiKeys.primary } }),
    ).actor,
  ).toBe("apiKey");
});

test("invalid callback/client/response type/scope/actor/PKCE never redirect", async () => {
  const c = setup();
  for (const query of [
    { redirect_uri: "http://attacker.test/callback" },
    { client_id: "unknown" },
    { response_type: "token" },
    { scope: "read,admin" },
    { scope: "read,unknown" },
    { scope: "read write" },
    { actor: "application" },
    { code_challenge: "invalid" },
  ] as Record<string, string>[]) {
    const page = await c.authorize(query);
    expect(page.response.status).toBeGreaterThanOrEqual(400);
    expect(page.response.headers.get("location")).toBeNull();
  }
  expect((await fetch(c.base + "/oauth/authorize?client_id=a&client_id=b")).status).toBe(400);
});

test("consent rejects workspace/user mismatch, inaccessible teams, cross-origin and expiry; denial echoes state", async () => {
  const c = setup();
  for (const overrides of [
    { workspace_id: fixtureIds.secondary.organization },
    { user_id: fixtureIds.secondary.user },
    { team_id: primary.privateTeam },
    { team_id: fixtureIds.secondary.team },
  ] as Record<string, string>[]) {
    expect((await c.approve((await c.authorize()).consent, overrides)).status).toBe(403);
  }
  const page = await c.authorize();
  expect(
    (
      await c.post(
        "/oauth/authorize",
        { consent: page.consent, decision: "allow" },
        { origin: "http://attacker.test" },
      )
    ).status,
  ).toBe(403);
  c.runtime.clock.advance(oauthLifetimes.consent);
  expect((await c.approve(page.consent)).status).toBe(400);
  const denial = await c.approve((await c.authorize()).consent, { decision: "deny" });
  const callback = new URL(denial.headers.get("location")!);
  expect(callback.searchParams.get("error")).toBe("access_denied");
  expect(callback.searchParams.get("state")).toBe("state & original=?");
  expect(c.runtime.database.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
});

test("exchange checks credentials, exact redirect, code expiry, form encoding and Basic auth", async () => {
  const c = setup();
  const code = await c.code();
  expect((await c.exchange(code, { client_secret: "wrong" })).status).toBe(401);
  expect(
    (await c.exchange(code, { redirect_uri: fixtureOAuthClient.redirectUris[0] + "/" })).status,
  ).toBe(400);
  expect(
    (await c.exchange(code, { client_id: fixtureOAuthPublicClient.id, client_secret: "" })).status,
  ).toBe(401);
  expect(
    (
      await fetch(c.base + "/oauth/token", {
        method: "POST",
        body: JSON.stringify({ code }),
        headers: { "content-type": "application/json" },
      })
    ).status,
  ).toBe(400);
  const basic =
    "Basic " +
    Buffer.from(`${fixtureOAuthClient.id}:${fixtureOAuthClient.secret}`).toString("base64");
  expect((await c.exchange(code, {}, { authorization: basic })).status).toBe(200);
  const expiring = await c.code();
  c.runtime.clock.advance(oauthLifetimes.code);
  expect((await c.exchange(expiring)).status).toBe(400);
});

test("S256/plain PKCE reject wrong/missing verifiers; public refresh uses client_id alone", async () => {
  const c = setup();
  for (const method of ["S256", "plain"]) {
    const code = await c.code({
      client_id: fixtureOAuthPublicClient.id,
      code_challenge: method === "S256" ? challenge : verifier,
      code_challenge_method: method,
    });
    const form = {
      grant_type: "authorization_code",
      code,
      redirect_uri: fixtureOAuthClient.redirectUris[0],
      client_id: fixtureOAuthPublicClient.id,
    };
    expect((await c.post("/oauth/token", form)).status).toBe(400);
    expect((await c.post("/oauth/token", { ...form, code_verifier: "b".repeat(64) })).status).toBe(
      400,
    );
    const response = await c.post("/oauth/token", { ...form, code_verifier: verifier });
    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(c.bearer(tokens.access_token).actor).toBe("app");
    expect(
      (
        await c.post("/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: fixtureOAuthPublicClient.id,
        })
      ).status,
    ).toBe(200);
  }
  expect((await c.authorize({ client_id: fixtureOAuthPublicClient.id })).response.status).toBe(400);
});

test("user actor, exact scopes, live team membership and transaction ownership stay isolated", async () => {
  const c = setup();
  const tokens = await c.token({ actor: "user", scope: "read" });
  const principal = c.bearer(tokens.access_token);
  expect(principal.userId).toBe(primary.user);
  expect(principal.installationId).toBeNull();
  expect(principal.scopes).toEqual(["read"]);
  expect(() => requireScope(principal, "write")).toThrow();
  expect(() => requireAdmin(principal)).toThrow();
  c.runtime.database.transaction((tx) =>
    c.identity.requireAccess(tx, principal, {
      organizationId: primary.organization,
      teamId: primary.team,
      scope: "read",
    }),
  );
  expect(() =>
    c.runtime.database.transaction((tx) =>
      c.identity.requireAccess(tx, principal, {
        organizationId: fixtureIds.secondary.organization,
      }),
    ),
  ).toThrow();
  expect(() =>
    c.runtime.database.transaction((tx) =>
      c.identity.requireAccess(tx, principal, {
        organizationId: primary.organization,
        teamId: primary.privateTeam,
      }),
    ),
  ).toThrow();
  const app = c.bearer((await c.token()).access_token);
  expect(() =>
    c.identity.requireInstallation(c.runtime.database, { ...app, userId: primary.user }),
  ).toThrow();
  expect(() =>
    c.identity.requireInstallation(c.runtime.database, {
      ...app,
      oauthClientId: fixtureOAuthPublicClient.id,
    }),
  ).toThrow();
  c.runtime.database.transaction((tx) =>
    tx.run("DELETE FROM team_memberships WHERE user_id = ?", principal.userId),
  );
  expect(c.bearer(tokens.access_token).teamIds).toEqual([]);
  expect(() =>
    c.runtime.database.transaction((tx) =>
      c.identity.requireAccess(tx, principal, {
        organizationId: primary.organization,
        teamId: primary.team,
      }),
    ),
  ).toThrow();
});

test("expiry, rotation, deterministic recovery, grace boundary and refresh expiry use virtual time", async () => {
  const c = setup();
  const first = await c.token();
  c.runtime.clock.advance(oauthLifetimes.access);
  expect(() => c.bearer(first.access_token)).toThrow();
  expect((await c.refresh(first.refresh_token, { client_secret: "wrong" })).status).toBe(401);
  const refreshed = await c.refresh(first.refresh_token);
  expect(refreshed.status).toBe(200);
  const second = await refreshed.json();
  expect(second.refresh_token).not.toBe(first.refresh_token);
  expect(c.bearer(second.access_token).actor).toBe("app");
  expect(await (await c.refresh(first.refresh_token)).json()).toEqual(second);
  c.runtime.clock.advance(oauthLifetimes.recovery);
  expect((await c.refresh(first.refresh_token)).status).toBe(400);
  const next = await c.refresh(second.refresh_token);
  expect(next.status).toBe(200);
  expect(() => c.bearer(second.access_token)).toThrow();
  const third = await next.json();
  c.runtime.clock.advance(oauthLifetimes.refresh);
  expect((await c.refresh(third.refresh_token)).status).toBe(400);
});

test("revocation invalidates all installation grants, emits one routed event and denies replay", async () => {
  const c = setup();
  const first = await c.token();
  const second = await c.token();
  const principal = c.bearer(first.access_token);
  expect(c.bearer(second.access_token).installationId).toBe(principal.installationId);
  expect(
    (
      await c.post("/oauth/revoke", {
        token: first.refresh_token,
        access_token: first.access_token,
      })
    ).status,
  ).toBe(400);
  expect((await c.post("/oauth/revoke", { token: "invalid" })).status).toBe(401);
  expect(
    (
      await c.post("/oauth/revoke", {
        token: first.refresh_token,
        token_type_hint: "refresh_token",
      })
    ).status,
  ).toBe(200);
  expect(() => c.bearer(first.access_token)).toThrow();
  expect(() => c.bearer(second.access_token)).toThrow();
  expect((await c.refresh(second.refresh_token)).status).toBe(400);
  expect(() => c.identity.requireInstallation(c.runtime.database, principal)).toThrow();
  expect(() =>
    c.runtime.database.transaction((tx) =>
      c.identity.requireAccess(tx, principal, { organizationId: primary.organization }),
    ),
  ).toThrow();
  expect((await c.post("/oauth/revoke", { token: first.refresh_token })).status).toBe(400);
  expect(
    c.runtime.database
      .query("SELECT resource_type, action, data, target_app_user_id, oauth_client_id FROM outbox")
      .all(),
  ).toEqual([
    {
      resource_type: "OAuthApp",
      action: "revoked",
      data: "{}",
      target_app_user_id: principal.userId,
      oauth_client_id: fixtureOAuthClient.id,
    },
  ]);
});

test("legacy revocation accepts bearer/access/refresh fields for independent user grants", async () => {
  const c = setup();
  for (const field of ["access_token", "refresh_token", "header"] as const) {
    const tokens = await c.token({ actor: "user" });
    const result =
      field === "header"
        ? await c.post("/oauth/revoke", {}, { authorization: `Bearer ${tokens.access_token}` })
        : await c.post("/oauth/revoke", { [field]: tokens[field] });
    expect(result.status).toBe(200);
    expect(() => c.bearer(tokens.access_token)).toThrow();
  }
  expect(c.runtime.database.query("SELECT * FROM outbox").all()).toHaveLength(0);
});

test("concrete Delivery provisioning sees installation/app user and rolls back with consent", async () => {
  let fail = true;
  let calls = 0;
  const c = setup({
    clients: [
      {
        ...fixtureOAuthClient,
        webhook: {
          url: "http://127.0.0.1:6666/webhook",
          secret: "webhook-secret",
          resourceTypes: ["Issue"],
        },
      },
    ],
    provisionAppWebhook(tx, input) {
      calls++;
      expect(input.organizationId).toBe(primary.organization);
      expect(input.oauthClientId).toBe(fixtureOAuthClient.id);
      expect(input.resourceTypes).toEqual(["Issue"]);
      expect(input.url).toBe("http://127.0.0.1:6666/webhook");
      expect(input.secret).toBe("webhook-secret");
      expect(input.agentSessionEvents).toBe(false);
      expect(tx.query("SELECT id FROM users WHERE id = ?").get(input.appUserId)).not.toBeNull();
      expect(
        tx.query("SELECT id FROM oauth_installations WHERE app_user_id = ?").get(input.appUserId),
      ).not.toBeNull();
      tx.run("UPDATE organizations SET name = 'Provisioned' WHERE id = ?", input.organizationId);
      if (fail) throw new Error("provision failure");
      return "provisioned-webhook-id";
    },
  });
  const page = await c.authorize();
  expect((await c.approve(page.consent)).status).toBe(500);
  expect(c.runtime.database.query("SELECT * FROM oauth_installations").all()).toHaveLength(0);
  expect(c.runtime.database.query("SELECT * FROM users WHERE app = 1").all()).toHaveLength(0);
  expect(
    c.runtime.database
      .query<{ name: string }>("SELECT name FROM organizations WHERE id = ?")
      .get(primary.organization)!.name,
  ).toBe("Workspace 1");
  fail = false;
  expect((await c.approve(page.consent)).status).toBe(302);
  await c.token();
  expect(calls).toBe(2);
});

test("persistent tokens/recovery survive reopen and reset restores seeded clients", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finear-identity-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const c = setup({}, join(directory, "db.sqlite"));
  const tokens = await c.token();
  const refreshed = await (await c.refresh(tokens.refresh_token)).json();
  c.server.stop(true);
  c.runtime.close();
  const runtime = createRuntime({
    databasePath: join(directory, "db.sqlite"),
    clockSource: () => fixtureTime,
    migrations: [identityMigrations],
  });
  cleanup.push(() => runtime.close());
  const identity = createIdentity(runtime);
  expect(
    identity.authenticate(
      new Request("http://localhost/graphql", {
        headers: { authorization: `Bearer ${refreshed.access_token}` },
      }),
    ).actor,
  ).toBe("app");
  const server = startServer({ port: 0, handlers: [identity.handler] });
  cleanup.push(() => server.stop(true));
  const recovery = await fetch(new URL("/oauth/token", server.url), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: fixtureOAuthClient.id,
      client_secret: fixtureOAuthClient.secret,
    }),
  });
  expect(await recovery.json()).toEqual(refreshed);
  resetRuntime(runtime, [identity.resetOwner]);
  expect(runtime.database.query("SELECT * FROM oauth_tokens").all()).toHaveLength(0);
  expect(runtime.database.query("SELECT * FROM users WHERE app = 1").all()).toHaveLength(0);
  expect(runtime.database.query("SELECT * FROM oauth_clients").all()).toHaveLength(2);
});

test("unchanged SDK reads app viewer over real HTTP with test-only injected identity composition", async () => {
  const c = setup();
  const { source } = await loadContract();
  const schema = deriveSchema(source);
  installResolvers(schema, composeResolvers(supportingResolvers(), identityResolvers()), [
    new GraphQLScalarType({
      name: "DateTime",
      serialize: (value) => new Date(Number(value)).toISOString(),
    }),
    new GraphQLScalarType({ name: "JSONObject", serialize: (value) => value }),
    new GraphQLScalarType({ name: "JSON", serialize: (value) => JSON.stringify(value) }),
  ]);
  const graphql: HttpHandler = async (request) => {
    if (new URL(request.url).pathname !== "/graphql") return null;
    return Response.json(
      await executeGraphQL(schema, await request.json(), {
        principal: c.identity.authenticate(request),
        runtime: c.runtime,
      }),
    );
  };
  const server = startServer({ port: 0, handlers: [c.identity.handler, graphql] });
  cleanup.push(() => server.stop(true));
  const client = new LinearClient({
    apiUrl: new URL("/graphql", server.url).href,
    accessToken: (await c.token()).access_token,
  });
  const viewer = await client.viewer;
  expect(viewer.app).toBe(true);
  expect(viewer.id).not.toBe(primary.user);
  expect(viewer.admin).toBe(false);
  expect(viewer.isMe).toBe(true);
  expect(viewer.active).toBe(true);
  expect(viewer.isAssignable).toBe(true);
  expect(viewer.isMentionable).toBe(true);
  const reader = new LinearClient({
    apiUrl: new URL("/graphql", server.url).href,
    accessToken: (await c.token({ scope: "read" })).access_token,
  });
  expect((await reader.viewer).isAssignable).toBe(false);
  expect((await reader.viewer).isMentionable).toBe(false);
  expect((await viewer.teams()).nodes.map((team) => team.id)).toEqual([primary.team]);
  expect((await client.organization).userCount).toBe(2);
});
