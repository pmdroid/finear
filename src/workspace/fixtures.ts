import type { Transaction } from "../core/database";
import { organizationSettings, teamSettings, userSettings } from "../../fixtures/settings";

export const fixtureTime = 1791763200000;
export const fixtureIds = {
  primary: {
    organization: "10000000-0000-4000-8000-000000000001",
    user: "10000000-0000-4000-8000-000000000002",
    team: "10000000-0000-4000-8000-000000000003",
    privateTeam: "10000000-0000-4000-8000-000000000004",
    backlog: "10000000-0000-4000-8000-000000000005",
    started: "10000000-0000-4000-8000-000000000006",
    completed: "10000000-0000-4000-8000-000000000007",
    projectPlanned: "10000000-0000-4000-8000-000000000008",
    projectStarted: "10000000-0000-4000-8000-000000000009",
    privateBacklog: "10000000-0000-4000-8000-00000000000a",
  },
  secondary: {
    organization: "20000000-0000-4000-8000-000000000001",
    user: "20000000-0000-4000-8000-000000000002",
    team: "20000000-0000-4000-8000-000000000003",
    privateTeam: "20000000-0000-4000-8000-000000000004",
    backlog: "20000000-0000-4000-8000-000000000005",
    started: "20000000-0000-4000-8000-000000000006",
    completed: "20000000-0000-4000-8000-000000000007",
    projectPlanned: "20000000-0000-4000-8000-000000000008",
    projectStarted: "20000000-0000-4000-8000-000000000009",
    privateBacklog: "20000000-0000-4000-8000-00000000000a",
  },
} as const;

export function seedWorkspace(tx: Transaction): void {
  for (const [index, ids] of Object.values(fixtureIds).entries()) {
    const key = index === 0 ? "ENG" : "OTHER";
    tx.run(
      "INSERT INTO organizations (id, name, url_key, created_at) VALUES (?, ?, ?, ?)",
      ids.organization,
      `Workspace ${index + 1}`,
      key.toLowerCase(),
      fixtureTime,
    );
    tx.run(
      "INSERT INTO users (id, organization_id, name, email, admin, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      ids.user,
      ids.organization,
      `Human ${index + 1}`,
      `human${index + 1}@example.test`,
      fixtureTime,
    );
    for (const [teamId, privateTeam] of [
      [ids.team, 0],
      [ids.privateTeam, 1],
    ] as const) {
      tx.run(
        "INSERT INTO teams (id, organization_id, name, key, private, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        teamId,
        ids.organization,
        privateTeam ? "Private" : "Engineering",
        privateTeam ? `${key}P` : key,
        privateTeam,
        fixtureTime,
      );
    }
    tx.run(
      "INSERT INTO team_memberships (organization_id, team_id, user_id) VALUES (?, ?, ?)",
      ids.organization,
      ids.team,
      ids.user,
    );
    tx.run(
      "UPDATE organizations SET settings = ? WHERE id = ?",
      JSON.stringify(organizationSettings),
      ids.organization,
    );
    tx.run("UPDATE users SET settings = ? WHERE id = ?", JSON.stringify(userSettings), ids.user);
    tx.run(
      "UPDATE teams SET settings = ? WHERE organization_id = ?",
      JSON.stringify(teamSettings),
      ids.organization,
    );
    const states = [
      [ids.backlog, "Backlog", "backlog", ids.team],
      [ids.started, "In Progress", "started", ids.team],
      [ids.completed, "Done", "completed", ids.team],
      [ids.privateBacklog, "Backlog", "backlog", ids.privateTeam],
    ] as const;
    for (const [position, [id, name, type, team]] of states.entries()) {
      tx.run(
        "INSERT INTO workflow_states (id, organization_id, team_id, name, type, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        ids.organization,
        team,
        name,
        type,
        "#808080",
        position,
        fixtureTime,
      );
    }
    const statuses = [
      [ids.projectPlanned, "Planned", "planned"],
      [ids.projectStarted, "In Progress", "started"],
    ] as const;
    for (const [position, [id, name, type]] of statuses.entries()) {
      tx.run(
        "INSERT INTO project_statuses (id, organization_id, name, type, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        ids.organization,
        name,
        type,
        "#808080",
        position,
        fixtureTime,
      );
    }
  }
}
