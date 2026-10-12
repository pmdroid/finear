import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MigrationSet, ReadDatabase, Transaction } from "../core/database";
import { DomainError } from "../core/errors";
import {
  requireOrganization,
  requireOwningApp,
  requireScope,
  requireTeam,
  type AppOwner,
  type Principal,
} from "../core/principal";
import type { ResetOwner, Runtime } from "../core/runtime";
import type { HttpHandler } from "../server";
import { createAppUser } from "../workspace/directory";
import { fixtureIds } from "../workspace/fixtures";
import { authenticateFixture } from "./fixture";
import { fixtureOAuthClients } from "./fixtures";
export { identityMigrations } from "./schema";
export { identityResolvers } from "./resolvers";
export { fixtureOAuthClient, fixtureOAuthPublicClient, fixtureOAuthClients } from "./fixtures";

export const oauthLifetimes = {
  code: 600_000,
  consent: 600_000,
  access: 86_400_000,
  refresh: 7_776_000_000,
  recovery: 1_800_000,
} as const;

export interface AppWebhookConfiguration {
  url: string;
  secret: string;
  resourceTypes: readonly string[];
  agentSessionEvents?: boolean;
}

export interface ClientRegistration {
  id: string;
  name: string;
  secret?: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  webhook?: AppWebhookConfiguration;
}

export interface Installation extends AppOwner {
  installerId: string;
}

export interface InstallationProvisioningInput {
  organizationId: string;
  oauthClientId: string;
  appUserId: string;
  url: string;
  secret: string;
  resourceTypes: readonly string[];
  agentSessionEvents: boolean;
}

export interface IdentityOptions {
  clients?: readonly ClientRegistration[];
  provisionAppWebhook?: (tx: Transaction, input: InstallationProvisioningInput) => string;
}

export interface Identity {
  authenticate(request: Request): Principal;
  handler: HttpHandler;
  resetOwner: ResetOwner;
  requireInstallation(db: ReadDatabase, principal: Principal): Installation;
  requireAccess(tx: Transaction, principal: Principal, access: IdentityAccess): void;
}

export interface IdentityAccess {
  organizationId: string;
  teamId?: string;
  scope?: string;
}

interface ClientRow {
  id: string;
  name: string;
  secret_hash: string | null;
  redirect_uris: string;
  scopes: string;
  webhook: string | null;
}

interface GrantRow {
  id: string;
  organization_id: string;
  client_id: string;
  user_id: string;
  actor: "user" | "app";
  installation_id: string | null;
  scopes: string;
  team_ids: string;
  pkce: number;
  revoked_at: number | null;
}

interface TokenRow {
  id: string;
  grant_id: string;
  access_expires_at: number;
  refresh_expires_at: number;
  rotated_at: number | null;
  successor_id: string | null;
  recovery_salt: string | null;
}

class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const list = (value: string): string[] => JSON.parse(value) as string[];
const equal = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
const supportedScopes = new Set([
  "read",
  "write",
  "issues:create",
  "comments:create",
  "timeSchedule:write",
  "admin",
  "app:assignable",
  "app:mentionable",
  "initiative:read",
  "initiative:write",
  "customer:read",
  "customer:write",
]);

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) && !url.hash && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export function registerClient(tx: Transaction, client: ClientRegistration): void {
  if (
    !client.id ||
    !client.name ||
    client.secret === "" ||
    !client.redirectUris.length ||
    client.redirectUris.some((uri) => !validUrl(uri)) ||
    client.scopes.some((scope) => !supportedScopes.has(scope)) ||
    (client.webhook &&
      (!validUrl(client.webhook.url) ||
        !client.webhook.secret ||
        !client.webhook.resourceTypes.length))
  ) {
    throw new DomainError("INVALID_INPUT", "Invalid OAuth client registration");
  }
  tx.run(
    "INSERT INTO oauth_clients (id, name, secret_hash, redirect_uris, scopes, webhook) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    client.id,
    client.name,
    client.secret ? hash(client.secret) : null,
    JSON.stringify(client.redirectUris),
    JSON.stringify(client.scopes),
    client.webhook ? JSON.stringify(client.webhook) : null,
  );
}

