import { createHmac } from "node:crypto";
import type { JsonObject, Transaction } from "../core/database";
import type { Runtime } from "../core/runtime";
import { DomainError } from "../core/errors";
import { provisionAppWebhook, type Subscription } from "./subscriptions";

export interface DeliveryRecord {
  id: string;
  event_id: string;
  subscription_id: string;
  organization_id: string;
  url: string;
  resource_type: string;
  envelope: string;
  occurred_at: number;
  due_at: number | null;
  status: "pending" | "acknowledged" | "exhausted";
}
interface SendRecord extends DeliveryRecord {
  secret: string;
}
export interface AttemptRecord {
  id: string;
  delivery_id: string;
  number: number;
  sent_at: number;
  completed_at: number | null;
  body: string;
  headers: string;
  http_status: number | null;
  error: string | null;
}
interface EventRow {
  sequence: number;
  id: string;
  organization_id: string;
  team_id: string | null;
  resource_type: string;
  action: string;
  actor_id: string | null;
  occurred_at: number;
  data: string;
  updated_from: string | null;
  target_app_user_id: string | null;
  oauth_client_id: string | null;
  actor: string | null;
  source: string | null;
}

export const retryDelays = [60_000, 3_600_000, 21_600_000] as const;
export const deliveryIdentity =
  "One UUID per committed event/subscription pair; Linear-Delivery is stable across retries; each attempt has its own UUID.";
const queues = new WeakMap<Runtime, Promise<void>>();

function matches(tx: Transaction, event: EventRow, sub: Subscription): boolean {
  if (!sub.enabled || sub.revoked) return false;
  if (event.resource_type === "AgentSessionEvent" || event.resource_type === "OAuthApp") {
    if (
      !event.target_app_user_id ||
      !event.oauth_client_id ||
      sub.app_user_id !== event.target_app_user_id ||
      sub.oauth_client_id !== event.oauth_client_id
    )
      return false;
    return event.resource_type === "OAuthApp"
      ? event.action === "revoked"
      : Boolean(sub.agent_session_events) && ["created", "prompted"].includes(event.action);
  }
  if (!(JSON.parse(sub.resource_types) as string[]).includes(event.resource_type)) return false;
  const source = event.source ? (JSON.parse(event.source) as JsonObject) : {};
  const teamIds = event.team_id
    ? [event.team_id]
    : Array.isArray(source.teamIds)
      ? source.teamIds.filter((value): value is string => typeof value === "string")
      : [];
  if (!teamIds.length) return !sub.team_id;
  return teamIds.some((teamId) => {
    const team = tx
      .query<{ private: number }>("SELECT private FROM teams WHERE id = ? AND organization_id = ?")
      .get(teamId, event.organization_id);
    if (!team) return false;
    if (sub.team_id) return sub.team_id === teamId;
    if (sub.app_user_id && team.private)
      return Boolean(
        tx
          .query(
            "SELECT user_id FROM team_memberships WHERE organization_id = ? AND team_id = ? AND user_id = ?",
          )
          .get(event.organization_id, teamId, sub.app_user_id),
      );
    return sub.all_public_teams ? !team.private : true;
  });
}

function envelope(event: EventRow, webhookId: string): JsonObject {
  const data = JSON.parse(event.data) as JsonObject;
  const common: JsonObject = {
    action: event.action,
    type: event.resource_type,
    organizationId: event.organization_id,
    createdAt: new Date(event.occurred_at).toISOString(),
    webhookId,
  };
  if (event.resource_type === "AgentSessionEvent") {
    common.appUserId = event.target_app_user_id;
    common.oauthClientId = event.oauth_client_id;
    for (const field of [
      "agentSession",
      "agentActivity",
      "promptContext",
      "guidance",
      "previousComments",
    ])
      if (data[field] !== undefined) common[field] = data[field]!;
    return common;
  }
  if (event.resource_type === "OAuthApp") {
    return { ...common, oauthClientId: event.oauth_client_id };
  }
  common.data = data;
  if (event.actor) common.actor = JSON.parse(event.actor) as JsonObject;
  if (event.updated_from) common.updatedFrom = JSON.parse(event.updated_from) as JsonObject;
  const source = event.source ? (JSON.parse(event.source) as JsonObject) : {};
  if (typeof source.url === "string") common.url = source.url;
  else if (typeof data.url === "string") common.url = data.url;
  return common;
}

