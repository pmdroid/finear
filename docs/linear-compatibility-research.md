# Local Linear compatibility research

Researched 2026-10-12 against Linear’s documentation, official SDK repository, and published `@linear/sdk`. Planning evidence only; no server or implementation was created.

## Compatibility anchor

**Proposed design:** use a real GraphQL executor and pin the contract to `@linear/sdk@97.1.0`, the latest published version observed. Maintain a versioned schema/operation inventory and exercise the unchanged SDK against a configurable local endpoint. Resolve what “epic” means before selecting its representation.

**Verified sources:** registry metadata identifies version 97.1.0, the official repository, and tarball SHA-1 `a2ecda50a74cefe5d42d8febe064f0fd408cb0fa`; the downloaded package matched that hash. Repository sources below are pinned to commit `6f99687aa115c8d82528231d7ec1ca48124f92a0`. [1][2]

## GraphQL and SDK contract

- Production uses `POST https://api.linear.app/graphql`; introspection is supported. OAuth sends `Authorization: Bearer <token>`; personal API keys send the key directly. GraphQL can return HTTP 200 with both `data` and structured `errors`. [3]
- The SDK accepts `apiUrl`, defaulting to production. Version 97.1.0 allows HTTP only for `localhost`, `127.0.0.1`, and `[::1]`; other hosts require HTTPS. It requires `apiKey` or `accessToken`, constructs the corresponding header, and sends JSON `{query, variables}`. It does not perform the browser/token OAuth flow for the caller. [4][5]
- Generated methods send fragments and broad model selections, not merely fields subsequently read by the caller. Relationships can trigger additional queries. Exact nullability, IDs, scalars, `__typename`, unions, nested connections, and mutation payloads matter. The SDK throws for responses containing `errors`, even with partial `data`. [5][6]
- **Schema provenance:** repository `schema.graphql`/`schema.json` combine the main API with the separate Linear Webhooks schema. Webhook serialization types in that SDL do not imply callable GraphQL endpoints. [7]
- Lists use Relay-style `first`/`after`, `last`/`before`, `edges {cursor node}`, `nodes`, and `pageInfo {hasNextPage hasPreviousPage startCursor endCursor}`. Default page size is 50; default ordering is `createdAt`, with `updatedAt` available. Archived objects are hidden unless `includeArchived: true`. Filters include typed comparators, relationships, `and`/`or`, null tests, and relative ISO-8601 durations. [3][8][9][10]

**Proposed design:** use genuine GraphQL parsing, validation, and execution rather than matching query strings or operation names; keep webhook serializers separate. Seed workspaces, users/app users, teams, workflow states, and project statuses so relationships and non-null fields are coherent. Preserve omitted-input versus explicit-null semantics and structured errors. Establish runtime validation with contract tests rather than assuming nullable SDL inputs guarantee acceptance.

### Issues, projects, and “epic”

| Concept | Source-backed contract |
| --- | --- |
| Issue | Exactly one team; optional project, parent, assignee, and agent `delegate`. Includes UUID `id`, human `identifier`, `number`, title, Markdown description, timestamps, priority, and non-null workflow `state`. Read through `issue`/`issues`; mutate through create/update/delete/archive/unarchive. Create/update payloads expose `success`, nullable `issue`, and non-null `lastSyncId`. `issue`/`issueUpdate` accept UUID or shorthand such as `ENG-123`. [3][10] |
| Issue inputs | `IssueCreateInput.teamId` is required; `title` is nullable in SDL although non-null on the resulting model. Inputs include `stateId`, `projectId`, `parentId`, `assigneeId`, `delegateId`, labels, and priority 0–4. Updates support label replacement and added/removed IDs. An unspecified initial state uses the first Backlog state, or Triage when enabled. [3][10] |
| Project | Groups issues around an outcome; may span teams. An issue has at most one project. `ProjectCreateInput` requires `name: String!` and `teamIds: [String!]!`; accepts short `description`, Markdown `content`, `statusId`, lead, members, labels, and dates. Reads and create/update/delete/archive/unarchive mutations exist. `status` is the current relationship; legacy readable `state` is deprecated. [10][11] |
| Initiative | Groups projects around strategic objectives and supports parent/sub-initiative relationships. Native API includes reads, create/update/archive/delete, and `initiativeToProjectCreate`/delete for project membership. Status enum: `Proposed`, `Planned`, `Active`, `Completed`, `Canceled`. [10][12] |
| “Epic” | No native `Epic` type or epic query/mutation exists in the inspected SDL. “Epic” occurrences describe Jira integration concepts, including Jira project statuses. Linear’s conceptual model names issues, projects, and initiatives. Parent issues are recommended for work larger than one issue but smaller than a project. [10][13][14] |

