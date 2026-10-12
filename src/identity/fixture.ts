import { createHash, timingSafeEqual } from "node:crypto";
import type { Runtime } from "../core/runtime";
import type { Principal } from "../core/principal";
import { DomainError } from "../core/errors";
import { fixtureIds } from "../workspace/fixtures";

export const fixtureApiKeys = {
  primary: "finear-fixture-primary-key",
  secondary: "finear-fixture-secondary-key",
} as const;

export function authenticateFixture(request: Request, runtime: Runtime): Principal {
  const supplied = createHash("sha256")
    .update(request.headers.get("authorization") ?? "")
    .digest();
  const match = Object.entries(fixtureApiKeys).find(([, key]) =>
    timingSafeEqual(supplied, createHash("sha256").update(key).digest()),
  );
  if (!match) throw new DomainError("UNAUTHENTICATED", "Invalid API key");
  const ids = fixtureIds[match[0] as keyof typeof fixtureIds];
  const user = runtime.database
    .query<{ admin: number }>("SELECT admin FROM users WHERE id = ? AND organization_id = ?")
    .get(ids.user, ids.organization);
  if (!user) throw new DomainError("UNAUTHENTICATED", "Invalid API key");
  const teams = runtime.database
    .query<{ team_id: string }>(
      "SELECT team_id FROM team_memberships WHERE user_id = ? AND organization_id = ?",
    )
    .all(ids.user, ids.organization);
  return {
    organizationId: ids.organization,
    userId: ids.user,
    actor: "apiKey",
    oauthClientId: null,
    installationId: null,
    grantId: null,
    scopes: ["read", "write", "admin"],
    teamIds: teams.map((team) => team.team_id),
    admin: Boolean(user.admin),
  };
}