function grant(db: ReadDatabase, id: string): GrantRow {
  const value = db
    .query<GrantRow>("SELECT * FROM oauth_grants WHERE id = ? AND revoked_at IS NULL")
    .get(id);
  if (!value) throw new DomainError("UNAUTHENTICATED", "OAuth grant is inactive");
  return value;
}

export function requireInstallation(db: ReadDatabase, principal: Principal): Installation {
  const row = db
    .query<{
      id: string;
      organization_id: string;
      client_id: string;
      app_user_id: string;
      installer_id: string;
    }>("SELECT * FROM oauth_installations WHERE id = ? AND revoked_at IS NULL")
    .get(principal.installationId);
  if (!row) throw new DomainError("FORBIDDEN", "Active app installation required");
  const result: Installation = {
    installationId: row.id,
    organizationId: row.organization_id,
    oauthClientId: row.client_id,
    appUserId: row.app_user_id,
    installerId: row.installer_id,
  };
  requireOwningApp(principal, result);
  const current = grant(db, principal.grantId ?? "");
  if (
    current.installation_id !== result.installationId ||
    current.user_id !== result.appUserId ||
    current.client_id !== result.oauthClientId ||
    current.organization_id !== result.organizationId ||
    current.actor !== "app"
  )
    throw new DomainError("FORBIDDEN", "Installation grant mismatch");
  return result;
}

export function requireDelegate(
  db: ReadDatabase,
  input: { organizationId: string; teamId: string; appUserId: string },
): AppOwner {
  return requireAppTarget(db, input, "assignable");
}

export function requireMention(
  db: ReadDatabase,
  input: { organizationId: string; teamId: string; appUserId: string },
): AppOwner {
  return requireAppTarget(db, input, "mentionable");
}

function requireAppTarget(
  db: ReadDatabase,
  input: { organizationId: string; teamId: string; appUserId: string },
  capability: "assignable" | "mentionable",
): AppOwner {
  const installation = db
    .query<{
      id: string;
      client_id: string;
      settings: string;
    }>(`SELECT i.id, i.client_id, u.settings
      FROM oauth_installations i
      JOIN users u ON u.id = i.app_user_id AND u.organization_id = i.organization_id
      JOIN team_memberships m ON m.user_id = u.id AND m.organization_id = u.organization_id
      WHERE i.organization_id = ? AND i.app_user_id = ? AND i.revoked_at IS NULL
        AND u.app = 1 AND m.team_id = ?`)
    .get(input.organizationId, input.appUserId, input.teamId);
  if (
    !installation ||
    (JSON.parse(installation.settings) as Record<string, unknown>)[
      capability === "assignable" ? "isAssignable" : "isMentionable"
    ] !== true
  )
    throw new DomainError(
      "FORBIDDEN",
      capability === "assignable"
        ? "Assignable app installation required"
        : "Mentionable app installation required",
    );
  const grants = db
    .query<GrantRow>(`SELECT * FROM oauth_grants
      WHERE organization_id = ? AND installation_id = ? AND client_id = ?
        AND user_id = ? AND actor = 'app' AND revoked_at IS NULL`)
    .all(input.organizationId, installation.id, installation.client_id, input.appUserId);
  if (
    !grants.some(
      (current) =>
        list(current.scopes).includes(`app:${capability}`) &&
        list(current.team_ids).includes(input.teamId),
    )
  )
    throw new DomainError(
      "FORBIDDEN",
      capability === "assignable"
        ? "App assignment is not approved for this team"
        : "App mention is not approved for this team",
    );
  return {
    organizationId: input.organizationId,
    appUserId: input.appUserId,
    oauthClientId: installation.client_id,
    installationId: installation.id,
  };
}

