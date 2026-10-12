import { afterEach, describe, expect, test } from "bun:test";
import { buildSchema, GraphQLScalarType } from "graphql";
import { createRuntime, resetRuntime, type Runtime } from "../../src/core/runtime";
import { DomainError, errorResponse } from "../../src/core/errors";
import {
  requireAdmin,
  requireOrganization,
  requireOwningApp,
  requireScope,
  requireTeam,
  type Principal,
} from "../../src/core/principal";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { composeResolvers, executeGraphQL, installResolvers } from "../../src/graphql/composition";
import { createControlHandler } from "../../src/testing/control";
import { startServer } from "../../src/server";

const runtimes: Runtime[] = [];
const servers: ReturnType<typeof startServer>[] = [];
function setup() {
  const runtime = createRuntime({ databasePath: ":memory:", clockSource: () => fixtureTime });
  runtimes.push(runtime);
  resetRuntime(runtime);
  return runtime;
}
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const principal: Principal = {
  organizationId: fixtureIds.primary.organization,
  userId: fixtureIds.primary.user,
  actor: "apiKey",
  oauthClientId: null,
  installationId: null,
  grantId: null,
  scopes: ["read"],
  teamIds: [fixtureIds.primary.team],
  admin: true,
};

describe("permission guards", () => {
  test("enforces workspace and team isolation even for admin readers", () => {
    expect(() => requireOrganization(principal, fixtureIds.primary.organization)).not.toThrow();
    expect(() => requireOrganization(principal, fixtureIds.secondary.organization)).toThrow(
      "Workspace",
    );
    expect(() =>
      requireTeam(principal, {
        id: fixtureIds.primary.team,
        organizationId: fixtureIds.primary.organization,
      }),
    ).not.toThrow();
    expect(() =>
      requireTeam(principal, {
        id: fixtureIds.primary.privateTeam,
        organizationId: fixtureIds.primary.organization,
      }),
    ).toThrow("Team");
    expect(() =>
      requireTeam(principal, {
        id: fixtureIds.secondary.team,
        organizationId: fixtureIds.secondary.organization,
      }),
    ).toThrow("Workspace");
    expect(() => requireScope(principal, "write")).toThrow("scope");
    expect(() => requireScope({ ...principal, scopes: ["admin"] }, "write")).toThrow("scope");
    expect(() => requireAdmin(principal)).not.toThrow();
    expect(() => requireAdmin({ ...principal, actor: "app" })).toThrow("Administrator");
  });
  test("requires app actor, user, client, installation, and workspace together", () => {
    const owner = {
      organizationId: fixtureIds.primary.organization,
      appUserId: "app-user",
      oauthClientId: "client",
      installationId: "install",
    };
    const app: Principal = {
      ...principal,
      actor: "app",
      userId: owner.appUserId,
      oauthClientId: owner.oauthClientId,
      installationId: owner.installationId,
    };
    expect(() => requireOwningApp(app, owner)).not.toThrow();
    for (const change of [
      { actor: "user" as const },
      { userId: "other" },
      { oauthClientId: "other" },
      { installationId: "other" },
      { organizationId: fixtureIds.secondary.organization },
    ]) {
      expect(() => requireOwningApp({ ...app, ...change }, owner)).toThrow();
    }
  });
});

