import { afterEach, expect, test } from "bun:test";
import { LinearClient, LinearErrorType, TeamVisibility, ProjectStatusType } from "@linear/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { print, validateSchema } from "graphql";
import { createRuntime, resetRuntime, type Runtime } from "../../src/core/runtime";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { fixtureApiKeys } from "../../src/identity/fixture";
import { createGraphQLHandler } from "../../src/graphql/http";
import {
  deliveredOperations,
  deriveSchema,
  loadContract,
  operationDocument,
  operationInventory,
} from "../../src/graphql/contract";
import { createControlHandler } from "../../src/testing/control";
import { startServer } from "../../src/server";

const directories: string[] = [];
const runtimes: Runtime[] = [];
const servers: ReturnType<typeof startServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function setup(path = ":memory:", seed = true) {
  const runtime = createRuntime({ databasePath: path, clockSource: () => fixtureTime });
  runtimes.push(runtime);
  if (seed) resetRuntime(runtime);
  const server = startServer({
    port: 0,
    handlers: [
      await createGraphQLHandler(runtime),
      createControlHandler({
        token: "control-only",
        clock: runtime.clock,
        reset: () => resetRuntime(runtime),
      }),
    ],
  });
  servers.push(server);
  const client = new LinearClient({
    apiUrl: new URL("/graphql", server.url).href,
    apiKey: fixtureApiKeys.primary,
  });
  return { runtime, server, client };
}