function principalForGrant(db: ReadDatabase, current: GrantRow): Principal {
  const user = db
    .query<{ admin: number; app: number }>(
      "SELECT admin, app FROM users WHERE organization_id = ? AND id = ?",
    )
    .get(current.organization_id, current.user_id);
  if (!user || Boolean(user.app) !== (current.actor === "app"))
    throw new DomainError("UNAUTHENTICATED", "OAuth user is unavailable");
  const memberships = db
    .query<{ team_id: string }>(
      "SELECT team_id FROM team_memberships WHERE organization_id = ? AND user_id = ?",
    )
    .all(current.organization_id, current.user_id)
    .map((row) => row.team_id);
  const principal: Principal = {
    organizationId: current.organization_id,
    userId: current.user_id,
    actor: current.actor,
    oauthClientId: current.client_id,
    installationId: current.installation_id,
    grantId: current.id,
    scopes: list(current.scopes),
    teamIds: list(current.team_ids).filter((id) => memberships.includes(id)),
    admin: current.actor === "user" && Boolean(user.admin),
  };
  if (current.actor === "app") requireInstallation(db, principal);
  return principal;
}

export function requireIdentityAccess(
  tx: Transaction,
  principal: Principal,
  access: IdentityAccess,
): void {
  requireOrganization(principal, access.organizationId);
  let current = principal;
  if (principal.actor !== "apiKey") {
    current = principalForGrant(tx, grant(tx, principal.grantId ?? ""));
    if (
      current.userId !== principal.userId ||
      current.actor !== principal.actor ||
      current.oauthClientId !== principal.oauthClientId ||
      current.installationId !== principal.installationId
    )
      throw new DomainError("FORBIDDEN", "Identity mismatch");
    requireOrganization(current, access.organizationId);
  }
  if (access.scope) {
    requireScope(principal, access.scope);
    requireScope(current, access.scope);
  }
  if (access.teamId) {
    const team = tx
      .query<{ id: string; organization_id: string }>(
        "SELECT id, organization_id FROM teams WHERE id = ?",
      )
      .get(access.teamId);
    if (!team) throw new DomainError("FORBIDDEN", "Team access denied");
    requireTeam(principal, { id: team.id, organizationId: team.organization_id });
    requireTeam(current, { id: team.id, organizationId: team.organization_id });
    if (
      !tx
        .query(
          "SELECT team_id FROM team_memberships WHERE organization_id = ? AND team_id = ? AND user_id = ?",
        )
        .get(access.organizationId, access.teamId, principal.userId)
    )
      throw new DomainError("FORBIDDEN", "Team access denied");
  }
}

function parameters(form: URLSearchParams): URLSearchParams {
  for (const key of new Set(form.keys()))
    if (form.getAll(key).length > 1 && key !== "team_id") throw new OAuthError("invalid_request");
  return form;
}

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