describe("GraphQL composition", () => {
  test("executes variables, aliases, fragments, operation selection, scalars and unions", async () => {
    const runtime = setup();
    const schema = buildSchema(`scalar Epoch
      type Organization { id: ID!, name: String! }
      type User { id: ID!, name: String! }
      union DirectoryEntry = Organization | User
      type Query { organization(id: ID!): Organization, clock: Epoch!, entry: DirectoryEntry! }`);
    const resolvers = composeResolvers({
      Query: {
        organization: (_source, args, context) => {
          requireOrganization(context.principal, String(args.id));
          return context.runtime.database
            .query("SELECT id, name FROM organizations WHERE id = ?")
            .get(String(args.id));
        },
        clock: (_source, _args, context) => context.runtime.clock.now(),
        entry: () => ({ __typename: "User", id: principal.userId, name: "Human 1" }),
      },
    });
    installResolvers(schema, resolvers, [
      new GraphQLScalarType({
        name: "Epoch",
        serialize: (value) => new Date(Number(value)).toISOString(),
      }),
    ]);
    const result = await executeGraphQL(
      schema,
      {
        query: `query Unselected { clock }
        query Selected($id: ID!) { record: organization(id: $id) { ...Fields } clock entry { __typename ... on User { name } } }
        fragment Fields on Organization { id name }`,
        variables: { id: principal.organizationId },
        operationName: "Selected",
      },
      { runtime, principal },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      record: { id: principal.organizationId, name: "Workspace 1" },
      clock: new Date(fixtureTime).toISOString(),
      entry: { __typename: "User", name: "Human 1" },
    });
    const invalid = await executeGraphQL(
      schema,
      { query: "{ nonexistent }" },
      { runtime, principal },
    );
    expect(invalid.errors?.[0]?.message).toContain("Cannot query field");
    const denied = await executeGraphQL(
      schema,
      { query: '{ organization(id: "wrong") { id } }' },
      { runtime, principal },
    );
    expect(denied.errors?.[0]?.extensions.code).toBe("FORBIDDEN");
  });
  test("rejects duplicate and invalid registrations and redacts internal errors", async () => {
    const resolver = () => "ok";
    expect(() =>
      composeResolvers({ Query: { value: resolver } }, { Query: { value: resolver } }),
    ).toThrow("Duplicate");
    expect(() =>
      installResolvers(buildSchema("type Query { value: String }"), {
        Missing: { value: resolver },
      }),
    ).toThrow("Unknown object");
    const schema = buildSchema("type Query { value: String }");
    installResolvers(schema, {
      Query: {
        value: () => {
          throw new Error("secret sql password");
        },
      },
    });
    expect(() => installResolvers(schema, { Query: { value: resolver } })).toThrow(
      "already installed",
    );
    const result = await executeGraphQL(
      schema,
      { query: "{ value }" },
      { runtime: setup(), principal },
    );
    expect(result.errors?.[0]?.message).toBe("Internal server error");
    expect(JSON.stringify(result)).not.toContain("password");
    expect(await errorResponse(new Error("secret")).text()).not.toContain("secret");
    expect(errorResponse(new DomainError("NOT_FOUND", "Missing")).status).toBe(404);
  });
});

describe("control HTTP isolation", () => {
  test("requires only dedicated token and validates clock actions", async () => {
    const runtime = setup();
    const server = startServer({
      port: 0,
      handlers: [createControlHandler({ token: "control-only", clock: runtime.clock })],
    });
    servers.push(server);
    for (const authorization of [
      "",
      "fixture-api-key",
      "Bearer oauth-user",
      "Bearer oauth-app",
      "control-only",
    ]) {
      const response = await fetch(new URL("/__test/clock", server.url), {
        headers: { authorization },
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("control-only");
    }
    const headers = { authorization: "Bearer control-only", "content-type": "application/json" };
    const before = await fetch(new URL("/__test/clock", server.url), { headers });
    expect(await before.json()).toEqual({ now: fixtureTime });
    const advance = await fetch(new URL("/__test/clock/advance", server.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ milliseconds: 42 }),
    });
    expect(await advance.json()).toEqual({ now: fixtureTime + 42 });
    for (const body of ["invalid", "{}", '{"milliseconds":-1}', '{"milliseconds":"42"}']) {
      const response = await fetch(new URL("/__test/clock/advance", server.url), {
        method: "POST",
        headers,
        body,
      });
      expect(response.status).toBe(400);
    }
    expect(runtime.clock.now()).toBe(fixtureTime + 42);
    expect((await fetch(new URL("/health", server.url))).status).toBe(200);
  });
  test("is disabled without a configured token", async () => {
    const server = startServer({
      port: 0,
      handlers: [createControlHandler({ clock: setup().clock })],
    });
    servers.push(server);
    const response = await fetch(new URL("/__test/clock", server.url), {
      headers: { authorization: "Bearer anything" },
    });
    expect(response.status).toBe(404);
  });
});
