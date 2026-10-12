import type { ClientRegistration } from "./index";

export const fixtureOAuthClient = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Fixture Agent",
  secret: "finear-fixture-oauth-secret",
  redirectUris: ["http://127.0.0.1:5555/callback"],
  scopes: [
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
  ],
} as const satisfies ClientRegistration;

export const fixtureOAuthPublicClient = {
  ...fixtureOAuthClient,
  id: "30000000-0000-4000-8000-000000000002",
  name: "Fixture PKCE Client",
  secret: undefined,
} as const satisfies ClientRegistration;

export const fixtureOAuthClients: readonly ClientRegistration[] = [
  fixtureOAuthClient,
  fixtureOAuthPublicClient,
];
