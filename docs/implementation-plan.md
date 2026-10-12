# Finear implementation plan

## Goal and agreed contract

Build a local fake of Linear for integration testing. Existing callers use the official `@linear/sdk` with a configurable GraphQL endpoint, plus local OAuth URLs and webhook receivers.

Confirmed decisions:

- Bun is the runtime, package manager, and test runner.
- Compatibility is with Linear’s wire format, not a new Linear-like interface.
- The initial acceptance target is the official SDK plus direct HTTP and webhook tests.
- Issues, projects, parent/sub-issue epics, agent sessions, webhooks, and OAuth are included.
- An epic is an ordinary Linear issue with child issues through `parentId`; it is not a separate GraphQL type.

The workspace currently contains planning documents. This document is an implementation proposal; no server has been built.

## Recommended stack

Use TypeScript with Bun as the runtime and package manager, `Bun.serve` for HTTP, GraphQL.js for GraphQL execution, `bun:sqlite` for persistence, and `bun:test` for tests. Pin the Bun version and commit `bun.lock` for reproducible local and CI runs. Pin the researched compatibility target to `@linear/sdk@97.1.0` and record the upstream schema revision and package integrity.

SQLite gives local persistence and transactional event delivery without another running dependency. Every test gets its own temporary database. Inject a clock and use seeded fixtures to make expiry, ordering, session timers, and retry tests deterministic.

## Interfaces and module design

The public seam is HTTP:

| Interface | Purpose |
| --- | --- |
| `POST /graphql` | Native Linear queries and mutations, authenticated using raw API keys or Bearer tokens |
| `GET /oauth/authorize` | Authorization-code flow with registered redirect validation, consent, state echo, and user/app actors |
| `POST /oauth/token` | Authorization-code exchange and refresh using form encoding, including PKCE |
| `POST /oauth/revoke` | Token/grant revocation with Linear-compatible request and error behavior |
| `GET /health` | Local readiness |
| `/__test/*` | Fake-specific reset, seeding, clock advancement, agent interactions, and delivery inspection |

Keep the fake-specific control interface separate from Linear-compatible routes. Bind to loopback by default. Require a separate control token for `/__test/*`; bind OAuth codes to registered clients and exact redirect URIs. The control interface must not inherit ordinary API-key permissions.

Use three deep modules:

1. **Workspace:** owns issues, projects, parent/child relationships, supporting entities, session/activity rules, and transactional event creation. GraphQL resolvers translate the wire contract into this module rather than duplicating rules.
2. **Identity:** owns clients, users, app installations, grants, codes, scopes, team access, tokens, and request authentication. It supplies the caller identity consumed by Workspace.
3. **Delivery:** owns webhook subscriptions, serialization, signing, attempt scheduling, and delivery records. It consumes committed outbox events.

Keep persistence and clock seams internal. Reuse the same state transitions for GraphQL requests and synthetic user actions. Do not add a general plugin framework or a second persistence implementation without another caller.

Suggested layout: `src/server.ts`, `src/graphql/`, `src/workspace/`, `src/identity/`, `src/delivery/`, `src/testing/`, `fixtures/`, and `tests/contracts/`.

## Schema and data contract

Run a real GraphQL parser, validator, and executor. Derive the executable API schema from the pinned Linear contract, accounting for the upstream repository’s combined API/webhook schema. Validate the exact generated SDK documents in contract tests; SDK methods select broad fragments even when callers read only a title.

For each delivered operation, implement every field selected by its SDK documents with coherent nullability, scalar serialization, relationships, union types, and mutation payloads. Preserve missing-input versus explicit-null behavior. Use GraphQL errors rather than fabricated successful responses. Keep a machine-readable operation inventory to gate each increment.

Persist:

- Organizations, users, app users/installations, teams, workflow states, project statuses, labels, and comments.
- Projects and team membership; issues with per-team numbers, identifiers, status, project, parent, assignee, delegate, and labels.
- Agent sessions, immutable activities, external links, thread links, and lifecycle timestamps.
- OAuth registrations, grants, hashed token/code material, expiry, refresh rotation state, and permissions.
- Webhook subscriptions, outbox events, and delivery attempts.

Enforce referential integrity and workspace/team permissions. Allocate issue identifiers atomically. Reject parent cycles and invalid cross-workspace references. Expose UUID and supported issue-identifier lookups, archive visibility, typed filters, stable ordering, and Relay connections according to the pinned contract.

## Implementation sequence

Each increment ends with runnable acceptance tests. Keep implementation changes reviewable and below roughly 1,000 changed lines; split an increment when needed.

### 1. Establish the compatibility harness

Bootstrap the application, temporary database setup, health route, fixture loader, and isolated test runner. Pin SDK/schema artifacts and inventory the exact query documents for the following increments. Implement viewer, organization, teams, users, workflow states, and project-status reads with fixture API-key authentication.

Acceptance: the unchanged SDK reaches the local server through `apiUrl`, reads supporting records and relationships, and receives structured errors for invalid credentials and malformed queries.

### 2. Deliver issues and parent/sub-issue epics

Implement issue create/read/list/update/delete/archive/unarchive. Include project-independent issue fields, labels, workflow transitions, human identifiers, parent assignment/removal, children, assignees, and delegates. Add the pagination/filter behavior exercised by these reads. Write outbox events in the same transaction as mutations.

