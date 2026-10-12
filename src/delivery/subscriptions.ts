import type { ReadDatabase, Transaction } from "../core/database";
import { DomainError } from "../core/errors";
import { requireAdmin, requireTeam, type Principal } from "../core/principal";
import type { Runtime } from "../core/runtime";

export interface AppWebhookInput {
  organizationId: string;
  oauthClientId: string;
  appUserId: string;
  url: string;
  secret: string;
  resourceTypes: readonly string[];
  agentSessionEvents: boolean;
}

export interface Subscription {
  id: string;
  organization_id: string;
  creator_id: string | null;
  team_id: string | null;
  all_public_teams: number;
  enabled: number;
  url: string;
  secret: string;
  label: string | null;
  resource_types: string;
  app_user_id: string | null;
  oauth_client_id: string | null;
  agent_session_events: number;
  revoked: number;
  created_at: number;
  updated_at: number;
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`Invalid ${name}`);
  return value;
}
function url(value: unknown): string {
  const result = text(value, "URL");
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    return invalid("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    invalid("Invalid webhook URL");
  return result;
}
function resourceTypes(value: unknown): string {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    invalid("Invalid resource types");
  return JSON.stringify([...new Set(value)]);
}
function boolean(value: unknown, fallback: boolean): number {
  if (value === undefined) return Number(fallback);
  if (typeof value !== "boolean") invalid("Invalid boolean");
  return Number(value);
}
function label(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid("Invalid label");
  return value;
}
function id(value: unknown): string {
  if (value === undefined) return crypto.randomUUID();
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)
  )
    invalid("Expected UUID v4");
  return value;
}

export function provisionAppWebhook(tx: Transaction, input: AppWebhookInput): string {
  const app = tx
    .query<{ app: number }>("SELECT app FROM users WHERE id = ? AND organization_id = ?")
    .get(input.appUserId, input.organizationId);
  if (!app?.app) invalid("App user does not belong to workspace");
  text(input.oauthClientId, "OAuth client ID");
  const existing = tx
    .query<{ id: string }>(
      "SELECT id FROM webhook_subscriptions WHERE organization_id = ? AND oauth_client_id = ? AND app_user_id = ?",
    )
    .get(input.organizationId, input.oauthClientId, input.appUserId);
  const subscriptionId = existing?.id ?? crypto.randomUUID();
  tx.run(
    `INSERT INTO webhook_subscriptions
    (id, organization_id, all_public_teams, enabled, url, secret, resource_types, app_user_id, oauth_client_id, agent_session_events, created_at, updated_at)
    VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, oauth_client_id, app_user_id) DO UPDATE SET
    url = excluded.url, secret = excluded.secret, resource_types = excluded.resource_types,
    agent_session_events = excluded.agent_session_events, enabled = 1, revoked = 0, updated_at = excluded.updated_at`,
    subscriptionId,
    input.organizationId,
    url(input.url),
    text(input.secret, "secret"),
    resourceTypes(input.resourceTypes),
    input.appUserId,
    input.oauthClientId,
    boolean(input.agentSessionEvents, false),
    tx.now,
    tx.now,
  );
  return subscriptionId;
}

export function subscription(
  db: ReadDatabase,
  principal: Principal,
  subscriptionId: unknown,
): Subscription {
  requireAdmin(principal);
  const row = db
    .query<Subscription>("SELECT * FROM webhook_subscriptions WHERE id = ? AND organization_id = ?")
    .get(text(subscriptionId, "webhook ID"), principal.organizationId);
  if (!row) throw new DomainError("NOT_FOUND", "Webhook not found");
  if (row.team_id) requireTeam(principal, { id: row.team_id, organizationId: row.organization_id });
  return row;
}

