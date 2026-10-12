# Testing Finear

Finear's contract suites use the unchanged pinned `@linear/sdk@97.1.0` against real loopback HTTP listeners. GraphQL.js parses, validates and executes the pinned generated operation/fragment closures. OAuth acceptance performs HTTP consent, redirect and form-encoded token exchanges; webhook receivers capture the exact transmitted bytes and verify signatures with the official SDK.

## Run the checks

Use Bun 1.4.2 from the repository's `.bun-version`.

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs formatting, lint, TypeScript and the full Bun suite. The individual commands are:

```sh
bun run format:check
bun run lint
bun run typecheck
bun test
```

Type checking includes application code, tests, fixtures and executable examples. CI installs the frozen lockfile with pinned Bun and runs the same checks.

## Focused integration suites

Each suite below starts its own listeners and creates its own persistence. Run them without starting a separate server:

```sh
bun test tests/integration/agents.test.ts
bun test tests/integration/application.test.ts
bun test tests/integration/cli.test.ts
bun test tests/integration/auth-races.test.ts
```

| Suite | Behavior exercised |
| --- | --- |
| [Agent journey](../tests/integration/agents.test.ts) | OAuth app installation, project and parent/two-child issues, automatic delegation sessions, signed created/prompted events, thought/elicitation/response, threaded comments, restart/reset, ownership and timers |
| [Application integration](../tests/integration/application.test.ts) | Native Issue/Project/Comment webhooks, OAuth app revocation, automatic delivery, chronological retries, receiver SDK callbacks, control isolation and shutdown/reset synchronization |
| [CLI acceptance](../tests/integration/cli.test.ts) | Actual Bun subprocess startup, readiness, SDK writes, authenticated reset command, SIGTERM, database reopen, configuration errors and both runnable examples |
| [Authorization races](../tests/integration/auth-races.test.ts) | Real OAuth revocation/team removal while a chunked GraphQL body is held, revalidation before reads/mutations, unchanged entity/outbox counts on denial and stale-principal comparison controls |

Module-specific suites provide narrower checks:

```sh
bun test tests/base
bun test tests/contracts
bun test tests/graphql
bun test tests/identity
bun test tests/workspace
bun test tests/delivery
bun test tests/agents
```

The supporting contract suite executes exact generated documents over HTTP and hydrates SDK relationships. GraphQL suites check variables, aliases, operation selection, errors, scalars and unions. Workspace tests exercise referential integrity, identifiers, parents, membership, filters and pagination. Identity and agent tests verify live scopes/team access and owning installations. Delivery tests include the real five-second response deadline and retry recovery.

## Fixtures and deterministic state

[Workspace fixtures](../src/workspace/fixtures.ts) define stable IDs for two organizations, fixture humans, public/private teams, workflow states and project statuses. [Fixture settings](../fixtures/settings.ts) provide explicit stored values used by broad SDK fragments.

Raw API keys are public synthetic values:

- Primary: `finear-fixture-primary-key`
- Secondary: `finear-fixture-secondary-key`

[OAuth fixtures](../src/identity/fixtures.ts) define the confidential client and public PKCE client. The default callback is exactly `http://127.0.0.1:5555/callback`. Test-specific registrations can use their own callbacks and webhook receivers. Controls use an independently configured bearer token, never ordinary API-key or OAuth privileges.

Tests inject clock sources where deadline assertions need deterministic time. The persisted nonnegative offset survives reopening. Clock advancement processes retry deadlines chronologically rather than sleeping for minutes or hours. Timestamp ties have deterministic ID ordering; compare ordered content only when the tested contract promises that order. Freshly generated IDs and opaque OAuth credentials remain distinct across runs.

Reset runs transactionally: delivery and agent/entity records clear before the directory, clock and sequences return to their seeded values, and configured clients are restored. A failed reset preserves the previous state. File-backed tests reopen the same run-owned database to prove persistence independently of reseeding.

## Temporary resources

Integration tests bind to loopback, normally with port `0` for an available port. They close the listeners they create and remove their temporary directories. The OAuth callback example uses its registered fixture port `5555` and closes after authorization; its CLI acceptance test exercises that actual callback.

CLI tests spawn the current Bun executable with a fresh temporary `HOME`, matching `KYOTOAGENT_ROOT`, temporary database and available port. They check resolved paths and the child process environment, record the printed listening URL, and send SIGTERM only to the process created by that run. Reopening uses the same temporary database, then cleanup removes it. Tests do not require a Kyoto Agent server.

For a manually isolated full check on Linux, use:

```sh
run_home=$(mktemp -d)
export HOME="$run_home" KYOTOAGENT_ROOT="$run_home/.kyotoagent"
test "$(realpath -m "$HOME")" = "$run_home"
test "$(realpath -m "$KYOTOAGENT_ROOT")" = "$run_home/.kyotoagent"
bun run check
```

If your Bun command is managed through a version-manager shim, select the installed Bun 1.4.2 executable before changing HOME. Keep HOME and KYOTOAGENT_ROOT paired for the entire verification run.

## Manual workflow

The [README](../README.md) contains startup, SDK and interactive OAuth commands. Run the server in one terminal and examples/reset in another:

```sh
CONTROL_TOKEN=local-control-token bun run start
```

```sh
bun examples/sdk.ts
bun examples/oauth-client.ts
CONTROL_TOKEN=local-control-token bun run reset
```

The SDK example creates a project, parent and two children with a comment. The OAuth example verifies callback state, exchanges the code and reads the app viewer without printing token material. For automated signed-event and activity acceptance, use the agent integration suite above.

See [contract provenance](../contracts/provenance.json), [operation inventory](../contracts/operations.json), and the [verification record](implementation-verification.md) for pinned inputs and recorded evidence.
