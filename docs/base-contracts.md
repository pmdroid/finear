# Shared base contracts

Source exports are canonical. All database timestamps and clock readings use integer epoch milliseconds; GraphQL adapters serialize contract-specific date scalars.

## Runtime and persistence

Import `createRuntime`, `resetRuntime`, `Runtime`, `RuntimeOptions`, and `ResetOwner` from `src/core/runtime.ts`. `createRuntime({ databasePath, clockSource?, migrations? })` opens and migrates one SQLite connection. `Runtime` exposes `database`, `clock`, and idempotent `close()`. Tests supply a temporary database path and a fixed millisecond clock source. The executable uses `DATABASE_PATH`, `HOST`, `PORT`, and `CONTROL_TOKEN`; its default listener is loopback.

Import `Database`, `ReadDatabase`, `Transaction`, `Query<T>`, `SqlValue`, `Migration`, `MigrationSet`, `EventInput`, `OutboxEvent`, `JsonObject`, `JsonValue`, `openDatabase`, and `coreMigrations` from `src/core/database.ts`.

- `database.query<T>(sql).get(...bindings)` returns `T | null`; `.all(...bindings)` returns `T[]`. Outside writes, the read interface accepts SELECT/WITH/EXPLAIN and enables SQLite query-only protection during execution.
- `database.transaction(tx => result, time?)` starts an immediate transaction. `tx.now` captures source plus persisted clock offset once; optionally pass a previously captured time. `tx.syncId` lazily allocates a persisted mutation sequence, once per transaction; return it as `lastSyncId`. Allocation rolls back with failed writes. Reads and migrations that do not request it do not allocate. `tx.query` provides reads and returning queries; `tx.run(sql, ...bindings)` performs a parameterized statement. `tx.appendEvent(event)` returns a generated logical event UUID.
- Write composition passes the same `Transaction` explicitly. Nested transactions fail. Callbacks are synchronous: returning a promise rolls back. Handles and queries retained from a completed transaction reject execution.
- Mutations and `appendEvent` share one commit/rollback. HTTP delivery happens after commit. `EventInput` carries organization, optional team, resource/action, optional actor/source frozen JSON snapshots, occurrence time, JSON data, optional previous values, and optional owning-app/client routing. Outbox `sequence` is the durable consumer ordering key; `id` is the logical event identity.
- `database.migrate(sets)` applies supplied owners in order, atomically per owner. Each owner's versions start at one and are consecutive. Applied SQL is SHA-256 checked on every startup; alter an owner by appending a migration, never editing applied SQL.
- SQLite foreign keys, WAL, and a five-second busy timeout are enabled. Compound references include organization identity where workspace isolation matters. Outbox snapshots retain entity data independently of deletion.

## Ownership and composition

| Owner | Source and tables |
| --- | --- |
| Core | `src/core/database.ts`: `migrations`, `clock`, `sync_sequence`, `outbox`; transaction and migration runner |
| Workspace | `src/workspace/schema.ts`: `organizations`, `users`, `teams`, `team_memberships`, `workflow_states`, `project_statuses`; domain entity tables extend this owner |
| Identity | OAuth registrations, credentials, grants, installations, codes and token tables through its own migration export |
| Delivery | Webhook subscriptions, consumption state, deliveries and attempts through its own migration export |

An owner exports a `MigrationSet` and supplies it through `RuntimeOptions.migrations` in dependency order. Core and Workspace foundational migrations run first. Domain modules own SQL and validation for their tables. Identity creates an acting app user through `createAppUser(tx, input)` from `src/workspace/directory.ts`, passing its grant/install transaction. `AppUserInput` includes id, organizationId, name, email, createdAt; the function returns the user ID. Workspace owns all user records, including app users.

Import `Clock`, `AdjustableClock`, and `createClock` from `src/core/clock.ts`. `now()` adds the persisted offset to the supplied source. `advance(milliseconds)` atomically increments the offset, accepts nonnegative safe integers, and returns the resulting time. Reopen with the same source to retain deterministic time.

## Identity and errors

Import `Principal`, `AppOwner`, `requireOrganization`, `requireTeam`, `requireScope`, `requireAdmin`, and `requireOwningApp` from `src/core/principal.ts`. Identity constructs validated principals; domain modules enforce guards before reads and writes.

`Principal` contains organizationId, acting userId, actor (`apiKey`, `user`, or `app`), nullable oauthClientId, installationId and grantId, explicit scopes, explicit teamIds, and admin. App actors use their app user's ID. Team guards validate both organization and team membership. Scope checks require the exact scope; read and admin do not grant write. Admin operations require admin identity plus OAuth admin scope for OAuth actors. Owning-app checks match organization, actor, app user, OAuth client, and installation together.

