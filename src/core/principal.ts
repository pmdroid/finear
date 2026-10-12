import { DomainError } from "./errors";

export interface Principal {
  readonly organizationId: string;
  readonly userId: string;
  readonly actor: "apiKey" | "user" | "app";
  readonly oauthClientId: string | null;
  readonly installationId: string | null;
  readonly grantId: string | null;
  readonly scopes: readonly string[];
  readonly teamIds: readonly string[];
  readonly admin: boolean;
}

export interface AppOwner {
  organizationId: string;
  appUserId: string;
  oauthClientId: string;
  installationId: string;
}

export function requireOrganization(principal: Principal, organizationId: string): void {
  if (principal.organizationId !== organizationId)
    throw new DomainError("FORBIDDEN", "Workspace access denied");
}

export function requireTeam(
  principal: Principal,
  team: { id: string; organizationId: string },
): void {
  requireOrganization(principal, team.organizationId);
  if (!principal.teamIds.includes(team.id))
    throw new DomainError("FORBIDDEN", "Team access denied");
}

export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope))
    throw new DomainError("FORBIDDEN", "Required scope is missing");
}

export function requireAdmin(principal: Principal): void {
  if (!principal.admin || (principal.actor !== "apiKey" && !principal.scopes.includes("admin"))) {
    throw new DomainError("FORBIDDEN", "Administrator access required");
  }
}

export function requireOwningApp(principal: Principal, owner: AppOwner): void {
  requireOrganization(principal, owner.organizationId);
  if (
    principal.actor !== "app" ||
    principal.userId !== owner.appUserId ||
    principal.oauthClientId !== owner.oauthClientId ||
    principal.installationId !== owner.installationId
  ) {
    throw new DomainError("FORBIDDEN", "Owning app access required");
  }
}