Acceptance: create a parent and two children through the SDK; traverse both directions; update a child; paginate/filter results; archive/unarchive; reject cycles and unauthorized writes; restart and read the same records.

### 3. Deliver projects and issue membership

Implement project create/read/list/update/delete/archive/unarchive, team membership, current project status, and issue membership. Resolve the generated SDK’s nested selections and legacy readable fields from the same underlying state.

Acceptance: create a project with teams, attach and move issues, traverse project issues and issue project, change status, and verify archive visibility and isolation between workspaces.

### 4. Deliver OAuth and app identity

Implement registered clients and callbacks, explicit local consent using fixture users/workspaces, user/app actors, state round-trip, PKCE, one-use expiring codes, form-encoded exchange, scope enforcement, expiry, refresh rotation with the documented recovery window, and revocation. Support documented client authentication forms for these grants. Provision app identities and configured app webhook subscriptions during installation.

Acceptance: an HTTP client follows authorization and callback, exchanges a code, constructs the official SDK with the resulting access token, refreshes it, and observes revocation. Reject redirect mismatches, code replay, bad PKCE, invalid client credentials, expired tokens, missing scopes, and cross-workspace access. Confirm app `viewer` and attribution differ from the human installer.

### 5. Deliver signed webhooks

Implement subscription registration and inspection with the appropriate admin authorization. Deliver issue, project, comment, and app-revocation events with native envelopes and `updatedFrom` values. Sign the exact transmitted bytes using HMAC-SHA256. Add durable delivery attempts, a five-second response deadline, HTTP-200 acknowledgment, and three scheduled retries at the documented backoffs.

Acceptance: a real local HTTP receiver validates captured requests using the official SDK verifier; bad signatures fail; failed receivers trigger retries under virtual time; successful delivery stops retries; committed events survive a restart. Exercise registration scope and team filtering.

Use fresh signed send timestamps for retries and retain separate logical event and attempt IDs. Validate production delivery-header identity and exact backoff interpretation against a first-party fixture before freezing those details as compatibility assertions. Loopback webhook targets are intentional local-fake behavior.

### 6. Deliver agent sessions and activities

Implement session creation on issues/comments, reads, activity connections, activity creation, session updates, plans, and external links. Model thought/action/elicitation/response/error content and GraphQL union members. Enforce owning-app permissions, automatic comment mirroring, and human assignee versus app delegate semantics.

Add control actions that simulate delegation, mention, human prompt, and stop. Route `AgentSessionEvent` created/prompted webhooks only to the owning app. Derive session state from activity and time rather than exposing an invented public status setter. Exercise acknowledgment within ten seconds and thirty-minute inactivity/recovery using the clock.

Before fixing plan and prompted-event fixtures, resolve the documented prose/schema differences with the pinned SDK documents, official examples, and a first-party payload where available. Track the provenance of each fixture and keep proposed fake behavior distinct from observed Linear behavior.

Acceptance: simulate delegation, receive a signed created event, acknowledge with a thought, request input, simulate a human reply, receive prompted, emit a final response, and observe the corresponding session states and thread comments. Separately exercise error, stop, staleness/recovery, invalid activity content, external links, and cross-app denial.

### 7. Package the local workflow

Provide `bun install --frozen-lockfile`, `bun run start`, `bun run reset`, and `bun test`, with fixture selection, database-path configuration, and an SDK/OAuth configuration example. Run a separate TypeScript type check through `bun run typecheck`. Add readiness checks, clean shutdown, deterministic fixtures, and CI using the pinned Bun version to run type checking and the complete contract suite.

Acceptance: from a clean checkout, start Finear and a test receiver, authorize an app, create a project and parent/child issues, run an agent interaction, inspect signed events, reset, and repeat with identical fixture state.

## Verification and completion criteria

- Tests call the real listening HTTP entry point and unchanged pinned SDK; mocks do not replace the compatibility acceptance path.
- Raw GraphQL tests exercise aliases, fragments, variables, operation selection, invalid inputs, scalar formatting, unions, and structured errors.
- OAuth tests exercise redirects and form requests, not only helper functions; callback clients verify returned state.
- A real receiver captures raw webhook bytes and headers, while virtual time advances retries and session/token deadlines without long sleeps.
- Persistence tests cover restart, atomic mutation/outbox writes, concurrent issue numbering, and duplicate delivery handling by the receiver.
- Security tests cover workspace/team isolation, app ownership, scope enforcement, control-interface isolation, redirect validation, and secret redaction.
- Record the operation inventory, schema revision, SDK version, fixture provenance, and actual passing contract tests in the implementation verification report.

Completion means the project/parent-child/agent/OAuth/webhook journey passes end to end, with each delivered operation validated against its generated SDK document. A build alone is not compatibility evidence.

## Source basis

See [Linear compatibility research](linear-compatibility-research.md) for pinned first-party sources and package observations. Key references: [SDK configuration](https://linear.app/developers/sdk), [GraphQL](https://linear.app/developers/graphql), [OAuth](https://linear.app/developers/oauth-2-0-authentication), [agent interactions](https://linear.app/developers/agent-interaction), and [webhooks](https://linear.app/developers/webhooks).