export function projectSubscription(row: Subscription) {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: null,
    resourceTypes: JSON.parse(row.resource_types) as string[],
    enabled: Boolean(row.enabled),
    allPublicTeams: Boolean(row.all_public_teams),
    url: row.url,
    secret: row.secret,
    label: row.label,
    team: row.team_id ? { id: row.team_id } : null,
    teamIds: null,
    creator: row.creator_id ? { id: row.creator_id } : null,
  };
}

export function createSubscription(
  runtime: Runtime,
  principal: Principal,
  input: Record<string, unknown>,
) {
  requireAdmin(principal);
  const subscriptionId = id(input.id);
  return runtime.database.transaction((tx) => {
    let teamId: string | null = null;
    if (input.teamId !== undefined && input.teamId !== null) {
      const team = tx
        .query<{ id: string }>(
          "SELECT id FROM teams WHERE organization_id = ? AND (id = ? OR key = ?)",
        )
        .get(principal.organizationId, text(input.teamId, "team ID"), String(input.teamId));
      if (!team) throw new DomainError("NOT_FOUND", "Team not found");
      requireTeam(principal, { id: team.id, organizationId: principal.organizationId });
      teamId = team.id;
    }
    if (teamId && input.allPublicTeams === true)
      invalid("Choose a single team or all public teams");
    if (tx.query("SELECT id FROM webhook_subscriptions WHERE id = ?").get(subscriptionId))
      throw new DomainError("CONFLICT", "Webhook already exists");
    tx.run(
      `INSERT INTO webhook_subscriptions
      (id, organization_id, creator_id, team_id, all_public_teams, enabled, url, secret, label, resource_types, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      subscriptionId,
      principal.organizationId,
      principal.userId,
      teamId,
      boolean(input.allPublicTeams, false),
      boolean(input.enabled, true),
      url(input.url),
      input.secret === undefined || input.secret === null
        ? crypto.randomUUID()
        : text(input.secret, "secret"),
      label(input.label),
      resourceTypes(input.resourceTypes),
      tx.now,
      tx.now,
    );
    return {
      success: true,
      lastSyncId: tx.syncId,
      webhook: projectSubscription(subscription(tx, principal, subscriptionId)),
    };
  });
}

export function updateSubscription(
  runtime: Runtime,
  principal: Principal,
  subscriptionId: unknown,
  input: Record<string, unknown>,
) {
  requireAdmin(principal);
  if (
    Object.keys(input).some(
      (key) => !["enabled", "label", "resourceTypes", "secret", "url"].includes(key),
    )
  )
    invalid("Invalid webhook update");
  return runtime.database.transaction((tx) => {
    const row = subscription(tx, principal, subscriptionId);
    if (row.app_user_id) throw new DomainError("FORBIDDEN", "OAuth webhooks use app provisioning");
    tx.run(
      `UPDATE webhook_subscriptions SET enabled = ?, label = ?, resource_types = ?, secret = ?, url = ?, updated_at = ? WHERE id = ?`,
      input.enabled === undefined ? row.enabled : boolean(input.enabled, false),
      input.label === undefined ? row.label : label(input.label),
      input.resourceTypes === undefined ? row.resource_types : resourceTypes(input.resourceTypes),
      input.secret === undefined ? row.secret : text(input.secret, "secret"),
      input.url === undefined ? row.url : url(input.url),
      tx.now,
      row.id,
    );
    return {
      success: true,
      lastSyncId: tx.syncId,
      webhook: projectSubscription(subscription(tx, principal, row.id)),
    };
  });
}

export function deleteSubscription(
  runtime: Runtime,
  principal: Principal,
  subscriptionId: unknown,
) {
  requireAdmin(principal);
  return runtime.database.transaction((tx) => {
    const row = subscription(tx, principal, subscriptionId);
    if (row.app_user_id) throw new DomainError("FORBIDDEN", "OAuth webhooks use app provisioning");
    tx.run("DELETE FROM webhook_subscriptions WHERE id = ?", row.id);
    return { success: true, lastSyncId: tx.syncId, entityId: row.id };
  });
}