function fanout(tx: Transaction): void {
  const events = tx
    .query<EventRow>(
      `SELECT * FROM outbox WHERE sequence > (SELECT sequence FROM webhook_progress WHERE id = 1) ORDER BY sequence`,
    )
    .all();
  for (const event of events) {
    const subscriptions = tx
      .query<Subscription>("SELECT * FROM webhook_subscriptions WHERE organization_id = ?")
      .all(event.organization_id);
    for (const sub of subscriptions) {
      if (!matches(tx, event, sub)) continue;
      tx.run(
        `INSERT OR IGNORE INTO webhook_deliveries
        (id, event_id, subscription_id, organization_id, url, secret, resource_type, envelope, occurred_at, due_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        crypto.randomUUID(),
        event.id,
        sub.id,
        event.organization_id,
        sub.url,
        sub.secret,
        event.resource_type,
        JSON.stringify(envelope(event, sub.id)),
        event.occurred_at,
        tx.now,
      );
    }
    if (
      event.resource_type === "OAuthApp" &&
      event.action === "revoked" &&
      event.target_app_user_id &&
      event.oauth_client_id
    ) {
      tx.run(
        `UPDATE webhook_subscriptions SET revoked = 1, enabled = 0, updated_at = ?
        WHERE organization_id = ? AND app_user_id = ? AND oauth_client_id = ?`,
        tx.now,
        event.organization_id,
        event.target_app_user_id,
        event.oauth_client_id,
      );
    }
    tx.run("UPDATE webhook_progress SET sequence = ? WHERE id = 1", event.sequence);
  }
}

function complete(
  tx: Transaction,
  attempt: AttemptRecord,
  status: number | null,
  error: string | null,
): void {
  tx.run(
    "UPDATE webhook_attempts SET completed_at = ?, http_status = ?, error = ? WHERE id = ?",
    tx.now,
    status,
    error,
    attempt.id,
  );
  const acknowledged = status === 200;
  const delay = retryDelays[attempt.number - 1];
  tx.run(
    "UPDATE webhook_deliveries SET status = ?, due_at = ? WHERE id = ?",
    acknowledged ? "acknowledged" : delay === undefined ? "exhausted" : "pending",
    acknowledged || delay === undefined ? null : tx.now + delay,
    attempt.delivery_id,
  );
}

export interface Delivery {
  runDue(): Promise<void>;
  nextDueAt(): number | null;
  close(): Promise<void>;
  deliveries(): DeliveryRecord[];
  attempts(deliveryId?: string): AttemptRecord[];
  provisionAppWebhook: typeof provisionAppWebhook;
}

export function createDelivery(runtime: Runtime): Delivery {
  let closed = false;
  let pending: Promise<void> = Promise.resolve();
  async function drain() {
    runtime.database.transaction((tx) => {
      const interrupted = tx
        .query<AttemptRecord>(
          "SELECT * FROM webhook_attempts WHERE completed_at IS NULL ORDER BY sent_at, id",
        )
        .all();
      for (const attempt of interrupted)
        complete(tx, attempt, null, "Interrupted before acknowledgment");
      fanout(tx);
    });
    for (;;) {
      const reserved = runtime.database.transaction((tx) => {
        fanout(tx);
        const record = tx
          .query<SendRecord>(
            "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, rowid LIMIT 1",
          )
          .get(tx.now);
        if (!record) return null;
        const number =
          tx
            .query<{ count: number }>(
              "SELECT count(*) AS count FROM webhook_attempts WHERE delivery_id = ?",
            )
            .get(record.id)!.count + 1;
        const body = JSON.stringify({
          ...(JSON.parse(record.envelope) as JsonObject),
          webhookTimestamp: tx.now,
        });
        const headers = {
          "Content-Type": "application/json",
          "Linear-Delivery": record.id,
          "Linear-Event": record.resource_type,
          "Linear-Timestamp": String(tx.now),
          "Linear-Signature": createHmac("sha256", record.secret).update(body).digest("hex"),
          "User-Agent": "Linear-Webhook",
        };
        const attempt: AttemptRecord = {
          id: crypto.randomUUID(),
          delivery_id: record.id,
          number,
          sent_at: tx.now,
          completed_at: null,
          body,
          headers: JSON.stringify(headers),
          http_status: null,
          error: null,
        };
        tx.run(
          "INSERT INTO webhook_attempts (id, delivery_id, number, sent_at, body, headers) VALUES (?, ?, ?, ?, ?, ?)",
          attempt.id,
          record.id,
          number,
          tx.now,
          body,
          attempt.headers,
        );
        return { record, attempt, headers };
      });
      if (!reserved) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let status: number | null = null;
      let error: string | null = null;
      try {
        const response = await fetch(reserved.record.url, {
          method: "POST",
          body: reserved.attempt.body,
          headers: reserved.headers,
          signal: controller.signal,
          redirect: "manual",
        });
        status = response.status;
        await response.body?.cancel();
        if (status !== 200) error = `HTTP ${status}`;
      } catch {
        error = controller.signal.aborted
          ? "Response deadline exceeded (5000ms)"
          : "Network request failed";
      } finally {
        clearTimeout(timeout);
      }
      runtime.database.transaction((tx) => complete(tx, reserved.attempt, status, error));
    }
  }
  return {
    provisionAppWebhook,
    runDue() {
      if (closed) return Promise.reject(new DomainError("CONFLICT", "Delivery is closed"));
      const previous = queues.get(runtime) ?? Promise.resolve();
      pending = previous.catch(() => {}).then(drain);
      queues.set(runtime, pending);
      return pending;
    },
    nextDueAt() {
      if (closed) return null;
      if (
        runtime.database
          .query(
            "SELECT sequence FROM outbox WHERE sequence > (SELECT sequence FROM webhook_progress WHERE id = 1) LIMIT 1",
          )
          .get()
      )
        return runtime.clock.now();
      return (
        runtime.database
          .query<{ due: number | null }>(
            "SELECT min(due_at) AS due FROM webhook_deliveries WHERE status = 'pending'",
          )
          .get()?.due ?? null
      );
    },
    async close() {
      closed = true;
      await pending;
    },
    deliveries() {
      return runtime.database
        .query<DeliveryRecord>(
          `SELECT id, event_id, subscription_id, organization_id, url, resource_type, envelope, occurred_at, due_at, status FROM webhook_deliveries ORDER BY rowid`,
        )
        .all();
    },
    attempts(deliveryId) {
      return runtime.database
        .query<AttemptRecord>(
          `SELECT * FROM webhook_attempts ${deliveryId === undefined ? "" : "WHERE delivery_id = ?"} ORDER BY rowid`,
        )
        .all(...(deliveryId === undefined ? [] : [deliveryId]));
    },
  };
}
