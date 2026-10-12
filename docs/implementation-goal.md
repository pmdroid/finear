# Finear implementation goal

## Authorization

The user asked to implement `docs/implementation-plan.md` using Bun. Local source, tests, fixtures, dependency installation, and verification are authorized. The user explicitly authorized Git initialization and verified bootstrap/base commits to enable isolated worktrees. No push or external publication is authorized.

## Decisions

- Bun runtime, package manager, HTTP server, SQLite, and test runner.
- Linear wire compatibility exercised by unchanged `@linear/sdk@97.1.0` and real HTTP tests.
- Epics use parent issues and sub-issues.
- Issues, projects, OAuth, signed webhooks, and agent sessions are part of the acceptance journey.
- GraphQL.js executes the pinned contract; modules own workspace rules, identity, and delivery.

## Acceptance

Authorize an app, create a project with parent/child issues, delegate to an agent, verify the signed session webhook, exchange activities, complete the session, and verify persisted results. Exercise validation, permissions, refresh/revocation, retry/timing, restart/reset, and clean shutdown through the corresponding entry points.

## Context

- [Implementation plan](implementation-plan.md)
- [Source research](linear-compatibility-research.md)

## Coordination

Bootstrap Bun tooling with oxfmt and oxlint first, then establish shared contracts and a green base before parallel feature work. The bootstrap worker currently owns edits in the shared workspace. Parallel code workers will use isolated Git worktrees after the authorized baseline commit. The parent owns integration review, independent verification, and final closeout. Bootstrap/base commits are authorized; nothing will be pushed.