export function createIdentity(runtime: Runtime, options: IdentityOptions = {}): Identity {
  const clients = options.clients ?? fixtureOAuthClients;
  const resetOwner: ResetOwner = {
    clear(tx) {
      for (const table of [
        "oauth_tokens",
        "oauth_codes",
        "oauth_grants",
        "oauth_installations",
        "oauth_consents",
        "oauth_clients",
      ])
        tx.run(`DELETE FROM ${table}`);
    },
    seed(tx) {
      for (const client of clients) registerClient(tx, client);
    },
  };
  runtime.database.transaction((tx) => resetOwner.seed!(tx));

  function clientFor(db: ReadDatabase, id: string | null): ClientRow {
    const client = db.query<ClientRow>("SELECT * FROM oauth_clients WHERE id = ?").get(id);
    if (!client) throw new OAuthError("invalid_client", 401);
    return client;
  }

  function authenticate(request: Request): Principal {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) return authenticateFixture(request, runtime);
    const token = runtime.database
      .query<TokenRow>("SELECT * FROM oauth_tokens WHERE access_hash = ?")
      .get(hash(match[1]!));
    if (!token || token.rotated_at !== null || token.access_expires_at <= runtime.clock.now())
      throw new DomainError("UNAUTHENTICATED", "Invalid or expired access token");
    return principalForGrant(runtime.database, grant(runtime.database, token.grant_id));
  }

  function authorization(form: URLSearchParams): ClientRow {
    const client = clientFor(runtime.database, form.get("client_id"));
    if (!list(client.redirect_uris).includes(form.get("redirect_uri") ?? ""))
      throw new OAuthError("invalid_redirect_uri");
    if (form.get("response_type") !== "code") throw new OAuthError("unsupported_response_type");
    const actor = form.get("actor") ?? "user";
    if (actor !== "user" && actor !== "app") throw new OAuthError("invalid_request");
    const requested = form.get("scope");
    if (!requested) throw new OAuthError("invalid_scope");
    const scopes = [...new Set(["read", ...requested.split(",")])];
    if (
      scopes.some((scope) => !supportedScopes.has(scope) || !list(client.scopes).includes(scope)) ||
      (actor === "app" && scopes.includes("admin"))
    )
      throw new OAuthError("invalid_scope");
    form.set("scope", scopes.join(","));
    const challenge = form.get("code_challenge");
    const method = form.get("code_challenge_method") ?? "plain";
    if (
      (!challenge &&
        (form.has("code_challenge") || form.has("code_challenge_method") || !client.secret_hash)) ||
      (challenge &&
        (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge) ||
          !["plain", "S256"].includes(method) ||
          (method === "S256" && !/^[A-Za-z0-9_-]{43}$/.test(challenge))))
    )
      throw new OAuthError("invalid_request");
    return client;
  }

  function beginConsent(form: URLSearchParams): Response {
    const client = authorization(form);
    const nonce = opaque();
    runtime.database.transaction((tx) =>
      tx.run(
        "INSERT INTO oauth_consents VALUES (?, ?, ?, ?)",
        hash(nonce),
        client.id,
        JSON.stringify(Object.fromEntries(form)),
        tx.now + oauthLifetimes.consent,
      ),
    );
    const choices = Object.values(fixtureIds)
      .map((ids) => {
        const user = runtime.database
          .query<{ name: string }>(
            "SELECT name FROM users WHERE id = ? AND organization_id = ? AND app = 0",
          )
          .get(ids.user, ids.organization);
        if (!user) return "";
        const teams = runtime.database
          .query<{ id: string; name: string }>(
            "SELECT t.id, t.name FROM teams t JOIN team_memberships m ON m.team_id = t.id WHERE m.user_id = ? AND m.organization_id = ?",
          )
          .all(ids.user, ids.organization);
        return `<form method="post" action="/oauth/authorize"><input type="hidden" name="consent" value="${html(nonce)}"><input type="hidden" name="user_id" value="${ids.user}"><input type="hidden" name="workspace_id" value="${ids.organization}"><h2>${html(user.name)} · ${ids.organization}</h2>${teams.map((team) => `<label><input type="checkbox" name="team_id" value="${team.id}" checked>${html(team.name)}</label>`).join("")}<button name="decision" value="allow">Authorize ${html(client.name)}</button><button name="decision" value="deny">Deny</button></form>`;
      })
      .join("");
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local OAuth consent</title><h1>Choose a fixture user and workspace</h1><p>${html(client.name)} requests ${html(form.get("scope")!)} as ${html(form.get("actor") ?? "user")}.</p>${choices}</html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
          "referrer-policy": "no-referrer",
        },
      },
    );
  }

  function finishConsent(form: URLSearchParams): Response {
    return runtime.database.transaction((tx) => {
      const consent = tx
        .query<{ parameters: string; expires_at: number }>(
          "DELETE FROM oauth_consents WHERE hash = ? RETURNING parameters, expires_at",
        )
        .get(hash(form.get("consent") ?? ""));
      if (!consent || consent.expires_at <= tx.now) throw new OAuthError("invalid_request");
      const stored = new URLSearchParams(JSON.parse(consent.parameters) as Record<string, string>);
      const client = authorization(stored);
      const callback = new URL(stored.get("redirect_uri")!);
      if (stored.has("state")) callback.searchParams.set("state", stored.get("state")!);
      if (form.get("decision") === "deny") {
        callback.searchParams.set("error", "access_denied");
        return Response.redirect(callback, 302);
      }
      if (form.get("decision") !== "allow") throw new OAuthError("invalid_request");
      const organizationId = form.get("workspace_id") ?? "";
      const installerId = form.get("user_id") ?? "";
      if (
        !Object.values(fixtureIds).some(
          (ids) => ids.organization === organizationId && ids.user === installerId,
        )
      )
        throw new OAuthError("access_denied", 403);
      const installer = tx
        .query<{ admin: number }>(
          "SELECT admin FROM users WHERE organization_id = ? AND id = ? AND app = 0",
        )
        .get(organizationId, installerId);
      if (!installer) throw new OAuthError("access_denied", 403);
      const scopes = stored.get("scope")!.split(",");
      const actor = stored.get("actor") ?? "user";
      if ((actor === "app" || scopes.includes("admin")) && !installer.admin)
        throw new OAuthError("access_denied", 403);
      const teamIds = [...new Set(form.getAll("team_id"))];
      if (
        teamIds.some(
          (id) =>
            !tx
              .query(
                "SELECT team_id FROM team_memberships WHERE organization_id = ? AND user_id = ? AND team_id = ?",
              )
              .get(organizationId, installerId, id),
        )
      )
        throw new OAuthError("access_denied", 403);
      let userId = installerId;
      let installationId: string | null = null;
      if (actor === "app") {
        const existing = tx
          .query<{ id: string; app_user_id: string }>(
            "SELECT id, app_user_id FROM oauth_installations WHERE organization_id = ? AND client_id = ? AND revoked_at IS NULL",
          )
          .get(organizationId, client.id);
        installationId = existing?.id ?? crypto.randomUUID();
        userId =
          existing?.app_user_id ??
          createAppUser(tx, {
            id: crypto.randomUUID(),
            organizationId,
            name: client.name,
            email: `${client.id}@apps.example.test`,
            createdAt: tx.now,
          });
        if (!existing)
          tx.run(
            "INSERT INTO oauth_installations (id, organization_id, client_id, app_user_id, installer_id) VALUES (?, ?, ?, ?, ?)",
            installationId,
            organizationId,
            client.id,
            userId,
            installerId,
          );
        for (const teamId of teamIds)
          tx.run(
            "INSERT OR IGNORE INTO team_memberships VALUES (?, ?, ?)",
            organizationId,
            teamId,
            userId,
          );
        tx.run(
          "UPDATE users SET settings = json_set(settings, '$.isAssignable', json(?), '$.isMentionable', json(?), '$.supportsAgentSessions', json('true'), '$.canAccessAnyPublicTeam', json('false')) WHERE id = ?",
          JSON.stringify(scopes.includes("app:assignable")),
          JSON.stringify(scopes.includes("app:mentionable")),
          userId,
        );
        if (!existing && client.webhook) {
          if (!options.provisionAppWebhook)
            throw new DomainError(
              "CONFLICT",
              "Delivery provisioning is required for this OAuth client",
            );
          const webhook = JSON.parse(client.webhook) as AppWebhookConfiguration;
          const result: unknown = options.provisionAppWebhook(tx, {
            organizationId,
            oauthClientId: client.id,
            appUserId: userId,
            url: webhook.url,
            secret: webhook.secret,
            resourceTypes: webhook.resourceTypes,
            agentSessionEvents: webhook.agentSessionEvents ?? false,
          });
          if (
            result &&
            (typeof result === "object" || typeof result === "function") &&
            "then" in result
          ) {
            Promise.resolve(result).catch(() => {});
            throw new DomainError("INVALID_INPUT", "Delivery provisioning must be synchronous");
          }
        }
      }
      const grantId = crypto.randomUUID();
      tx.run(
        "INSERT INTO oauth_grants (id, organization_id, client_id, user_id, actor, installation_id, scopes, team_ids, pkce) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        grantId,
        organizationId,
        client.id,
        userId,
        actor,
        installationId,
        JSON.stringify(scopes),
        JSON.stringify(teamIds),
        stored.has("code_challenge") ? 1 : 0,
      );
      const code = opaque();
      tx.run(
        "INSERT INTO oauth_codes (hash, grant_id, redirect_uri, challenge, method, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        hash(code),
        grantId,
        stored.get("redirect_uri"),
        stored.get("code_challenge"),
        stored.has("code_challenge") ? (stored.get("code_challenge_method") ?? "plain") : null,
        tx.now + oauthLifetimes.code,
      );
      callback.searchParams.set("code", code);
      return Response.redirect(callback, 302);
    });
  }

  function credentials(
    request: Request,
    form: URLSearchParams,
  ): { client: ClientRow; authenticated: boolean } {
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    const header = request.headers.get("authorization");
    if (header) {
      if (id !== null || secret !== null || !/^Basic [A-Za-z0-9+/]+=*$/.test(header))
        throw new OAuthError("invalid_client", 401);
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) throw new OAuthError("invalid_client", 401);
      try {
        id = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      } catch {
        throw new OAuthError("invalid_client", 401);
      }
    }
    const client = clientFor(runtime.database, id);
    if (secret !== null && (!client.secret_hash || !equal(hash(secret), client.secret_hash)))
      throw new OAuthError("invalid_client", 401);
    return { client, authenticated: secret !== null };
  }

  function issueTokens(
    tx: Transaction,
    current: GrantRow,
    material = { access: opaque(), refresh: opaque() },
  ): { response: Response; id: string } {
    const id = crypto.randomUUID();
    tx.run(
      "INSERT INTO oauth_tokens (id, grant_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      current.id,
      hash(material.access),
      hash(material.refresh),
      tx.now + oauthLifetimes.access,
      tx.now + oauthLifetimes.refresh,
    );
    return { id, response: tokenResponse(current, material, oauthLifetimes.access) };
  }

  function tokenResponse(
    current: GrantRow,
    material: { access: string; refresh: string },
    lifetime: number,
  ): Response {
    return json({
      access_token: material.access,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor(lifetime / 1000)),
      scope: list(current.scopes).join(" "),
      refresh_token: material.refresh,
    });
  }

  function exchange(request: Request, form: URLSearchParams): Response {
    const { client, authenticated } = credentials(request, form);
    return runtime.database.transaction((tx) => {
      if (form.get("grant_type") === "authorization_code") {
        const code = tx
          .query<{
            grant_id: string;
            redirect_uri: string;
            challenge: string | null;
            method: string | null;
            expires_at: number;
            consumed_at: number | null;
          }>("SELECT * FROM oauth_codes WHERE hash = ?")
          .get(hash(form.get("code") ?? ""));
        if (
          !code ||
          code.consumed_at !== null ||
          code.expires_at <= tx.now ||
          code.redirect_uri !== form.get("redirect_uri")
        )
          throw new OAuthError("invalid_grant");
        const current = grant(tx, code.grant_id);
        if (current.client_id !== client.id) throw new OAuthError("invalid_grant");
        if (code.challenge) {
          const verifier = form.get("code_verifier") ?? "";
          if (
            !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
            !equal(
              code.method === "S256"
                ? createHash("sha256").update(verifier).digest("base64url")
                : verifier,
              code.challenge,
            )
          )
            throw new OAuthError("invalid_grant");
        } else if (!authenticated) throw new OAuthError("invalid_client", 401);
        principalForGrant(tx, current);
        tx.run(
          "UPDATE oauth_codes SET consumed_at = ? WHERE hash = ?",
          tx.now,
          hash(form.get("code")!),
        );
        return issueTokens(tx, current).response;
      }
      if (form.get("grant_type") !== "refresh_token")
        throw new OAuthError("unsupported_grant_type");
      const raw = form.get("refresh_token") ?? "";
      const token = tx
        .query<TokenRow>("SELECT * FROM oauth_tokens WHERE refresh_hash = ?")
        .get(hash(raw));
      if (!token || token.refresh_expires_at <= tx.now) throw new OAuthError("invalid_grant");
      const current = grant(tx, token.grant_id);
      if (current.client_id !== client.id) throw new OAuthError("invalid_grant");
      if (!current.pkce && !authenticated) throw new OAuthError("invalid_client", 401);
      principalForGrant(tx, current);
      const salt = token.recovery_salt ?? opaque();
      const material = {
        access: createHmac("sha256", raw).update(`access:${salt}`).digest("base64url"),
        refresh: createHmac("sha256", raw).update(`refresh:${salt}`).digest("base64url"),
      };
      if (token.rotated_at !== null) {
        const successor = tx
          .query<TokenRow>("SELECT * FROM oauth_tokens WHERE id = ?")
          .get(token.successor_id);
        if (
          tx.now >= token.rotated_at + oauthLifetimes.recovery ||
          !successor ||
          successor.rotated_at !== null ||
          successor.access_expires_at <= tx.now
        )
          throw new OAuthError("invalid_grant");
        return tokenResponse(current, material, successor.access_expires_at - tx.now);
      }
      const issued = issueTokens(tx, current, material);
      tx.run(
        "UPDATE oauth_tokens SET rotated_at = ?, successor_id = ?, recovery_salt = ? WHERE id = ?",
        tx.now,
        issued.id,
        salt,
        token.id,
      );
      return issued.response;
    });
  }

  function revoke(request: Request, form: URLSearchParams): Response {
    const authorizationHeader = request.headers.get("authorization");
    const hint = form.get("token_type_hint");
    if (hint && !["access_token", "refresh_token"].includes(hint))
      throw new OAuthError("invalid_request");
    if (
      form.has("token") &&
      (form.has("access_token") || form.has("refresh_token") || authorizationHeader)
    )
      throw new OAuthError("invalid_request");
    const legacy = [
      form.get("access_token"),
      form.get("refresh_token"),
      authorizationHeader?.replace(/^Bearer\s+/i, ""),
    ].filter((value) => value !== null && value !== undefined);
    if (legacy.length > 1) throw new OAuthError("invalid_request");
    const raw = form.get("token") ?? legacy[0];
    if (!raw) throw new OAuthError("invalid_client", 401);
    return runtime.database.transaction((tx) => {
      const token = tx
        .query<TokenRow>("SELECT * FROM oauth_tokens WHERE access_hash = ? OR refresh_hash = ?")
        .get(hash(raw), hash(raw));
      if (!token) throw new OAuthError("invalid_client", 401);
      const current = tx
        .query<GrantRow>("SELECT * FROM oauth_grants WHERE id = ?")
        .get(token.grant_id);
      if (!current || current.revoked_at !== null) throw new OAuthError("invalid_request");
      if (current.installation_id) {
        const installation = tx
          .query<{ app_user_id: string }>(
            "SELECT app_user_id FROM oauth_installations WHERE id = ? AND revoked_at IS NULL",
          )
          .get(current.installation_id);
        if (!installation) throw new OAuthError("invalid_request");
        tx.run(
          "UPDATE oauth_installations SET revoked_at = ? WHERE id = ?",
          tx.now,
          current.installation_id,
        );
        tx.run(
          "UPDATE oauth_grants SET revoked_at = ? WHERE installation_id = ?",
          tx.now,
          current.installation_id,
        );
        tx.run(
          "UPDATE users SET settings = json_set(settings, '$.active', json('false'), '$.isAssignable', json('false'), '$.isMentionable', json('false'), '$.supportsAgentSessions', json('false')) WHERE id = ?",
          installation.app_user_id,
        );
        tx.appendEvent({
          organizationId: current.organization_id,
          resourceType: "OAuthApp",
          action: "revoked",
          actorId: current.user_id,
          occurredAt: tx.now,
          targetAppUserId: installation.app_user_id,
          oauthClientId: current.client_id,
          data: {},
        });
      } else tx.run("UPDATE oauth_grants SET revoked_at = ? WHERE id = ?", tx.now, current.id);
      return json({});
    });
  }

  const handler: HttpHandler = async (request) => {
    const url = new URL(request.url);
    if (!["/oauth/authorize", "/oauth/token", "/oauth/revoke"].includes(url.pathname)) return null;
    try {
      if (url.pathname === "/oauth/authorize" && request.method === "GET")
        return beginConsent(parameters(url.searchParams));
      if (request.method !== "POST") return json({ error: "invalid_request" }, 405);
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/x-www-form-urlencoded"
      )
        throw new OAuthError("invalid_request");
      const text = await request.text();
      if (text.length > 16_384) throw new OAuthError("invalid_request");
      const form = parameters(new URLSearchParams(text));
      if (url.pathname === "/oauth/authorize") {
        if (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
          throw new OAuthError("access_denied", 403);
        return finishConsent(form);
      }
      return url.pathname === "/oauth/token" ? exchange(request, form) : revoke(request, form);
    } catch (error) {
      if (error instanceof OAuthError) return json({ error: error.code }, error.status);
      if (error instanceof DomainError && error.code === "UNAUTHENTICATED")
        return json({ error: "invalid_grant" }, 400);
      return json({ error: "server_error" }, 500);
    }
  };
  return {
    authenticate,
    handler,
    resetOwner,
    requireInstallation,
    requireAccess: requireIdentityAccess,
  };
}

export type { Principal, ResetOwner, MigrationSet };