Import `DomainError`, `ErrorCode`, and `errorResponse` from `src/core/errors.ts`. Stable codes are UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, INVALID_INPUT, CONFLICT. HTTP mapping uses 401, 403, 404, 400, 409 respectively. Unknown failures produce a redacted 500. Domain errors contain intentionally public messages.

## GraphQL and HTTP

Import `GraphQLContext`, `ResolverMap`, `FieldResolver`, `GraphQLRequest`, `composeResolvers`, `installResolvers`, and `executeGraphQL` from `src/graphql/composition.ts`.

`GraphQLContext` contains the authenticated principal and runtime. Owners export resolver maps indexed by GraphQL object type and field. `composeResolvers(...maps)` rejects duplicate fields. `installResolvers(schema, map, scalars?)` validates registrations and attaches real field/scalar behavior to a GraphQL.js schema. Union/interface resolution uses GraphQL.js and explicit source `__typename` values. `executeGraphQL(schema, { query, variables?, operationName? }, context)` parses, validates and executes GraphQL; domain errors receive stable `extensions.code` and SDK-recognized `extensions.type`, unexpected resolver errors are redacted. Default field resolution requires actual populated source properties; absent selections return explicit errors.

Import `HttpHandler`, `ServerOptions`, and `startServer` from `src/server.ts`. Handlers return Response when they own a route and null otherwise, synchronously or asynchronously. Handlers run in supplied order after GET /health. Health does not require authentication. The composition root installs Identity, GraphQL and test-control handlers with their dependencies.

Import `ControlOptions` and `createControlHandler` from `src/testing/control.ts`. Control routes require `Authorization: Bearer <CONTROL_TOKEN>` and use a separately configured secret. Without configuration they return 404. Ordinary API credentials do not authenticate control access. GET /__test/clock reads virtual time; POST /__test/clock/advance accepts `{ "milliseconds": 1000 }`. Authentication precedes parsing and dispatch. With `reset` configured, POST /__test/reset invokes the composition root's atomic reset hook.

## Pinned supporting contract

Import `contractProvenance`, `deliveredOperations`, `supportingRoots`, `loadContract`, `deriveSchema`, `operationDocument`, and `operationInventory` from `src/graphql/contract.ts`. Vendor artifacts retain immutable hashes in `contracts/provenance.json`; `contracts/operations.json` records exact delivered operation closures and normalized-document SHA-256 values. `loadContract` verifies both upstream artifacts before parsing. `deriveSchema(source, roots?)` preserves callable root selections and their complete named-type closure, including concrete interface members and upstream field arguments/nullability. `operationDocument` assembles an untouched generated operation with its transitive fragments; inventory validation uses standard GraphQL validation.

Import `createGraphQLHandler(runtime)` from `src/graphql/http.ts`. POST /graphql authenticates fixture keys and executes viewer/organization/user(s)/team(s)/workflowState(s)/projectStatus(es), plus organization users/teams, user teams, and team members/states relationships. Invalid JSON, syntax, selection, variables or operation choice return 400; executed domain errors return 200 with structured GraphQL errors; invalid authentication returns 401. Import `supportingResolvers` from `src/workspace/supporting.ts` for owner resolver composition. Directory projections combine stored fixture settings with real identity/membership/counts and relationships. `fixtures/settings.ts` supplies explicit persisted settings for complete SDK fragments. Unsupported fields and predicates produce errors rather than invented defaults.

Import `fixtureApiKeys` and `authenticateFixture(request, runtime)` from `src/identity/fixture.ts`. Fixture keys are public test values selected by primary/secondary fixture names, sent as raw Authorization values. Their principals derive organization/user/team membership from persisted records. The dedicated control secret never authenticates GraphQL.

## Fixtures and reset protocol

Import `fixtureIds`, `fixtureTime`, and `seedWorkspace` from `src/workspace/fixtures.ts`. Two organizations have fixed UUIDs for their human user, public/private teams, workflow states and project statuses. `seedWorkspace(tx)` initializes an empty directory in the caller's transaction; credential fixtures are owned by Identity.

`resetRuntime(runtime, owners)` runs one transaction: owner clear hooks in reverse dependency order, Workspace directory deletion, outbox deletion and sequence reset, clock offset and mutation sync sequence zero, deterministic Workspace seed, then owner seed hooks in dependency order. Each `ResetOwner` provides `clear(tx)` and optional `seed(tx)`. Include every installed table owner and stop delivery/request processing before reset. Reset hooks share the supplied transaction; a failure preserves the previous state. Migrations remain applied. Repeated resets restore identical seeded records.
