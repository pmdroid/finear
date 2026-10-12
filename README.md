# Finear

Finear is a local Linear-compatible server for integration tests. It runs on Bun with SQLite persistence, real GraphQL execution, the unchanged `@linear/sdk@97.1.0`, local OAuth consent, and signed durable webhooks.

## Features

- Issues, projects, parent/sub-issues, labels and threaded comments with workspace/team access checks.
- Official SDK queries and mutations executed by GraphQL.js against the pinned Linear contract.
- OAuth user/app consent, PKCE, refresh rotation, revocation and distinct app identities.
- Durable signed webhooks, automatic delivery, retry inspection and controllable time.
- Agent delegation, mentions, sessions, typed activities, human prompts and comment mirroring.
- SQLite persistence, deterministic fixtures, authenticated reset and real HTTP/CLI contract tests.

## Start

Use **Bun 1.4.2**, pinned in `.bun-version` and CI.

```sh
bun install --frozen-lockfile
CONTROL_TOKEN=local-control-token bun run start
```

The server prints its listening URL. By default it binds to `http://127.0.0.1:4444` and stores data in `finear.sqlite`. Check readiness with:

```sh
curl http://127.0.0.1:4444/health
```

Stop with Ctrl-C or SIGTERM. Shutdown waits for application requests and delivery before closing SQLite. Restarting with the same database retains records, OAuth grants and webhook delivery state.

| Variable        | Purpose                                       | Default                       |
| --------------- | --------------------------------------------- | ----------------------------- |
| `HOST`          | Listening hostname                            | `127.0.0.1`                   |
| `PORT`          | Listening port; `0` selects an available port | `4444`                        |
| `DATABASE_PATH` | SQLite file path                              | `finear.sqlite`               |
| `CONTROL_TOKEN` | Separate local test-control secret            | Controls disabled when absent |
| `FINEAR_URL`    | Server origin for reset and examples          | `http://127.0.0.1:4444`       |

Use a separate database for each test run. Keep the loopback binding and choose a control token for your local test environment. Fixture credentials below are public synthetic values, not production credentials.

## SDK and fixtures

The primary fixture contains workspace `eng`, human `Human 1`, public team `ENG`, and supporting workflow/project statuses. A second workspace and private teams provide isolation checks. API-key authentication sends the raw key; OAuth sends a Bearer token.

| Fixture             | API key                        |
| ------------------- | ------------------------------ |
| Primary workspace   | `finear-fixture-primary-key`   |
| Secondary workspace | `finear-fixture-secondary-key` |

Override the SDK's GraphQL URL explicitly:

```ts
import { LinearClient } from "@linear/sdk";

const client = new LinearClient({
  apiUrl: "http://127.0.0.1:4444/graphql",
  apiKey: "finear-fixture-primary-key",
});
const viewer = await client.viewer;
const teams = await client.teams();
console.log(
  viewer.name,
  teams.nodes.map((team) => team.key),
);
```

Run the complete SDK example to create a project, a parent issue, two children and a comment:

```sh
bun examples/sdk.ts
```

The example accepts `FINEAR_URL`, `LINEAR_API_KEY`, or `LINEAR_ACCESS_TOKEN`. Projects span teams; parent/sub-issues are ordinary Linear issues with `parentId`. Reads, mutations and relationships go through the real GraphQL endpoint.

## OAuth

OAuth URLs must be configured separately from the SDK's `apiUrl`:

- Authorization: `http://127.0.0.1:4444/oauth/authorize`
- Token exchange/refresh: `http://127.0.0.1:4444/oauth/token`
- Revocation: `http://127.0.0.1:4444/oauth/revoke`

The confidential fixture client is `30000000-0000-4000-8000-000000000001`, secret `finear-fixture-oauth-secret`, registered callback exactly `http://127.0.0.1:5555/callback`. The public PKCE fixture ends in `0002`. Local consent explicitly selects the human/workspace and accessible teams. `actor=app` creates a distinct app viewer; `actor=user` acts as the fixture human.

Start Finear in one terminal and leave it running:

```sh
bun run start
```

Wait for `Finear listening at http://127.0.0.1:4444/`, then run the callback example in a separate terminal with port 5555 available:

```sh
bun run examples/oauth-client.ts
```

For a server on another port, set `FINEAR_URL` to its HTTP or HTTPS origin, without credentials, a path, query or fragment. The example checks `/health` with a three-second deadline before opening the callback or printing an authorization URL. If Finear is unavailable, start it and run the example again.

When the example says it is waiting, manually open its printed URL in a browser and approve the fixture workspace consent. It verifies returned state before consuming the code, exchanges form-encoded credentials at the local token URL, and calls SDK viewer using the issued access token. It prints the viewer, not token material, then closes the callback. The callback also closes after five minutes.

## Webhooks and control

SDK webhook registration requires an administrator identity. Issue, Project and Comment mutations create durable outbox records; an automatic scheduler sends signed native event bodies to configured receivers. The receiver must return HTTP 200. Verify exact raw body bytes with `LinearWebhookClient` from `@linear/sdk/webhooks`. Delivery uses a five-second deadline and retry delays of one minute, one hour and six hours. App webhook configuration can be passed through `createApplication({ clients })` for automatic provisioning during OAuth app installation; app revocation emits a routed signed OAuthApp event.

