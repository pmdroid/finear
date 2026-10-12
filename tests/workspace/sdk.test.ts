import { expect, test } from "bun:test";
import { LinearClient } from "@linear/sdk";
import { print, validate, validateSchema } from "graphql";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import { createGraphQLHandler } from "../../src/graphql/http";
import {
  deriveSchema,
  deliveredOperations,
  supportingRoots,
  loadContract,
  operationDocument,
} from "../../src/graphql/contract";
import { fixtureApiKeys } from "../../src/identity/fixture";
import { startServer } from "../../src/server";
import { Workspace } from "../../src/workspace/entities";
import {
  workspaceEntityMigrations,
  workspaceEntityResetOwner,
} from "../../src/workspace/entity-schema";
import {
  workspaceEntityOperations,
  workspaceEntityResolvers,
} from "../../src/workspace/entity-resolvers";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { supportingResolvers } from "../../src/workspace/supporting";

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), "finear-workspace-http-"));
  const runtime = createRuntime({
    databasePath: join(directory, "workspace.sqlite"),
    clockSource: () => fixtureTime,
    migrations: [workspaceEntityMigrations],
  });
  resetRuntime(runtime, [workspaceEntityResetOwner]);
  const { source, documents } = await loadContract();
  const resolverMaps = [supportingResolvers(), workspaceEntityResolvers(new Workspace(runtime))];
  const roots = {
    query: [...supportingRoots, ...Object.keys(resolverMaps[1]!.Query!)],
    mutation: Object.keys(resolverMaps[1]!.Mutation!),
  };
  const schema = deriveSchema(source, roots);
  expect(validateSchema(schema)).toEqual([]);
  const handler = await createGraphQLHandler(runtime, {
    resolverMaps,
    roots,
    operations: [...deliveredOperations, ...workspaceEntityOperations],
  });
  const server = startServer({ hostname: "127.0.0.1", port: 0, handlers: [handler] });
  return {
    runtime,
    schema,
    documents,
    url: `http://127.0.0.1:${server.port}/graphql`,
    close() {
      server.stop(true);
      runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("exact owned pinned operation closures validate on production adapter schema", async () => {
  const instance = await harness();
  try {
    for (const operation of workspaceEntityOperations)
      expect(validate(instance.schema, operationDocument(instance.documents, operation))).toEqual(
        [],
      );
  } finally {
    instance.close();
  }
});

test("unchanged SDK issue/project/comment journey over production GraphQL HTTP", async () => {
  const instance = await harness();
  const client = new LinearClient({ apiKey: fixtureApiKeys.primary, apiUrl: instance.url });
  try {
    const projectPayload = await client.createProject({
      name: "SDK project",
      teamIds: [fixtureIds.primary.team],
      memberIds: [fixtureIds.primary.user],
      content: "Project body",
    });
    expect(projectPayload.success).toBe(true);
    const project = (await projectPayload.project)!;
    expect(project.name).toBe("SDK project");
    expect(project.description).toBe("");
    expect(String(project.frequencyResolution)).toBe("weekly");
    expect((await project.teams()).nodes[0]!.key).toBe("ENG");
    expect((await project.members()).nodes[0]!.id).toBe(fixtureIds.primary.user);
    const label = (await (
      await client.createIssueLabel({ name: "SDK label", teamId: fixtureIds.primary.team })
    ).issueLabel)!;
    expect(label.name).toBe("SDK label");
    const parent = (await (
      await client.createIssue({
        teamId: fixtureIds.primary.team,
        title: "Parent",
        projectId: project.id,
      })
    ).issue)!;
    const child = (await (
      await client.createIssue({
        teamId: fixtureIds.primary.team,
        title: "Child",
        parentId: parent.id,
        projectId: project.id,
        assigneeId: fixtureIds.primary.user,
        priority: 2,
        labelIds: [label.id],
      })
    ).issue)!;
    expect(child.identifier).toBe("ENG-2");
    expect(child.priorityLabel).toBe("High");
    expect(child.createdAt.toISOString()).toBe(new Date(fixtureTime).toISOString());
    expect((await child.parent)!.id).toBe(parent.id);
    expect((await child.assignee)!.id).toBe(fixtureIds.primary.user);
    expect((await parent.children()).nodes.map((issue) => issue.id)).toEqual([child.id]);
    expect((await project.issues()).nodes).toHaveLength(2);
    const team = await client.team(fixtureIds.primary.team);
    expect((await team.issues()).nodes).toHaveLength(2);
    expect((await team.projects()).nodes[0]!.id).toBe(project.id);
    expect((await (await client.viewer).assignedIssues()).nodes[0]!.id).toBe(child.id);
    await client.updateProject(project.id, {
      statusId: fixtureIds.primary.projectStarted,
      description: "In flight",
    });
    expect((await client.project(project.id)).state).toBe("started");
    await client.archiveProject(project.id);
    expect((await client.projects()).nodes).toHaveLength(0);
    expect((await client.projects({ includeArchived: true })).nodes).toHaveLength(1);
    await client.unarchiveProject(project.id);
    expect((await client.projects()).nodes).toHaveLength(1);
    const comment = (await (
      await client.createComment({ issueId: child.id, body: "Hello" })
    ).comment)!;
    const reply = (await (
      await client.createComment({ issueId: child.id, body: "Reply", parentId: comment.id })
    ).comment)!;
    expect((await reply.parent)!.id).toBe(comment.id);
    expect((await comment.children({ id: comment.id })).nodes).toHaveLength(1);
    expect((await child.comments()).nodes).toHaveLength(2);
    await client.updateIssue(child.identifier, {
      title: "Updated",
      stateId: fixtureIds.primary.completed,
    });
    expect((await client.issue(child.identifier)).completedAt!.toISOString()).toBe(
      new Date(fixtureTime).toISOString(),
    );
    const first = await client.issues({ first: 1 });
    const next = await client.issues({ first: 1, after: first.pageInfo.endCursor });
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]!.id).not.toBe(first.nodes[0]!.id);
    expect(
      (await client.issues({ filter: { parent: { id: { eq: parent.id } } } })).nodes.map(
        (issue) => issue.id,
      ),
    ).toEqual([child.id]);
    await client.archiveIssue(child.id);
    expect((await client.issues()).nodes).toHaveLength(1);
    expect((await client.issues({ includeArchived: true })).nodes).toHaveLength(2);
    await client.unarchiveIssue(child.id);
    await expect(client.updateIssue(parent.id, { parentId: child.id })).rejects.toThrow();
    const raw = (await fetch(instance.url, {
      method: "POST",
      headers: { authorization: fixtureApiKeys.primary, "content-type": "application/json" },
      body: JSON.stringify({
        query: print(operationDocument(instance.documents, "issue")),
        variables: { id: child.id },
      }),
    }).then((response) => response.json())) as {
      errors?: unknown;
      data: { issue: { sharedAccess: { isShared: boolean }; labelIds: string[]; title: string } };
    };
    expect(raw.errors).toBeUndefined();
    expect(raw.data.issue.title).toBe("Updated");
    expect(raw.data.issue.sharedAccess.isShared).toBe(false);
    expect(raw.data.issue.labelIds).toEqual([label.id]);
    expect((await child.labels()).nodes[0]!.id).toBe(label.id);
    expect(
      (await client.issues({ filter: { labels: { id: { eq: label.id } } } })).nodes,
    ).toHaveLength(1);
    const secondary = new LinearClient({ apiKey: fixtureApiKeys.secondary, apiUrl: instance.url });
    await expect(secondary.issue(child.id)).rejects.toThrow();
    await expect(
      client.createIssue({ teamId: fixtureIds.primary.privateTeam, title: "Denied" }),
    ).rejects.toThrow();
    const denial = await fetch(instance.url, {
      method: "POST",
      headers: { authorization: fixtureApiKeys.secondary, "content-type": "application/json" },
      body: JSON.stringify({
        query: "query($id:String!){issue(id:$id){id}}",
        variables: { id: child.id },
      }),
    });
    expect(denial.status).toBe(200);
    expect(
      ((await denial.json()) as { errors: { extensions: { code: string } }[] }).errors[0]!
        .extensions.code,
    ).toBe("NOT_FOUND");
    await client.deleteProject(project.id);
    expect(await (await client.issue(child.id)).project).toBeUndefined();
    await client.deleteIssue(child.id);
    await expect(client.issue(child.id)).rejects.toThrow();
  } finally {
    instance.close();
  }
});
