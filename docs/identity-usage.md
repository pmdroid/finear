# Local OAuth identity

Create the runtime with `migrations: [identityMigrations]`, then call `createIdentity(runtime, options)` from `src/identity/index.ts`. Register `identity.handler` before the GraphQL handler and include `identity.resetOwner` in `resetRuntime(runtime, owners)` in dependency order before Delivery. `createIdentity` seeds missing configured clients without changing existing registrations. Reset clears credentials, installations, consents and grants, then restores configured registrations.

## Registered clients

`fixtureOAuthClient`, `fixtureOAuthPublicClient`, and `fixtureOAuthClients` expose deterministic synthetic registrations. The confidential fixture ID is `30000000-0000-4000-8000-000000000001`, its secret is `finear-fixture-oauth-secret`, and its exact registered callback is `http://127.0.0.1:5555/callback`. The public PKCE fixture ends in `0002` and has no secret. These are public local testing values.

Pass `options.clients` to register application-specific callbacks, allowed scopes, and optional `{ url, secret, resourceTypes }` webhook configuration. `registerClient(tx, registration)` also composes with a caller transaction. Callback matching is exact, including query strings, trailing slashes and ports.

## Run the callback example

After installing dependencies with `bun install --frozen-lockfile`, start `bun run start` in one terminal and leave it running. Wait for its listening URL (by default `http://127.0.0.1:4444/`). In a separate terminal, run:

```sh
bun run examples/oauth-client.ts
```

Keep port 5555 available for the registered loopback callback. For another server port, set `FINEAR_URL` to the server's HTTP or HTTPS origin without credentials, a path, query or fragment. The example first checks `/health` with a three-second deadline. If the server is unavailable, it exits before opening the callback; start Finear and run the example again.

The example waits for you to open its printed authorization URL in a browser and approve consent. After approval it exchanges the code, prints the SDK app viewer without tokens, and closes the callback. Finish consent within five minutes.

## HTTP flow

Visit `/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, comma-separated `scope`, optional `actor=user|app`, `state`, `code_challenge`, and `code_challenge_method=plain|S256`. `read` is included automatically. The local HTML consent form explicitly selects a fixture human/workspace and team checkboxes. Submit its opaque `consent`, `decision=allow|deny`, `user_id`, `workspace_id`, and repeated `team_id` values to `POST /oauth/authorize` as form data. Approval redirects to the registered callback with `code` and the original `state`; denial returns `error=access_denied` and state. Verify state in the callback client.

Exchange the code through form-encoded `POST /oauth/token` with `grant_type=authorization_code`, `code`, the exact `redirect_uri`, and client credentials. HTTP Basic and form credentials are supported. PKCE exchange additionally supplies `code_verifier` and may omit the secret. Public registrations require PKCE. Codes and pending consent expire after ten minutes and are consumed once.

Send the returned access token as `Authorization: Bearer <access_token>`. `identity.authenticate(request)` returns a `Principal` and also accepts existing raw fixture API keys. App actors have a distinct Workspace app user and installation; user actors retain the selected human. App installation requires a human administrator and rejects `admin` scope. Team access intersects the grant's approved teams with live memberships.

Access tokens last 24 hours. Refresh with form-encoded `grant_type=refresh_token`, `refresh_token`, and Basic/form client credentials; PKCE grants permit `client_id` alone. Refresh rotates both tokens and invalidates the prior access token. Retrying the consumed refresh token within thirty minutes returns the same successor credentials while that successor remains current. Recovery derives the successor from the caller's old refresh token and a stored random salt, so no recoverable plaintext token is stored. Refresh tokens expire after ninety days. `oauthLifetimes` exposes all millisecond deadlines for virtual-clock tests.

Revoke through form-encoded `POST /oauth/revoke` using `token` and optional `token_type_hint`. Legacy Bearer authorization or a single `access_token`/`refresh_token` form field is also accepted. An app revocation invalidates every grant on that installation and atomically emits one routed `OAuthApp`/`revoked` outbox event. Repeat revocation returns 400; unknown credentials return 401.

## Domain and Delivery composition

`requireInstallation(dbOrTx, principal)` returns the active `{ organizationId, appUserId, oauthClientId, installationId, installerId }` only after validating owning-app identity and its active grant. It is also available on the Identity instance. Use `identity.requireAccess(tx, principal, { organizationId, teamId?, scope? })` or `requireIdentityAccess` to revalidate grant, workspace, exact scope and live team membership inside a write transaction. `Principal`, `ResetOwner`, `IdentityOptions`, `ClientRegistration`, `Installation`, `InstallationProvisioningInput`, and `IdentityAccess` are exported types.

For webhook-enabled clients, inject Delivery's synchronous `provisionAppWebhook(tx, input): string` function through `IdentityOptions.provisionAppWebhook`. Identity calls it after app-user/installation creation and before the grant/code commit, once per active installation. `InstallationProvisioningInput` is `{ organizationId, oauthClientId, appUserId, url, secret, resourceTypes: readonly string[], agentSessionEvents: boolean }`. Configure `webhook.agentSessionEvents` on the client to enable agent events; it defaults to false. Delivery writes subscriptions using that same transaction; a failure rolls back the app user, installation, consent consumption and subscription writes together. App revocation emits `resourceType: "OAuthApp"`, `action: "revoked"`, `data: {}`, `targetAppUserId`, and `oauthClientId` so Delivery can snapshot the recipient before disabling its subscription.

Compose `identityResolvers()` with Workspace's supporting resolver map to project persisted app assignment/mention/session capabilities into SDK User fields. The map supplies only these User capability fields and requires the request's read scope.

Construct the official SDK with `new LinearClient({ apiUrl: localGraphQLUrl, accessToken })`; configure local authorization/token URLs separately in the application performing OAuth.