**Proposed design:** retain native entities on the wire. Map an epic-sized deliverable containing issues to a **Project**, a strategic grouping containing projects to an **Initiative**, or a smaller hierarchical task to an **Issue with children** via `parentId`. These are not interchangeable. An “epic” product label requires a decision; inventing an `Epic` GraphQL type would not match Linear clients.

## OAuth and identity

The following URLs and request semantics are documented by Linear. [15]

| Step | Wire contract |
| --- | --- |
| Authorize | `GET https://linear.app/oauth/authorize`; required `client_id`, registered `redirect_uri`, `response_type=code`, comma-separated `scope`. `read` is always present. Optional `state` is echoed on callback and should be verified; `prompt=consent` forces consent. Default `actor=user`; `actor=app` installs an app identity. |
| Callback/exchange | Callback receives `code` and supplied `state`. Exchange at `POST https://api.linear.app/oauth/token` using `application/x-www-form-urlencoded`: `grant_type=authorization_code`, `code`, same `redirect_uri`, `client_id`, `client_secret`. |
| PKCE | Authorize adds `code_challenge` and `code_challenge_method=plain` or `S256`; exchange adds `code_verifier`, with optional `client_secret`. |
| Token response | JSON `access_token`, `token_type: Bearer`, `expires_in`, space-separated `scope`, `refresh_token`. Access lifetime is 24 hours; examples use `86399` seconds. Apps created before 2023-12-01 can receive scope arrays. All apps migrated to refresh tokens on 2026-04-01. |
| Refresh | Same token URL/form encoding; `grant_type=refresh_token`, `refresh_token`, plus HTTP Basic credentials (`client_id:client_secret`) or form credentials. For PKCE-issued tokens, `client_id` alone suffices. Success rotates access/refresh tokens. Replaying a consumed refresh request can recover the new refresh token within a 30-minute grace period. |
| Revoke | `POST https://api.linear.app/oauth/revoke`; form `token`, optional `token_type_hint=access_token` or `refresh_token`. Legacy authorization-header or `access_token`/`refresh_token` form revocation is accepted; `token` cannot be combined with legacy fields. Outcomes: 200 revoked, 400 unable to revoke (including already revoked), 401 unable to authenticate. |
| Client credentials | Same token endpoint; enabled apps can use `grant_type=client_credentials`, comma-separated scope, Basic or form credentials. Produces an app token lasting 30 days, without refresh token, initially accessing public teams. Up to 1000 same-scope tokens coexist when all app tokens use this grant; differing scopes revoke existing app tokens. |

- Standard scopes include `read`, `write`, `issues:create`, `comments:create`, `timeSchedule:write`, `admin`. App scopes include `app:assignable`, `app:mentionable`, `initiative:read`/`initiative:write`, and customer scopes. [15][16]
- `actor=app` requires admin installation, produces a distinct app-user `viewer.id` per workspace, attributes changes to that identity, and cannot request `admin`. Team access can change after installation. Agent assignment sets `Issue.delegate`, leaving human `assignee` ownership intact. [16][17]
- Deprecated `actor=application` has different dual-purpose user/app semantics; it is not simply another spelling. `createAsUser`/`displayIconUrl` customize issue/comment attribution under app authorization. [17][18]
- Client-secret rotation invalidates client-credentials tokens, but not workspace access/refresh grants. App revocation emits an `OAuthApp` event with action `revoked`. [15][18]

**Proposed design:** preserve `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/graphql` locally. Model registered clients/callbacks, installation identities, grants, scopes, PKCE, expiry, refresh recovery, revocation, and team permissions separately. Use opaque local tokens and an injectable clock. GraphQL override and OAuth URL override are separate consumer configuration needs: production authorize and API/token endpoints use different hosts.

