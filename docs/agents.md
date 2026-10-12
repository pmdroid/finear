# Build an agent with Finear

Use Finear to exercise an agent against the official `@linear/sdk`, OAuth app installation and real signed HTTP webhooks. An agent is a distinct app viewer: a human keeps issue ownership as the assignee while delegating work to the app.

## Run the complete example

From the repository root with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun examples/agent.ts
```

The [runnable example](../examples/agent.ts) starts its own Finear application, SQLite database and webhook receiver on available loopback ports. It registers a local OAuth app and uses `approveFixtureConsent` to automate consent **for the synthetic fixture human in this demo**. It validates the returned OAuth state before exchanging the code. The normal browser consent flow is demonstrated by [oauth-client.ts](../examples/oauth-client.ts) and described in [identity usage](identity-usage.md).

The journey is event-driven:

1. Install the OAuth app and read its distinct viewer through the SDK.
2. Create an issue as the fixture human, retain the human assignee and set `delegateId` to the app viewer ID.
3. Receive the signed `created` session event, post a thought, then ask a question with an elicitation.
4. Simulate the fixture human answering through the separately authenticated prompt control endpoint.
5. Receive the signed `prompted` event and post a response using `agentActivity.content.body`.
6. Read back the completed session, four activities and three threaded comments through the SDK.

The receiver verifies exact raw bytes before parsing JSON. It acknowledges accepted deliveries with HTTP 200 immediately, then runs SDK work on a tracked processing queue. A stable `Linear-Delivery` ID prevents processing retries twice. The example also sends a tampered body and replays a real signed delivery to demonstrate rejection and deduplication. It waits for queued work and closes its own application, receiver and temporary directory before exiting.

It prints a readable journey, the temporary resource locations and a stable JSON result, without tokens or control secrets:

```text
OAuth: approved fixture consent, validated state, installed distinct app viewer
Human: created ENG-1, kept human assignee, delegated to app
Agent: signed created event → thought → elicitation (awaitingInput)
Receiver: rejected tampered bytes, acknowledged duplicate without processing twice
Human: protected fixture prompt → Use main
Agent: signed prompted event → response (complete)
Result: {"status":"complete","issue":"ENG-1","appViewer":true,"humanAssigneePreserved":true,"actions":["created","prompted"],"statuses":["pending","active","awaitingInput","complete"],"activities":4,"comments":3,"webhooks":{"verified":3,"rejected":1,"duplicates":1,"processed":2}}
```

The function `runAgentExample()` is also exported for a caller that wants the verified result object. The [CLI acceptance test](../tests/integration/agent-example.test.ts) spawns the actual example with isolated `HOME`, `KYOTOAGENT_ROOT` and temporary resources, checks its result and verifies that both listeners and its database directory are gone:

```sh
bun test tests/integration/agent-example.test.ts
```

## Register the app and configure endpoints

`createApplication({ clients })` accepts local OAuth registrations. The example generates a client ID, client secret and webhook signing secret per run. A registration has this shape:

```ts
import { createApplication } from "../src/application";
import type { ClientRegistration } from "../src/identity";

const registration: ClientRegistration = {
  id: crypto.randomUUID(),
  name: "Example Agent",
  secret: crypto.randomUUID(),
  redirectUris: ["http://127.0.0.1:5555/callback"],
  scopes: ["read", "write", "app:assignable", "app:mentionable"],
  webhook: {
    url: "http://127.0.0.1:5556/webhook",
    secret: crypto.randomUUID(),
    resourceTypes: ["Project"],
    agentSessionEvents: true,
  },
};

const application = await createApplication({
  databasePath: ":memory:",
  hostname: "127.0.0.1",
  port: 0,
  controlToken: crypto.randomUUID(),
  clients: [registration],
});
```

Select `actor=app` at authorization, request the registered scopes and use an exact registered redirect URI. `read` enables SDK queries, `write` enables activities and mutations, `app:assignable` enables delegation and `app:mentionable` enables mentions. Installation provisions the configured webhook for the app; `agentSessionEvents: true` routes that app's session events. `resourceTypes` selects ordinary entity events; the example registers `Project` and receives the session events from its issue-only journey.

Configure every endpoint explicitly when pointing an agent at a running Finear application:

| Endpoint | Local URL |
| --- | --- |
| SDK GraphQL `apiUrl` | `${origin}/graphql` |
| OAuth authorization | `${origin}/oauth/authorize` |
| OAuth token exchange and refresh | `${origin}/oauth/token` |
| OAuth revocation | `${origin}/oauth/revoke` |
| App webhook receiver | Your registered receiver URL |
| OAuth redirect | Your exact registered callback URL |

For SDK calls after exchanging the authorization code:

```ts
import { LinearClient } from "@linear/sdk";

const agent = new LinearClient({
  apiUrl: new URL("/graphql", origin).href,
  accessToken,
});
const appViewer = await agent.viewer;
```

The SDK `apiUrl` override configures GraphQL, while the OAuth URLs and receiver are configured separately. `bun examples/agent.ts` obtains all URLs from the listeners it creates. The existing [SDK example](../examples/sdk.ts) accepts `FINEAR_URL` and `LINEAR_ACCESS_TOKEN` for a running server, and the browser [OAuth example](../examples/oauth-client.ts) accepts `FINEAR_URL`.

## Keep human and app roles separate

The human SDK client uses the public synthetic primary fixture API key. It creates an issue with `assigneeId` set to the fixture human, then updates `delegateId` to the app viewer ID. Delegation automatically creates a pending session owned by that app installation. The app uses its OAuth bearer access token to read and write the session. Session writes are authorized against the owning active installation.

Activities drive status, rather than assigning status directly:

| Activity | Session status | Comment behavior |
| --- | --- | --- |
| Thought | `active` | Activity only; the example marks it ephemeral |
| Elicitation | `awaitingInput` | Creates the root question comment |
| Human prompt | `pending` until the app responds | Adds a human reply to the thread |
| Response | `complete` | Adds the agent's final reply |

The demo's human answer uses real HTTP `POST /__test/agents/prompt` with `{ "fixture": "primary", "sessionId": "…", "body": "Use main" }`. Its bearer token is the independently configured `controlToken`, not an API key or app OAuth token. See the [agent integration suite](../tests/integration/agents.test.ts) for ownership, stop, mention and timing checks, and [testing](testing.md) for fixture and control details.

## Handle signed session events

The envelope routes events to the installed app using `oauthClientId` and `appUserId`. Both actions carry `agentSession.id`. A created event starts the work:

```json
{
  "type": "AgentSessionEvent",
  "action": "created",
  "oauthClientId": "your-client-id",
  "appUserId": "your-app-viewer-id",
  "agentSession": { "id": "session-id" }
}
```

A prompted event includes the human activity as structured content:

```json
{
  "type": "AgentSessionEvent",
  "action": "prompted",
  "oauthClientId": "your-client-id",
  "appUserId": "your-app-viewer-id",
  "agentSession": { "id": "session-id" },
  "agentActivity": {
    "content": { "type": "prompt", "body": "Use main" }
  }
}
```

Read the human text at `event.agentActivity.content.body`. Verify `Linear-Signature` using `LinearWebhookClient` from `@linear/sdk/webhooks` against the original request bytes, then deduplicate `Linear-Delivery`. The example checks the target app and session in its worker before sending activities. Waiting for SDK work inside the HTTP acknowledgment can hold up delivery; the separate queue lets the receiver acknowledge while the worker calls the real GraphQL endpoint.

For pinned operation and content-union details, see the [SDK contract handoff](sdk-contract-handoff.md#agent-sessions-and-activities).
