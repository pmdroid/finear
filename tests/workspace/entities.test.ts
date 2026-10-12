import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, resetRuntime, type Runtime } from "../../src/core/runtime";
import type { Principal } from "../../src/core/principal";
import { createAppUser } from "../../src/workspace/directory";
import { Workspace } from "../../src/workspace/entities";
import {
  workspaceEntityMigrations,
  workspaceEntityResetOwner,
} from "../../src/workspace/entity-schema";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";

const ids = fixtureIds.primary;
const principal: Principal = {
  organizationId: ids.organization,
  userId: ids.user,
  actor: "apiKey",
  oauthClientId: null,
  installationId: null,
  grantId: null,
  scopes: ["read", "write", "admin"],
  teamIds: [ids.team],
  admin: true,
};
const resources: { runtime: Runtime; directory: string }[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "finear-entities-"));
  const options = {
    databasePath: join(directory, "workspace.sqlite"),
    clockSource: () => fixtureTime,
    migrations: [workspaceEntityMigrations],
  };
  const runtime = createRuntime(options);
  resources.push({ runtime, directory });
  resetRuntime(runtime, [workspaceEntityResetOwner]);
  return { runtime, workspace: new Workspace(runtime), options };
}
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.runtime.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("workspace entities", () => {
  test("persistent numbering, identifier lookup and restart", () => {
    const { workspace, runtime, options } = setup();
    const first = workspace.createIssue(principal, { teamId: ids.team, title: "Parent" });
    const second = workspace.createIssue(principal, {
      teamId: ids.team,
      title: "Child",
      parentId: first.entity.id,
    });
    expect(first.entity.identifier).toBe("ENG-1");
    expect(second.entity.identifier).toBe("ENG-2");
    expect(second.lastSyncId).toBe(first.lastSyncId + 1);
    expect(workspace.requireIssue(principal, "ENG-1").id).toBe(first.entity.id);
    runtime.close();
    const reopened = createRuntime(options);
    resources[resources.length - 1]!.runtime = reopened;
    const restored = new Workspace(reopened);
    expect(restored.requireIssue(principal, second.entity.id).parentId).toBe(first.entity.id);
    expect(
      restored.createIssue(principal, { teamId: ids.team, title: "Third" }).entity.number,
    ).toBe(3);
  });

  test("separate SQLite connections allocate one durable per-team sequence", () => {
    const { workspace, options } = setup();
    const otherRuntime = createRuntime(options);
    try {
      const other = new Workspace(otherRuntime);
      const numbers: unknown[] = [];
      for (let index = 0; index < 20; index++)
        numbers.push(
          (index % 2 ? other : workspace).createIssue(principal, {
            teamId: ids.team,
            title: `Connection ${index}`,
          }).entity.number,
        );
      expect(numbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(
        new Set(workspace.listIssues(principal).nodes.map((node) => node.identifier)).size,
      ).toBe(20);
    } finally {
      otherRuntime.close();
    }
  });

  test("parent cycle rejection, clear, and deletion detach", () => {
    const { workspace } = setup();
    const parent = workspace.createIssue(principal, { teamId: ids.team, title: "Parent" }).entity;
    const child = workspace.createIssue(principal, {
      teamId: ids.team,
      title: "Child",
      parentId: parent.id,
    }).entity;
    const grandchild = workspace.createIssue(principal, {
      teamId: ids.team,
      title: "Grandchild",
      parentId: child.id,
    }).entity;
    expect(() => workspace.updateIssue(principal, parent.id, { parentId: grandchild.id })).toThrow(
      "cycle",
    );
    expect(() => workspace.updateIssue(principal, child.id, { parentId: child.id })).toThrow(
      "cycle",
    );
    workspace.updateIssue(principal, child.id, { parentId: null });
    expect(workspace.requireIssue(principal, child.id).parent).toBeNull();
    workspace.updateIssue(principal, child.id, { parentId: parent.id });
    workspace.deleteIssue(principal, parent.id);
    expect(workspace.requireIssue(principal, child.id).parentId).toBeNull();
  });

  test("scope, organization, team, workflow and human/app roles", () => {
    const { workspace, runtime } = setup();
    expect(() =>
      workspace.createIssue(
        { ...principal, scopes: ["read"] },
        { teamId: ids.team, title: "Denied" },
      ),
    ).toThrow("scope");
    expect(() =>
      workspace.createIssue(principal, { teamId: ids.privateTeam, title: "Denied" }),
    ).toThrow("Team access");
    expect(() =>
      workspace.createIssue(principal, { teamId: fixtureIds.secondary.team, title: "Denied" }),
    ).toThrow("not found");
    expect(() =>
      workspace.createIssue(principal, {
        teamId: ids.team,
        title: "Denied",
        stateId: ids.privateBacklog,
      }),
    ).toThrow("state");
    expect(() =>
      workspace.createIssue(principal, {
        teamId: ids.team,
        title: "Denied",
        assigneeId: fixtureIds.secondary.user,
      }),
    ).toThrow("not found");
    const appId = crypto.randomUUID();
    runtime.database.transaction((tx) =>
      createAppUser(tx, {
        id: appId,
        organizationId: ids.organization,
        name: "Agent",
        email: "agent@example.test",
        createdAt: tx.now,
      }),
    );
    const issue = workspace.createIssue(principal, {
      teamId: ids.team,
      title: "Assigned",
      assigneeId: ids.user,
      delegateId: appId,
    }).entity;
    expect(issue.assigneeId).toBe(ids.user);
    expect(issue.delegateId).toBe(appId);
    expect(() => workspace.setDelegate(principal, issue.id, ids.user)).toThrow("app user");
    expect(() => workspace.updateIssue(principal, issue.id, { assigneeId: appId })).toThrow(
      "human user",
    );
    expect(() => workspace.requireIssue({ ...principal, teamIds: [] }, issue.id)).toThrow(
      "not found",
    );
    expect(() =>
      workspace.requireIssue(
        { ...principal, organizationId: fixtureIds.secondary.organization },
        issue.id,
      ),
    ).toThrow("not found");
    expect(() =>
      workspace.updateIssue({ ...principal, scopes: ["read", "admin"] }, issue.id, {
        title: "Denied",
      }),
    ).toThrow("scope");
  });

  test("project membership, state, metrics, labels, archive and deletion", () => {
    const { workspace, runtime } = setup();
    expect(() => workspace.createProject(principal, { name: "Empty", teamIds: [] })).toThrow(
      "at least one",
    );
    const project = workspace.createProject(principal, {
      name: "Milestone",
      teamIds: [ids.team],
      memberIds: [ids.user],
    }).entity;
    const label = workspace.createLabel(principal, { name: "Backend", teamId: ids.team }).entity;
    const issue = workspace.createIssue(principal, {
      teamId: ids.team,
      title: "Build",
      projectId: project.id,
      labelIds: [label.id],
      estimate: 4,
    }).entity;
    expect(workspace.requireProject(principal, project.id).scope).toBe(4);
    expect(() =>
      workspace.updateProject(principal, project.id, { teamIds: [ids.privateTeam] }),
    ).toThrow("Team access");
    expect(() =>
      workspace.updateProject({ ...principal, teamIds: [ids.team, ids.privateTeam] }, project.id, {
        teamIds: [ids.privateTeam],
      }),
    ).toThrow("project issues");
    workspace.updateIssue(principal, issue.id, { stateId: ids.started });
    expect(workspace.requireProject(principal, project.id).progress).toBe(0.25);
    runtime.clock.advance(1000);
    workspace.updateIssue(principal, issue.id, {
      stateId: ids.completed,
      removedLabelIds: [label.id],
    });
    expect(workspace.requireIssue(principal, issue.id).completedAt).toBe(fixtureTime + 1000);
    expect(workspace.requireIssue(principal, issue.id).labelIds).toEqual([]);
    expect(workspace.requireProject(principal, project.id).progress).toBe(1);
    workspace.updateProject(principal, project.id, {
      statusId: ids.projectStarted,
      description: "Shipping",
    });
    expect(workspace.requireProject(principal, project.id).state).toBe("started");
    workspace.archiveIssue(principal, issue.id, true);
    expect(workspace.listIssues(principal).nodes).toHaveLength(0);
    expect(workspace.listIssues(principal, { includeArchived: true }).nodes).toHaveLength(1);
    expect(workspace.requireIssue(principal, issue.id).trashed).toBe(true);
    workspace.unarchiveIssue(principal, issue.id);
    expect(workspace.requireIssue(principal, issue.id).trashed).toBe(false);
    workspace.archiveProject(principal, project.id);
    expect(workspace.listProjects(principal).nodes).toHaveLength(0);
    expect(workspace.listProjects(principal, { includeArchived: true }).nodes).toHaveLength(1);
    workspace.unarchiveProject(principal, project.id);
    workspace.deleteProject(principal, project.id);
    expect(workspace.requireIssue(principal, issue.id).project).toBeNull();
    expect(() => workspace.requireProject(principal, project.id)).toThrow("not found");
  });

  test("forward/backward pagination and typed logical/nested filtering", () => {
    const { workspace, runtime } = setup();
    for (let index = 0; index < 6; index++) {
      runtime.clock.advance(1);
      workspace.createIssue(principal, {
        teamId: ids.team,
        title: `Task ${index}`,
        priority: index % 2 ? 2 : 3,
      });
    }
    const first = workspace.listIssues(principal, { first: 2 });
    const second = workspace.listIssues(principal, { first: 2, after: first.pageInfo.endCursor });
    expect(first.nodes.map((node) => node.number)).toEqual([1, 2]);
    expect(second.nodes.map((node) => node.number)).toEqual([3, 4]);
    expect(
      workspace
        .listIssues(principal, { last: 2, before: second.pageInfo.endCursor })
        .nodes.map((node) => node.number),
    ).toEqual([2, 3]);
    expect(
      workspace.listIssues(principal, {
        filter: {
          and: [
            { team: { id: { eq: ids.team } } },
            { or: [{ priority: { eq: 2 } }, { title: { eq: "Task 0" } }] },
          ],
        },
      }).nodes,
    ).toHaveLength(4);
    expect(
      workspace.listIssues(principal, {
        filter: { parent: { null: true }, title: { containsIgnoreCase: "TASK" } },
        sort: [{ createdAt: { order: "Descending" } }],
      }).nodes[0]!.number,
    ).toBe(6);
    expect(
      workspace.listIssues(principal, { filter: { createdAt: { gte: "-P1D" } } }).nodes,
    ).toHaveLength(6);
    expect(() =>
      workspace.listIssues(principal, { filter: { unsupported: { eq: true } } }),
    ).toThrow("Unsupported filter");
    expect(() => workspace.listIssues(principal, { first: 1, last: 1 })).toThrow("pagination");
    expect(() => workspace.listIssues(principal, { after: "garbage" })).toThrow("cursor");
    expect(() =>
      workspace.listIssues(principal, { sort: [{ customerCount: { order: "Ascending" } }] }),
    ).toThrow("Unsupported sort");
    expect(workspace.listIssues(principal, { first: 0 }).pageInfo.hasNextPage).toBe(true);
  });

  test("threaded comments, explicit tx composition, outbox snapshots and rollback", () => {
    const { workspace, runtime } = setup();
    const issue = workspace.createIssue(principal, { teamId: ids.team, title: "Thread" }).entity;
    const root = workspace.createComment(principal, { issueId: issue.id, body: "Start" }).entity;
    const child = workspace.createComment(principal, {
      issueId: issue.id,
      body: "Reply",
      parentId: root.id,
    }).entity;
    expect(workspace.requireComment(principal, child.id).parentId).toBe(root.id);
    expect(workspace.listComments(principal, {}, undefined, root.id).nodes).toHaveLength(1);
    const other = workspace.createIssue(principal, { teamId: ids.team, title: "Other" }).entity;
    expect(() =>
      workspace.createComment(principal, { issueId: other.id, body: "Bad", parentId: root.id }),
    ).toThrow("same issue");
    const count = () =>
      runtime.database.query<{ count: number }>("SELECT count(*) AS count FROM outbox").get()!
        .count;
    const before = count();
    expect(() =>
      runtime.database.transaction((tx) => {
        workspace.requireIssue(principal, issue.id, tx);
        workspace.requireComment(principal, root.id, tx);
        workspace.createComment(principal, { issueId: issue.id, body: "Rollback" }, tx);
        workspace.updateIssue(principal, issue.id, { title: "Rollback" }, tx);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(count()).toBe(before);
    expect(workspace.requireIssue(principal, issue.id).title).toBe("Thread");
    expect(workspace.listComments(principal, {}, issue.id).nodes).toHaveLength(2);
    const result = runtime.database.transaction((tx) => {
      const comment = workspace.createComment(
        principal,
        { issueId: issue.id, body: "Committed" },
        tx,
      );
      const update = workspace.updateIssue(principal, issue.id, { title: "Changed" }, tx);
      expect(update.lastSyncId).toBe(comment.lastSyncId);
      return update;
    });
    const event = runtime.database
      .query<{ data: string; updated_from: string }>(
        "SELECT * FROM outbox ORDER BY sequence DESC LIMIT 1",
      )
      .get()!;
    expect(JSON.parse(event.data).title).toBe("Changed");
    expect(JSON.parse(event.updated_from).title).toBe("Thread");
    workspace.deleteIssue(principal, issue.id);
    expect(JSON.parse(event.data).id).toBe(result.entity.id);
    expect(workspace.listComments(principal).nodes).toHaveLength(0);
    resetRuntime(runtime, [workspaceEntityResetOwner]);
    expect(workspace.createIssue(principal, { teamId: ids.team, title: "Reset" }).lastSyncId).toBe(
      1,
    );
  });

  test("team moves retain identifiers, numbering rollback, and project access is team bounded", () => {
    const { workspace, runtime } = setup();
    const expanded = { ...principal, teamIds: [ids.team, ids.privateTeam] };
    const issue = workspace.createIssue(principal, { teamId: ids.team, title: "Moving" }).entity;
    workspace.updateIssue(expanded, issue.id, { teamId: ids.privateTeam });
    expect(workspace.requireIssue(expanded, "ENG-1").identifier).toBe("ENGP-1");
    expect(workspace.requireIssue(expanded, issue.id).previousIdentifiers).toEqual(["ENG-1"]);
    const project = workspace.createProject(expanded, {
      name: "Both",
      teamIds: [ids.team, ids.privateTeam],
    }).entity;
    expect(() => workspace.requireProject(principal, project.id)).toThrow("not found");
    expect(workspace.listProjects(principal).nodes).toHaveLength(0);
    const before = runtime.database
      .query<{ value: number }>("SELECT value FROM sync_sequence")
      .get()!.value;
    expect(() =>
      runtime.database.transaction((tx) => {
        workspace.createIssue(principal, { teamId: ids.team, title: "Rolled back" }, tx);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(
      runtime.database.query<{ value: number }>("SELECT value FROM sync_sequence").get()!.value,
    ).toBe(before);
    expect(
      workspace.createIssue(principal, { teamId: ids.team, title: "Next" }).entity.number,
    ).toBe(2);
    const createOnly = { ...principal, scopes: ["issues:create"] };
    expect(
      workspace.createIssue(createOnly, { teamId: ids.team, title: "Create only" }).success,
    ).toBe(true);
    expect(() => workspace.requireIssue(createOnly, issue.id)).toThrow("scope");
    expect(() =>
      workspace.createIssue(principal, {
        teamId: ids.team,
        title: "Null state",
        stateId: null as never,
      }),
    ).toThrow("UUID");
  });

  test("project outbox freezes source team IDs, URL, actor and previous changes", () => {
    const { workspace, runtime } = setup();
    const expanded = { ...principal, teamIds: [ids.team, ids.privateTeam] };
    const project = workspace.createProject(expanded, {
      name: "Multi team",
      teamIds: [ids.team, ids.privateTeam],
    }).entity;
    const created = runtime.database
      .query<{ team_id: string | null; data: string; source: string; actor: string }>(
        "SELECT * FROM outbox WHERE resource_type = 'Project' ORDER BY sequence DESC LIMIT 1",
      )
      .get()!;
    expect(created.team_id).toBeNull();
    expect(JSON.parse(created.source).teamIds).toEqual([ids.team, ids.privateTeam]);
    expect(JSON.parse(created.source).url).toBe(project.url);
    expect(JSON.parse(created.data).createdAt).toBe(new Date(fixtureTime).toISOString());
    workspace.updateProject(expanded, project.id, { name: "Renamed", teamIds: [ids.team] });
    runtime.database.transaction((tx) =>
      tx.run("UPDATE users SET name = ? WHERE id = ?", "Changed actor", ids.user),
    );
    const updated = runtime.database
      .query<{ source: string; updated_from: string }>(
        "SELECT * FROM outbox WHERE resource_type = 'Project' ORDER BY sequence DESC LIMIT 1",
      )
      .get()!;
    expect(JSON.parse(updated.source).teamIds).toEqual([ids.team]);
    expect(JSON.parse(updated.updated_from).name).toBe("Multi team");
    expect(JSON.parse(created.source).teamIds).toEqual([ids.team, ids.privateTeam]);
    expect(JSON.parse(created.actor).name).toBe("Human 1");
  });

  test("database composite constraints prohibit foreign references", () => {
    const { workspace, runtime } = setup();
    const issue = workspace.createIssue(principal, { teamId: ids.team, title: "Local" }).entity;
    expect(() =>
      runtime.database.transaction((tx) =>
        tx.run(
          "UPDATE issues SET assignee_id = ? WHERE id = ?",
          fixtureIds.secondary.user,
          issue.id,
        ),
      ),
    ).toThrow();
    expect(() =>
      runtime.database.transaction((tx) =>
        tx.run("UPDATE issues SET state_id = ? WHERE id = ?", ids.privateBacklog, issue.id),
      ),
    ).toThrow();
    const project = workspace.createProject(principal, {
      name: "Local",
      teamIds: [ids.team],
    }).entity;
    expect(() =>
      runtime.database.transaction((tx) =>
        tx.run(
          "INSERT INTO project_members VALUES(?, ?, ?)",
          ids.organization,
          project.id,
          fixtureIds.secondary.user,
        ),
      ),
    ).toThrow();
  });
});