## Agent sessions and activities

- Mentions/delegation create sessions automatically. Apps can proactively call `agentSessionCreateOnIssue(input: AgentSessionCreateOnIssue!)` or `agentSessionCreateOnComment(input: AgentSessionCreateOnComment!)`. Reads include session queries, issue sessions, and paginated `activities`. [10][16][19]
- Enable **Agent session events** on the OAuth app. `type: AgentSessionEvent` is routed only to that agent; actions are `created` and `prompted`. Envelope fields include `agentSession`, optional `agentActivity`, `appUserId`, `oauthClientId`, `organizationId`, `createdAt`, `webhookId`, and millisecond `webhookTimestamp`. Created events can include `promptContext`, guidance, and previous comments. [10][19]
- **Payload discrepancy:** prose places prompted text at `agentActivity.body`; the published webhook type instead has `agentActivity.content: JSONObject!`. Fixtures should represent prompted text inside `content.body`. Webhook JSON is distinct from GraphQL’s `AgentActivityContent` union. [10][19]
- `agentActivityCreate` accepts session ID, JSON-object `content`, optional UUID, `ephemeral`, `signal`, and `signalMetadata`; returns `success`, `agentActivity`, and `lastSyncId`. Runtime-validated content: thought/elicitation/response/error require `body`; action requires `action` and `parameter`, optionally `result`. `prompt` is human-generated, not agent-emittable. Only thought/action can be ephemeral. GraphQL reads use union member types and `__typename`. [10][19]
- Prose describes six automatic states: `pending`, `active`, `awaitingInput`, `complete`, `error`, `stale`; the pinned schema additionally contains **`stopping`**. An activity or external URL must acknowledge creation within 10 seconds; inactivity becomes stale after 30 minutes and recovers with another activity. `AgentSessionUpdateInput` exposes no public status setter. [10][18][19]
- URL writes use `externalUrls`, `addedExternalUrls`, `removedExternalUrls`; replacement wins. Updates require the owning OAuth app. The pinned read schema favors typed `externalLinks` and deprecates JSON `externalUrls`; prose recommends `externalUrls` for writes. A summary-only update does not acknowledge a session. [10][19]
- Plans are replaced whole. Prose depicts an array of `{content, status}` steps (`pending`, `inProgress`, `completed`, `canceled`); pinned update SDL declares `plan: JSONObject`, while reads use `JSON`. Confirm accepted wire shape before specifying plan validation. [10][19]
- Stop arrives as a human prompt with `signal: stop`; the agent should halt and emit final response/error. Elicitation signals include `auth` and `select`; schema also contains `continue`. Response/elicitation/error can automatically create a thread comment. Activities are frozen snapshots, unlike editable comments. [10][18][20]

**Proposed design:** store session/activity history independently of comments. Derive lifecycle from activities/timers: working activity → active, elicitation → awaiting input, response → complete, error → error; confirm exact reopening/stop transitions. Route events by installation and enforce ownership. Test acknowledgement, staleness/recovery, stop, content validation, unions, external-link migration, and thread mirroring with a controllable clock.

## Webhooks

- Organization-scoped, optionally one team or all public teams; supported data includes issues, comments, projects, initiatives, and related entities. `webhookCreate` accepts URL, `teamId` or `allPublicTeams`, and `resourceTypes`. Querying/creating requires workspace admin or OAuth `admin`. OAuth app registration can configure automatic webhook provisioning at installation, avoiding incompatible `admin` scope on app-actor tokens. [21]
- HTTP POST JSON data-change events use `action: create|update|remove`, `type`, actor, event `createdAt`, serialized `data`, URL, and `updatedFrom` containing previous changed values. Examples include organization/webhook IDs. Session/revocation events have distinct payloads/actions. [21]
- Headers include JSON content type, `Linear-Delivery` (payload UUID v4), `Linear-Event`, `Linear-Signature`, `Linear-Timestamp` (milliseconds), and `User-Agent: Linear-Webhook`. Signature is hex **HMAC-SHA256 over raw transmitted body bytes**, keyed by webhook secret. Signed JSON contains `webhookTimestamp`. [21]
- Published SDK verification requires a finite numeric signed-body timestamp within 60 seconds of its clock. A header timestamp or legacy verifier argument cannot substitute. Byte changes invalidate the signature. [22]
- Only HTTP **200** acknowledges. Unavailability, over 5 seconds to respond, or any non-200 triggers up to **three retries** after backoffs of 1 minute, 1 hour, 6 hours. Repeated failure may disable a webhook. Production registration requires public HTTPS and rejects localhost. [21]

