# Finear implementation verification

Recorded local verification on 2026-10-12 with Bun 1.4.2 against the integrated feature tree based on bootstrap/base `63f70cec0ce2f1635a4db926d7c086c8ccf59c7c`. At the time of these checks, feature changes were uncommitted and had not been pushed. This is a historical verification record; Git history identifies the subsequently published implementation and documentation.

## Result

The implemented local workflow passes through the real Bun HTTP entry point and unchanged `@linear/sdk@97.1.0`: OAuth installation, projects, parent/sub-issues, delegation, signed agent-session events, agent activities, human prompts, final responses, threaded comments, persistence, and reset.

## Fresh parent checks

Each verification run used a newly created temporary HOME and matching KYOTOAGENT_ROOT, checked by resolved path, with the direct pinned Bun executable directory on PATH.

| Check | Observed result |
| --- | --- |
| `bun install --frozen-lockfile` | Passed |
| `bun run format:check` | Passed |
| `bun run lint` | Passed |
| `bun run typecheck` | Passed, including examples and fixtures |
| `bun test` | 120 passed, 0 failed; 2,140 assertions across 22 files |
| `git diff --check` | Passed |
| Structured autoreview, local changes, default Codex engine | Clean; two complete review chunks, no accepted/actionable findings at P0 reporting threshold |
| Autoreview TruffleHog preflight | Clean on final run |

The full `bun run check` was rerun after the last test-fixture adjustment and passed with the same 120 tests and 2,140 assertions. Review is source evidence; the HTTP/SDK/CLI tests establish behavior independently.

## Behavioral evidence

- `tests/integration/agents.test.ts`: actual application OAuth install, project and parent/two-child creation, SDK delegation, signed created event, thoughts and elicitation, protected human prompt, signed prompted event, final response and ordinary thread comments, restart and reset. Also verifies create-only scopes, eligible grant selection, controls, and timing recovery.
- `tests/integration/application.test.ts`: native Issue/Project/Comment events and actor snapshots, automatic delivery, revocation events, chronological retries, receiver callbacks into the SDK, control isolation, persistence, and reset/shutdown waiting for in-flight work.
- `tests/integration/cli.test.ts`: launches `src/main.ts`, observes its printed listening URL, uses the SDK, exercises `src/reset.ts`, sends SIGTERM to the verified run-created process, reopens its database, and runs both documented examples. OAuth callback example rejects incorrect state before completing consent/exchange.
- `tests/integration/auth-races.test.ts`: real OAuth revocation and membership removal while chunked GraphQL bodies are held. Denied reads/mutations leave records and outbox counts unchanged. Cached-principal baseline controls demonstrate the failure when revalidation is defeated.
- `tests/workspace/access.test.ts`: live transaction authorization, distinct target installation validation, create-only scopes, one transactional delegation callback, rollback, and indistinguishable private/missing lookups.
- `tests/delivery/`: real raw-byte HMAC verification with the official webhook verifier, HTTP-200-only acknowledgment, real five-second timeout, retry recovery, immutable recipients/snapshots, and app/team/workspace routing.
- `tests/agents/`: pinned SDK operations, activity union and JSON round-trips, immutable history, comment mirroring, owning-app checks, 10-second acknowledgment and 30-minute inactivity boundaries, stop/reopening, and rollback/restart/reset.
- `tests/graphql/`: strict scalars, selected operation-fragment validation, root exposure, error location/path preservation, and streamed-body authorization.
- `tests/identity/`: callback binding, PKCE, replay denial, expiry, refresh rotation/recovery, revocation, capability-specific targets, and workspace/team access.

## Failure-to-fix comparisons retained

The streamed-body GraphQL query and mutation regressions failed against the original handler and passed after reauthentication before execution. A separate temporary source snapshot without that second authentication produced four failing real-OAuth race tests; the fixed suite passes.

Create-only delegation and a later eligible target grant failed in application tests before the agent ownership/scope fix. The same integration cases now pass without manufacturing a higher-privilege principal.

An initial final-review secret scan flagged a synthetic username/password loopback URL in a negative reset-configuration test. The fixture now uses a username-only invalid origin and still tests rejection without echoing credentials. The final secret scan and structured review passed; no scanner suppression was added.

## Contract provenance

`contracts/provenance.json` records SDK 97.1.0, upstream revision, package integrity, and immutable schema/document hashes. `contracts/operations.json` records selected generated-operation closure hashes; `src/application.ts` composes the actual delivered operation lists. Tests validate unchanged selected fragments and full SDK hydration/refetch behavior.

## Run

```sh
bun install --frozen-lockfile
CONTROL_TOKEN=local-control-token bun run start
bun examples/sdk.ts
CONTROL_TOKEN=local-control-token bun run reset
bun run check
```

Default GraphQL endpoint: `http://127.0.0.1:4444/graphql`. Public synthetic primary fixture API key: `finear-fixture-primary-key`. See `README.md` for OAuth endpoints, callback example, configuration, and protected agent controls.