test("pinned schema validates every delivered generated operation closure", async () => {
  const { source, documents } = await loadContract();
  const schema = deriveSchema(source);
  expect(validateSchema(schema)).toEqual([]);
  expect(operationInventory(schema, documents)).toHaveLength(deliveredOperations.length);
  expect(operationInventory(schema, documents)).toEqual(
    await Bun.file(new URL("../../contracts/operations.json", import.meta.url)).json(),
  );
  expect(
    await Bun.file(new URL("../../contracts/provenance.json", import.meta.url)).json(),
  ).toEqual((await import("../../src/graphql/contract")).contractProvenance);
  expect(schema.getMutationType()).toBeUndefined();
  expect(schema.getQueryType()?.getFields().issue).toBeUndefined();
  const { server } = await setup();
  for (const name of deliveredOperations) {
    const variables =
      name.startsWith("team_") || name === "team"
        ? { id: fixtureIds.primary.team }
        : name === "workflowState"
          ? { id: fixtureIds.primary.backlog }
          : name === "projectStatus"
            ? { id: fixtureIds.primary.projectPlanned }
            : { id: fixtureIds.primary.user };
    const response = await fetch(new URL("/graphql", server.url), {
      method: "POST",
      headers: { authorization: fixtureApiKeys.primary, "content-type": "application/json" },
      body: JSON.stringify({ query: print(operationDocument(documents, name)), variables }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();
  }
});

test("unchanged SDK reads supporting full fragments and real relationships", async () => {
  const { client } = await setup();
  const viewer = await client.viewer;
  expect(viewer.id).toBe(fixtureIds.primary.user);
  expect(viewer.isMe).toBe(true);
  expect(viewer.createdAt.toISOString()).toBe(new Date(fixtureTime).toISOString());
  const organization = await client.organization;
  expect(organization.id).toBe(fixtureIds.primary.organization);
  expect(organization.userCount).toBe(1);
  expect((await organization.users()).nodes.map((user) => user.id)).toEqual([viewer.id]);
  expect((await viewer.teams()).nodes.map((team) => team.id)).toEqual([fixtureIds.primary.team]);
  expect((await client.user(viewer.id)).name).toBe(viewer.name);
  expect((await client.users()).nodes).toHaveLength(1);
  const team = await client.team(fixtureIds.primary.team);
  expect(team.visibility).toBe(TeamVisibility.Public);
  expect((await team.members()).nodes[0]?.id).toBe(viewer.id);
  expect((await organization.teams()).nodes.map((value) => value.id)).toEqual([team.id]);
  expect((await team.states()).nodes).toHaveLength(3);
  expect((await client.workflowState(fixtureIds.primary.backlog)).type).toBe("backlog");
  expect((await client.workflowStates()).nodes).toHaveLength(3);
  expect((await client.projectStatus(fixtureIds.primary.projectPlanned)).type).toBe(
    ProjectStatusType.Planned,
  );
  expect((await client.projectStatuses()).nodes).toHaveLength(2);
  const first = await client.workflowStates({ first: 1 });
  const second = await client.workflowStates({ first: 1, after: first.pageInfo.endCursor });
  expect(first.nodes[0]?.id).not.toBe(second.nodes[0]?.id);
  expect(first.pageInfo.hasNextPage).toBe(true);
  expect((await client.users({ filter: { name: { eq: "Human 1" } } })).nodes).toHaveLength(1);
});

test("fixture-key auth isolates two workspaces and private teams with safe SDK errors", async () => {
  const { client, server } = await setup();
  const secondary = new LinearClient({
    apiUrl: new URL("/graphql", server.url).href,
    apiKey: fixtureApiKeys.secondary,
  });
  expect((await secondary.viewer).id).toBe(fixtureIds.secondary.user);
  expect((await secondary.teams()).nodes.map((team) => team.id)).toEqual([
    fixtureIds.secondary.team,
  ]);
  await expect(client.user(fixtureIds.secondary.user)).rejects.toThrow("Record not found");
  await expect(client.team(fixtureIds.primary.privateTeam)).rejects.toThrow("Record not found");
  await expect(client.workflowState(fixtureIds.primary.privateBacklog)).rejects.toThrow(
    "Record not found",
  );
  const invalid = new LinearClient({
    apiUrl: new URL("/graphql", server.url).href,
    apiKey: "invalid-secret",
  });
  try {
    await invalid.viewer;
    throw new Error("expected denial");
  } catch (error) {
    expect((error as { type: string }).type).toBe(LinearErrorType.AuthenticationError);
    expect(String(error)).not.toContain("invalid-secret");
  }
  expect(
    (
      await fetch(new URL("/__test/reset", server.url), {
        method: "POST",
        headers: { authorization: fixtureApiKeys.primary },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(new URL("/graphql", server.url), {
        method: "POST",
        headers: { authorization: "Bearer control-only" },
        body: '{"query":"{ viewer { id } }"}',
      })
    ).status,
  ).toBe(401);
});

test("malformed requests fail 400 and executed domain errors use 200", async () => {
  const { server } = await setup();
  const headers = { authorization: fixtureApiKeys.primary, "content-type": "application/json" };
  for (const body of [
    "invalid",
    "{}",
    '{"query":"{"}',
    '{"query":"{ unknown }"}',
    '{"query":"{viewer{id}}","variables":[]}',
  ]) {
    expect(
      (await fetch(new URL("/graphql", server.url), { method: "POST", headers, body })).status,
    ).toBe(400);
  }
  const response = await fetch(new URL("/graphql", server.url), {
    method: "POST",
    headers,
    body: JSON.stringify({ query: '{ user(id: "missing") { id } }' }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.errors[0].extensions.type).toBe("user error");
  expect(body.errors[0].extensions.code).toBe("NOT_FOUND");
  expect(body.data).toBeNull();
});

test("SDK and protected reset work after HTTP restart with persisted clock", async () => {
  const path = mkdtempSync(join(tmpdir(), "finear-sdk-"));
  directories.push(path);
  const databasePath = join(path, "workspace.sqlite");
  const first = await setup(databasePath);
  first.runtime.clock.advance(42000);
  first.runtime.database.transaction((tx) =>
    tx.run("UPDATE users SET name = ? WHERE id = ?", "Persisted Human", fixtureIds.primary.user),
  );
  first.server.stop(true);
  first.runtime.close();
  const second = await setup(databasePath, false);
  expect((await second.client.viewer).name).toBe("Persisted Human");
  expect(second.runtime.clock.now()).toBe(fixtureTime + 42000);
  const response = await fetch(new URL("/__test/reset", second.server.url), {
    method: "POST",
    headers: { authorization: "Bearer control-only" },
  });
  expect(response.status).toBe(200);
  expect((await second.client.viewer).name).toBe("Human 1");
  expect(second.runtime.clock.now()).toBe(fixtureTime);
});