**Proposed design:** use an outbox and scheduled delivery attempts; explicitly allow localhost receivers as local-product behavior. Preserve occurrence time separately from send time; regenerate a signed send timestamp per retry for freshness verification. Record logical event/delivery identities for deduplication. Confirm whether production retains `Linear-Delivery` across retries and exact attempt timing before asserting those as Linear behavior.

## Planning decisions

The user selected a drop-in fake tested with the official SDK plus HTTP/webhook tests, and defined epics as parent issues with sub-issues. The implementation plan recommends explicit fixture-based consent, user/app actor flows, and controllable time. Before freezing compatibility fixtures, confirm lifecycle transitions, prompted payload access, plan input shape, link fields, and retry identity semantics against the pinned contract and first-party examples.

## Evidence obtained

Inspected the official 97.1.0 tarball and pinned SDL/generated documents. A one-shot Node probe imported the **unchanged published SDK**, replacing only `globalThis.fetch` with an in-memory response. `issues({first: 2})` sent a 3,625-character fragment-bearing query to loopback HTTP endpoints with raw-key and Bearer authorization respectively; non-loopback HTTP was rejected. The published webhook verifier accepted fresh signed JSON and rejected missing-body-timestamp and two-minute-old payloads despite a fresh legacy timestamp argument. These are local package observations; OAuth, lifecycle, and retry behavior above are first-party source findings, not live-service test claims. No listener was started.

## Sources

[1]: https://registry.npmjs.org/@linear/sdk/97.1.0 "Published package metadata"
[2]: https://github.com/linear/linear/commit/6f99687aa115c8d82528231d7ec1ca48124f92a0 "Pinned official commit"
[3]: https://linear.app/developers/graphql "GraphQL and authentication"
[4]: https://github.com/linear/linear/blob/6f99687aa115c8d82528231d7ec1ca48124f92a0/packages/sdk/src/client.ts "SDK configuration"
[5]: https://github.com/linear/linear/blob/6f99687aa115c8d82528231d7ec1ca48124f92a0/packages/sdk/src/graphql-client.ts "HTTP transport and errors"
[6]: https://github.com/linear/linear/blob/6f99687aa115c8d82528231d7ec1ca48124f92a0/packages/sdk/src/_generated_documents.graphql "Generated operations"
[7]: https://github.com/linear/linear/blob/6f99687aa115c8d82528231d7ec1ca48124f92a0/packages/sdk/codegen.schema.yml "Combined schema generation"
[8]: https://linear.app/developers/pagination "Pagination"
[9]: https://linear.app/developers/filtering "Filtering"
[10]: https://github.com/linear/linear/blob/6f99687aa115c8d82528231d7ec1ca48124f92a0/packages/sdk/src/schema.graphql "Pinned SDL"
[11]: https://linear.app/docs/projects "Projects"
[12]: https://linear.app/docs/initiatives "Initiatives"
[13]: https://linear.app/docs/conceptual-model "Native concepts"
[14]: https://linear.app/docs/parent-and-sub-issues "Parent issues"
[15]: https://linear.app/developers/oauth-2-0-authentication "OAuth protocol"
[16]: https://linear.app/developers/agents "App identity and scopes"
[17]: https://linear.app/developers/oauth-actor-authorization "Actor authorization"
[18]: https://linear.app/developers/agent-best-practices "Timing and activity behavior"
[19]: https://linear.app/developers/agent-interaction "Sessions and activities"
[20]: https://linear.app/developers/agent-signals "Signals"
[21]: https://linear.app/developers/webhooks "Signing and delivery"
[22]: https://github.com/linear/linear/blob/6f99687aa115c8d82528231d7ec1ca48124f92a0/packages/sdk/src/webhooks/client.ts "Webhook verifier"