Test controls require `Authorization: Bearer <CONTROL_TOKEN>` independently of API keys and OAuth permissions:

| Route                                 | Action                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /__test/clock`                   | Read current virtual time                                                           |
| `POST /__test/clock/advance`          | Advance by JSON `{ "milliseconds": 60000 }`, processing due retries chronologically |
| `GET /__test/deliveries`              | Inspect durable deliveries                                                          |
| `GET /__test/attempts?deliveryId=...` | Inspect attempts, optionally for one delivery                                       |
| `POST /__test/drain`                  | Process currently due deliveries                                                    |
| `POST /__test/reset`                  | Restore deterministic fixtures atomically                                           |

Reset a running server using the same control token configured at startup:

```sh
CONTROL_TOKEN=local-control-token bun run reset
```

For another port, set `FINEAR_URL=http://127.0.0.1:PORT`. Reset waits for in-flight delivery, clears application entities and credentials/delivery history, resets virtual time and sequences, and reseeds the fixture directory and configured OAuth clients. Existing OAuth tokens become invalid. The reset command calls the authenticated live control endpoint; it does not delete database files.

## Agent sessions

Run a complete event-driven agent example with its own temporary Finear server and signed webhook receiver:

```sh
bun examples/agent.ts
```

No separate server is needed for this demo. It installs a fixture OAuth app, delegates an issue, exchanges activities and a human prompt, verifies signatures and duplicate deliveries, and cleans up its listeners and database. See the [agent guide](docs/agents.md) for the code walkthrough and configuration.

OAuth clients configured with `webhook.agentSessionEvents: true` receive signed session-created and prompted events only for their owning app. Include `app:assignable` and `app:mentionable` in installation scopes for delegation and mentions. Human SDK issue updates set `delegateId` to the app viewer ID while preserving the human assignee; delegation atomically creates a pending session. Repeating the delegate or editing the issue title does not duplicate that session.

Agents use SDK session/activity operations to acknowledge with a thought or external link, emit actions, request input with elicitation, and finish with response/error. Elicitation/response/error mirror into ordinary threaded comments. Session activity reads use native content unions. A session becomes stale after ten seconds without acknowledgment or thirty minutes without activity; a new activity recovers it. Stop produces a human prompt carrying the stop signal and the stopping state until the agent finishes.

Protected human simulation routes accept JSON and the separate control bearer token. `fixture` selects `primary` or `secondary` and defaults to `primary`; it resolves an actual fixture human and preserves workspace/team checks.

| Route                          | JSON fields                                             |
| ------------------------------ | ------------------------------------------------------- |
| `POST /__test/agents/delegate` | `issueId`, `appUserId`, optional `fixture`              |
| `POST /__test/agents/mention`  | `issueId`, `appUserId`, optional `commentId`, `fixture` |
| `POST /__test/agents/prompt`   | `sessionId`, `body`, optional `fixture`                 |
| `POST /__test/agents/stop`     | `sessionId`, optional `body`, `fixture`                 |

Session updates accept external URL lists of `{ label, url }`. The local pinned plan fixture is an ordered array of `{ content, status }` steps with status `pending`, `inProgress`, `completed`, or `canceled`; updates replace the entire plan. Plan reads use the contract JSON scalar. A summary-only update does not acknowledge a pending session. Session writes require the owning active OAuth app installation.

## End-to-end workflow

With Finear running in one terminal, create the SDK project/parent-child fixture, run the interactive OAuth callback example, then reset the same server:

```sh
bun examples/sdk.ts
bun examples/oauth-client.ts
CONTROL_TOKEN=local-control-token bun run reset
```

For the automated OAuth → project/parent-child issues → delegation → signed webhook → activities/prompt/completion → restart/reset journey, run:

```sh
bun test tests/integration/agents.test.ts
```

The suite creates its own temporary database and loopback listeners; no separately running Finear instance is needed. See [testing](docs/testing.md) for focused commands and resource isolation.

## Checks and contracts

```sh
bun run check
```

This runs formatting, lint, TypeScript checking and Bun tests. Individual gates are `bun run format:check`, `bun run lint`, `bun run typecheck`, and `bun test`; `bun run format` formats handwritten files. Tests use temporary databases and real loopback HTTP receivers/SDK clients. CI installs from the frozen lockfile and runs the same gates with pinned Bun.

## Documentation

Pinned schema/document hashes, package integrity and upstream revision are in [contract provenance](contracts/provenance.json); the exact operation-validation inventory is in [operations](contracts/operations.json). Operation closures validate against the pinned Linear schema.

Start with the [documentation index](docs/index.md), then choose:

- [Testing and end-to-end acceptance](docs/testing.md): focused suites, fixtures, deterministic time and temporary resources.
- [OAuth identity usage](docs/identity-usage.md): client registration, consent, PKCE, refresh, revocation and app installation.
- [Shared module contracts](docs/base-contracts.md): database transactions, ownership, principal guards and composition.
- [SDK contract handoff](docs/sdk-contract-handoff.md): generated operations, projections and scalar/wire details.
- [Compatibility research](docs/linear-compatibility-research.md): pinned first-party sources and SDK observations.
- [Implementation verification](docs/implementation-verification.md): recorded behavior and verification evidence.
