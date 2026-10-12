import { afterEach, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { LinearClient } from "@linear/sdk";
import { request as httpRequest } from "node:http";
import { createRuntime, resetRuntime, type Runtime } from "../../src/core/runtime";
import { DomainError } from "../../src/core/errors";
import { authenticateFixture, fixtureApiKeys } from "../../src/identity/fixture";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { supportingResolvers } from "../../src/workspace/supporting";
import { createGraphQLHandler, type GraphQLHandlerOptions } from "../../src/graphql/http";
import { featureRoots } from "../../src/graphql/contract";
import { startServer } from "../../src/server";

const runtimes: Runtime[] = [];
const servers: ReturnType<typeof startServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const runtime of runtimes.splice(0)) runtime.close();
});

function runtimeFixture() {
  const runtime = createRuntime({ databasePath: ":memory:", clockSource: () => fixtureTime });
  runtimes.push(runtime);
  resetRuntime(runtime);
  return runtime;
}

async function setup(options: GraphQLHandlerOptions = {}, runtime = runtimeFixture()) {
  const server = startServer({ port: 0, handlers: [await createGraphQLHandler(runtime, options)] });
  servers.push(server);
  async function request(body: unknown, authorization: string = fixtureApiKeys.primary) {
    const response = await fetch(new URL("/graphql", server.url), {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  }
  return { runtime, server, request };
}

test("HTTP supporting reads execute aliases, named operations, nested fragments and variable coercion", async () => {
  const { request } = await setup();
  const query = `query Ignore { teams { nodes { id } } }
    query Read($id: String!) { selected: user(id: $id) { ...UserFields teams(first: 1) { nodes { ...TeamFields } } } }
    fragment UserFields on User { id name createdAt }
    fragment TeamFields on Team { id key }`;
  const result = await request({
    query,
    variables: { id: fixtureIds.primary.user },
    operationName: "Read",
  });
  expect(result.response.status).toBe(200);
  expect(result.body.errors).toBeUndefined();
  expect(result.body.data.selected).toEqual({
    id: fixtureIds.primary.user,
    name: "Human 1",
    createdAt: new Date(fixtureTime).toISOString(),
    teams: { nodes: [{ id: fixtureIds.primary.team, key: "ENG" }] },
  });
  for (const operationName of [undefined, "Missing"]) {
    const invalid = await request({
      query,
      variables: { id: fixtureIds.primary.user },
      operationName,
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.errors[0].extensions.type).toBe("graphql error");
  }
  for (const variables of [{}, { id: null }, { id: 123 }, { id: { token: "private-variable" } }]) {
    const invalid = await request({ query, variables, operationName: "Read" });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.errors[0].locations).toBeDefined();
    expect(JSON.stringify(invalid.body)).not.toContain("private-variable");
  }
});

test("HTTP parse and validation failures preserve GraphQL locations and SDK error types", async () => {
  const { request } = await setup();
  for (const query of [
    "{",
    "{ viewer { absent } }",
    "{ viewer { ...Missing } }",
    "{ viewer { ...Loop } } fragment Loop on User { ...Loop }",
    "{ user(id: 123) { id } }",
    "mutation { issueCreate(input: {}) { success } }",
  ]) {
    const result = await request({ query });
    expect(result.response.status).toBe(400);
    expect(result.body.errors[0].locations).toBeDefined();
    expect(result.body.errors[0].extensions.type).toBe("graphql error");
    expect(result.body.data ?? null).toBeNull();
  }
});

test("HTTP executed domain errors retain alias paths and locations with normal null propagation", async () => {
  const { request } = await setup();
  const result = await request({ query: 'query Missing { alias: user(id: "missing") { id } }' });
  expect(result.response.status).toBe(200);
  expect(result.body.data).toBeNull();
  expect(result.body.errors[0].path).toEqual(["alias"]);
  expect(result.body.errors[0].locations).toEqual([{ line: 1, column: 17 }]);
  expect(result.body.errors[0].extensions).toEqual({ code: "NOT_FOUND", type: "user error" });
});

test("async injectable authentication passes the principal into real supporting SDK reads before parsing", async () => {
  const runtime = runtimeFixture();
  const principal = authenticateFixture(
    new Request("http://localhost", { headers: { authorization: fixtureApiKeys.secondary } }),
    runtime,
  );
  let called = 0;
  const { server, request } = await setup(
    {
      authenticate: async (request) => {
        called++;
        if (request.headers.get("authorization") !== "Bearer local-oauth")
          throw new DomainError("UNAUTHENTICATED", "Invalid credential");
        return principal;
      },
      resolverMaps: [supportingResolvers()],
    },
    runtime,
  );
  const client = new LinearClient({
    apiUrl: new URL("/graphql", server.url).href,
    accessToken: "local-oauth",
  });
  expect((await client.viewer).id).toBe(fixtureIds.secondary.user);
  expect(called).toBe(2);
  expect((await client.organization).id).toBe(fixtureIds.secondary.organization);
  expect(called).toBe(4);
  const denied = await request({}, "Bearer denied-secret");
  expect(denied.response.status).toBe(401);
  expect(denied.body.errors[0].extensions.type).toBe("authentication error");
  expect(JSON.stringify(denied.body)).not.toContain("denied-secret");
  expect(called).toBe(5);
});

test.each(["read", "mutation"] as const)(
  "HTTP reauthenticates after a streamed body so revoked credentials cannot execute %s",
  async (operation) => {
    const runtime = runtimeFixture();
    let revoked = false;
    let calls = 0;
    let executions = 0;
    const authenticated = Promise.withResolvers<void>();
    const { server } = await setup(
      {
        authenticate: (request) => {
          calls++;
          if (revoked) throw new DomainError("UNAUTHENTICATED", "Credential revoked");
          const principal = authenticateFixture(request, runtime);
          authenticated.resolve();
          return principal;
        },
        roots: { query: ["viewer"], mutation: ["issueCreate"] },
        operations: [],
        resolverMaps: [
          {
            Query: {
              viewer: () => {
                executions++;
                return { id: fixtureIds.primary.user };
              },
            },
            Mutation: {
              issueCreate: () => {
                executions++;
                runtime.database.transaction((tx) =>
                  tx.run(
                    "UPDATE users SET name = ? WHERE id = ?",
                    "Unauthorized change",
                    fixtureIds.primary.user,
                  ),
                );
                throw new DomainError("INVALID_INPUT", "Mutation executed");
              },
            },
          },
        ],
      },
      runtime,
    );
    const query =
      operation === "read"
        ? "{ viewer { id } }"
        : 'mutation { issueCreate(input: {teamId: "pending"}) { success } }';
    const pendingResponse = Promise.withResolvers<{ status: number; body: string }>();
    const request = httpRequest(
      new URL("/graphql", server.url),
      {
        method: "POST",
        headers: {
          authorization: fixtureApiKeys.primary,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => pendingResponse.resolve({ status: response.statusCode!, body }));
        response.on("error", pendingResponse.reject);
      },
    );
    request.on("error", pendingResponse.reject);
    try {
      request.write('{"query":');
      await authenticated.promise;
      expect(calls).toBe(1);
      expect(executions).toBe(0);
      revoked = true;
      request.end(`${JSON.stringify(query)}}`);
      const response = await pendingResponse.promise;
      expect(executions).toBe(0);
      expect(
        runtime.database
          .query<{ name: string }>("SELECT name FROM users WHERE id = ?")
          .get(fixtureIds.primary.user)?.name,
      ).toBe("Human 1");
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({
        errors: [
          {
            message: "Credential revoked",
            extensions: { code: "UNAUTHENTICATED", type: "authentication error" },
          },
        ],
      });
      expect(calls).toBe(2);
    } finally {
      request.destroy();
    }
  },
);

test("explicit resolver maps reject duplicate compositions and never fabricate feature or source fields", async () => {
  const runtime = runtimeFixture();
  await expect(
    createGraphQLHandler(runtime, { resolverMaps: [supportingResolvers(), supportingResolvers()] }),
  ).rejects.toThrow("Duplicate resolver");
  const missing = await setup(
    { roots: featureRoots.issue, operations: ["createIssue", "issue"], resolverMaps: [] },
    runtime,
  );
  for (const query of [
    '{ issue(id: "missing") { id } }',
    'mutation { issueCreate(input: {teamId: "missing", title: "not created"}) { success } }',
  ]) {
    const result = await missing.request({ query });
    expect(result.response.status).toBe(200);
    expect(result.body.data).toBeNull();
    expect(result.body.errors[0].message).toContain("has no resolver");
    expect(result.body.errors[0].extensions.type).toBe("invalid input");
  }
  const unpopulated = await setup(
    {
      roots: { query: ["viewer"] },
      operations: [],
      resolverMaps: [{ Query: { viewer: () => ({ id: fixtureIds.primary.user }) } }],
    },
    runtime,
  );
  const result = await unpopulated.request({ query: "{ viewer { id name } }" });
  expect(result.response.status).toBe(200);
  expect(result.body.errors[0].message).toContain("User.name has no resolver");
  expect(result.body.errors[0].path).toEqual(["viewer", "name"]);
});

test("unexpected resolver and authentication errors redact secrets including thrown GraphQLError", async () => {
  const runtime = runtimeFixture();
  for (const error of [
    new Error("database-password"),
    new GraphQLError("database-password", { extensions: { token: "private-token" } }),
  ]) {
    const { request } = await setup(
      {
        roots: { query: ["viewer"] },
        operations: [],
        resolverMaps: [
          {
            Query: {
              viewer: () => {
                throw error;
              },
            },
          },
        ],
      },
      runtime,
    );
    const result = await request({ query: "{ alias: viewer { id } }" });
    expect(result.response.status).toBe(200);
    expect(result.body.errors[0].message).toBe("Internal server error");
    expect(result.body.errors[0].extensions.type).toBe("internal error");
    expect(result.body.errors[0].path).toEqual(["alias"]);
    expect(result.body.errors[0].locations).toEqual([{ line: 1, column: 3 }]);
    expect(JSON.stringify(result.body)).not.toContain("database-password");
    expect(JSON.stringify(result.body)).not.toContain("private-token");
  }
  const { request } = await setup(
    {
      authenticate: () => {
        throw new Error("auth-secret");
      },
    },
    runtime,
  );
  const result = await request({ query: "{" });
  expect(result.response.status).toBe(500);
  expect(JSON.stringify(result.body)).not.toContain("auth-secret");
});
