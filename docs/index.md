# Finear documentation

Finear runs a local Linear-compatible HTTP server using Bun, SQLite, GraphQL.js and the pinned official SDK. Start with the [README](../README.md) for installation, configuration, fixture credentials and runnable examples.

## Use and test

- [Testing](testing.md): full and focused commands, end-to-end acceptance, deterministic fixtures/time and run-owned resources.
- [OAuth identity usage](identity-usage.md): registered clients, exact callbacks, consent, PKCE, refresh, revocation, scopes and app webhook provisioning.
- [SDK example](../examples/sdk.ts): create a project and parent/child issues through the unchanged SDK.
- [OAuth callback example](../examples/oauth-client.ts): verify state, exchange a form-encoded code and read the authenticated app viewer.

## Contracts and implementation

- [Shared base contracts](base-contracts.md): canonical source imports, transactions, table ownership, principal/error handling, GraphQL composition and reset protocol.
- [SDK contract handoff](sdk-contract-handoff.md): generated operation names, complete selected projections, scalar semantics and webhook serialization.
- [Pinned provenance](../contracts/provenance.json): SDK integrity, upstream revision and immutable schema/document hashes.
- [Operation-validation inventory](../contracts/operations.json): generated-operation closure hashes.
- [Implementation verification](implementation-verification.md): recorded checks and behavior evidence.

## Design and source research

- [Implementation goal](implementation-goal.md): accepted product outcome and decisions.
- [Implementation plan](implementation-plan.md): approved delivery sequence and acceptance contract.
- [Linear compatibility research](linear-compatibility-research.md): pinned first-party references and package observations supporting the implementation.
