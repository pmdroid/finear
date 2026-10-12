import { afterEach, expect, test } from "bun:test";
import { IssueRelationType, LinearClient } from "@linear/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type Application } from "../../src/application";
import { fixtureApiKeys } from "../../src/identity/fixture";
import { fixtureIds } from "../../src/workspace/fixtures";

const applications: Application[] = [];
afterEach(async () => {
  for (const application of applications.splice(0)) await application.close();
});
async function setup() {
  const application = await createApplication({ databasePath: ":memory:", port: 0 });
  applications.push(application);
  const apiUrl = new URL("/graphql", application.url).href;
  const client = new LinearClient({ apiUrl, apiKey: fixtureApiKeys.primary });
  const secondary = new LinearClient({ apiUrl, apiKey: fixtureApiKeys.secondary });
  const issue = async (title: string) =>
    (await (
      await client.createIssue({ teamId: fixtureIds.primary.team, title })
    ).issue)!;
  return { application, client, secondary, issue };
}

test("SDK relation mutations preserve outward and inverse dependencies with real pagination", async () => {
  const { client, issue } = await setup();
  const source = await issue("Source");
  const target = await issue("Target");
  const other = await issue("Other");
  expect((await source.relations()).nodes).toEqual([]);
  expect((await target.inverseRelations()).nodes).toEqual([]);
  const created = await client.createIssueRelation({
    issueId: source.identifier,
    relatedIssueId: target.id,
    type: IssueRelationType.Blocks,
  });
  expect(created.success).toBe(true);
  const relation = (await created.issueRelation)!;
  expect((await relation.issue)?.id).toBe(source.id);
  expect((await relation.relatedIssue)?.id).toBe(target.id);
  expect((await source.relations()).nodes.map((node) => node.id)).toEqual([relation.id]);
  expect((await target.inverseRelations()).nodes.map((node) => node.id)).toEqual([relation.id]);
  expect((await target.relations()).nodes).toEqual([]);
  const second = (await (
    await client.createIssueRelation({
      issueId: source.id,
      relatedIssueId: other.id,
      type: IssueRelationType.Related,
    })
  ).issueRelation)!;
  const page = await source.relations({ first: 1 });
  const next = await source.relations({ first: 1, after: page.pageInfo.endCursor });
  expect(page.pageInfo.hasNextPage).toBe(true);
  expect(next.pageInfo.hasNextPage).toBe(false);
  expect(new Set([...page.nodes, ...next.nodes].map((node) => node.id))).toEqual(
    new Set([relation.id, second.id]),
  );
  const updated = await client.updateIssueRelation(relation.id, {
    issueId: other.identifier,
    relatedIssueId: source.identifier,
    type: "duplicate",
  });
  expect(updated.success).toBe(true);
  const current = await client.issueRelation(relation.id);
  expect(current.type).toBe("duplicate");
  expect((await current.issue)?.id).toBe(other.id);
  expect((await current.relatedIssue)?.id).toBe(source.id);
  expect((await target.inverseRelations()).nodes).toEqual([]);
  expect((await client.issueRelations()).nodes).toHaveLength(2);
  expect((await client.deleteIssueRelation(relation.id)).success).toBe(true);
  await expect(client.issueRelation(relation.id)).rejects.toThrow("Relation not found");
  await client.deleteIssue(other.id);
  expect((await client.issueRelations()).nodes).toEqual([]);
});

test("relations reject foreign and inaccessible endpoints without partial writes", async () => {
  const { application, client, secondary, issue } = await setup();
  const source = await issue("Source");
  const target = await issue("Target");
  const foreign = (await (
    await secondary.createIssue({
      teamId: fixtureIds.secondary.team,
      title: "Foreign",
    })
  ).issue)!;
  const relation = (await (
    await client.createIssueRelation({
      issueId: source.id,
      relatedIssueId: target.id,
      type: IssueRelationType.Blocks,
    })
  ).issueRelation)!;
  await expect(
    client.createIssueRelation({
      issueId: source.id,
      relatedIssueId: foreign.id,
      type: IssueRelationType.Blocks,
    }),
  ).rejects.toThrow("Issue not found");
  await expect(
    client.updateIssueRelation(relation.id, { relatedIssueId: foreign.id }),
  ).rejects.toThrow("Issue not found");
  await expect(secondary.issueRelation(relation.id)).rejects.toThrow("Relation not found");
  await expect(secondary.deleteIssueRelation(relation.id)).rejects.toThrow("Relation not found");
  expect((await secondary.issueRelations()).nodes).toEqual([]);
  expect((await (await client.issueRelation(relation.id)).relatedIssue)?.id).toBe(target.id);
  expect((await client.issueRelations()).nodes).toHaveLength(1);
  const principal = application.identity.authenticate(
    new Request(application.url, {
      headers: { authorization: fixtureApiKeys.primary },
    }),
  );
  expect(() =>
    application.workspace.createIssueRelation(
      { ...principal, scopes: ["read"] },
      {
        issueId: source.id,
        relatedIssueId: target.id,
        type: "blocks",
      },
    ),
  ).toThrow("scope");
  expect(() =>
    application.workspace.requireIssueRelation({ ...principal, scopes: ["write"] }, relation.id),
  ).toThrow("scope");
  application.runtime.database.transaction((tx) => {
    tx.run(
      "UPDATE issues SET team_id = ?, state_id = ? WHERE id = ?",
      fixtureIds.primary.privateTeam,
      fixtureIds.primary.privateBacklog,
      target.id,
    );
  });
  expect((await source.relations()).nodes).toEqual([]);
  expect((await client.issueRelations()).nodes).toEqual([]);
  await expect(client.issueRelation(relation.id)).rejects.toThrow("Issue not found");
  await expect(client.deleteIssueRelation(relation.id)).rejects.toThrow("Issue not found");
  await application.reset();
  expect((await client.issueRelations()).nodes).toEqual([]);
});

test("relation storage and SDK reads survive a SQLite reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finear-relations-"));
  const options = { databasePath: join(directory, "workspace.sqlite"), port: 0 };
  let application = await createApplication(options);
  const connect = () =>
    new LinearClient({
      apiUrl: new URL("/graphql", application.url).href,
      apiKey: fixtureApiKeys.primary,
    });
  try {
    let client = connect();
    const source = (await (
      await client.createIssue({ teamId: fixtureIds.primary.team, title: "Source" })
    ).issue)!;
    const target = (await (
      await client.createIssue({ teamId: fixtureIds.primary.team, title: "Target" })
    ).issue)!;
    const relation = (await (
      await client.createIssueRelation({
        issueId: source.id,
        relatedIssueId: target.id,
        type: IssueRelationType.Blocks,
      })
    ).issueRelation)!;
    await application.close();
    application = await createApplication(options);
    client = connect();
    expect((await client.issueRelation(relation.id)).type).toBe("blocks");
    expect((await (await client.issue(source.id)).relations()).nodes[0]?.id).toBe(relation.id);
    expect((await (await client.issue(target.id)).inverseRelations()).nodes[0]?.id).toBe(
      relation.id,
    );
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
