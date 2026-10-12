# SDK contract handoff

Pinned contract: **`@linear/sdk@97.1.0`**, with **`graphql@16.11.0`**. Researched 2026-10-12 from `contracts/upstream.graphql`, `contracts/documents.graphql`, and the installed SDK. Package pins: `package.json:15–17`. Upstream source commit: `6f99687aa115c8d82528231d7ec1ca48124f92a0`; provenance and first-party links: [existing research](linear-compatibility-research.md#sources).

References below use **D** for `contracts/documents.graphql` and **S** for `contracts/upstream.graphql`; numbers are line numbers. Operation names identify generated documents, not necessarily SDK methods or root fields.

## Shared implementation contract

Feature modules own authorization, state changes, relationships, and coherent read projections. GraphQL owns parsing, validation, execution, scalars, and resolver wiring. Establish actor/workspace context, clock, ID allocation, mutation sync sequence, and mutation-event handoff before parallel implementation. Resolve every returned relationship ID within the same authorized workspace.

### Scalars, payloads, and connections

- **JSON is stringified JSON** (S:23098); **JSONObject is embedded JSON** (S:23103). Serialize JSON exactly once; preserve JSONObject as structured values. SDK parses session `context`, `externalUrls`, `plan`, and activity `signalMetadata`/`sourceMetadata` with `JSON.parse` (`node_modules/@linear/sdk/dist/index.mjs:77220–77237`, `76926–76942`). An embedded object in a JSON field silently loses its value through SDK parsing fallbacks.
- DateTime (S:9867) and TimelessDate (S:48530) accept ISO values, shortcuts, and relative durations. Return ISO timestamps and date-only values respectively. Millisecond webhook timestamps are a different wire field. Entity IDs output `ID!`; many lookup and mutation inputs use `String!`. Apply domain UUID/identifier validation separately from GraphQL scalar coercion.
- Preserve omitted input versus explicit null. A nullable input does not establish that every null is a valid domain operation. For example, Issue title is nullable in create/update inputs but non-null on reads.
- Write payload fragments generally select only entity IDs. SDK payload relationship getters then issue another query. Persist first; test `await payload.issue`, `.project`, `.agentSession`, `.agentActivity`, and `.webhook` against the resulting stored entity.
- Payloads require `success: Boolean!` and `lastSyncId: Float!`. IssuePayload (D:10912) selects `issue{id}`; ProjectPayload (D:10449) selects `project{id}`; AgentSessionPayload (D:11320), AgentActivityPayload (D:10739), and WebhookPayload (D:10672) select their corresponding IDs. Session/activity/webhook payload entities are non-null in SDL; issue/project payload entities are nullable, but a successful create/update must identify the persisted entity.
- Issue/project archive and delete return **IssueArchivePayload/ProjectArchivePayload**, selecting `entity{id}, lastSyncId, success` (D:860, 886; S:18309, 34511). Relation/webhook deletion returns **DeletePayload**, including `entityId: String!` (D:1080; S:9914).
- Generated connections select `nodes` and `pageInfo`, not `edges` by default (IssueConnection D:13625; TeamConnection D:14733). SDL also exposes edges. PageInfo requires both Boolean flags; start/end cursors are nullable (D:14044; S:32955). Supply authorized, filtered, archived-aware collections and stable cursors for forward/backward pagination. Empty collections must reflect actual absence.
- `PaginationOrderBy` is `createdAt|updatedAt` (S:32989); issues/projects/users also expose typed sort inputs. Filters use nested comparators and `and`/`or`: IssueFilter S:19252, ProjectFilter S:34928, WorkflowStateFilter S:52564, TeamFilter S:47288, UserFilter S:49646. Implement supplied predicates or return an explicit error, never silently ignore them.
- Root entity lookups are non-null. Missing/forbidden entities produce structured errors with normal GraphQL null propagation, not placeholder objects. Assert raw responses as well as SDK values: SDK normalizes null to undefined and can substitute the current time for missing dates.

## Identity worker

### Operations

| SDK access | Generated operation, D | Root field, S |
| --- | --- | --- |
| `await client.viewer` | `viewer`, 21896 | `Query.viewer: User!`, 41864 |
| `user(id)` / `users(vars)` | `user`, 21250 / `users`, 21852 | `Query.user`, 41783 / `users`, 41814 |
| `await client.organization` | `organization`, 18639 | `Query.organization: Organization!`, 40713 |
| `viewer.teams(vars)` / `user.teams(vars)` | `viewer_teams`, 22051 / `user_teams`, 21418 | `User.teams`, 49414 |
| `organization.teams(vars)` / `.users(vars)` | `organization_teams`, 18745 / `organization_users`, 18809 | Organization relationships |
| `viewer.assignedIssues(vars)` / `.delegatedIssues(vars)` | `viewer_assignedIssues`, 21902 / `viewer_delegatedIssues`, 21964 | `User.assignedIssues`, 49087 / `delegatedIssues`, 49177 |

`viewer` and `organization` are getters, not functions. Team lists require actual access/membership predicates. Human assignee and app delegate are distinct relationships.

### Required selected projections

**User** (fragment D:4706; type S:49067):

- `id, createdAt, updatedAt, name, displayName, email, url, initials, avatarBackgroundColor, inviteHash, createdIssueCount`.
- Booleans: `active, admin, owner, app, guest, isAssignable, isMentionable, isMe, supportsAgentSessions, canAccessAnyPublicTeam`.
- Derive `isMe` per request actor; align app/assignment/mention/session support and privileges with the installation. Nullable profile/status fields represent actual absence. Relationship getters refetch users by ID.

**Organization** (fragment D:5273; type S:31303):

- `id, name, urlKey, createdAt, updatedAt`.
- Counts/numbers: `createdIssueCount, customerCount, userCount, fiscalYearStartMonth, periodUploadVolume, initiativeUpdateRemindersHour, projectUpdateRemindersHour`.
- Embedded objects: `authSettings, customersConfiguration, securitySettings`. Lists: `allowedAuthServices, previousUrlKeys, projectStatuses`; statuses expand the full ProjectStatus fragment supplied by workspace.
- Strings/enums: `pullRequestIssueMode, slackProjectChannelPrefix, initiativeUpdateRemindersDay, projectUpdateRemindersDay, projectUpdatesReminderFrequency, releaseChannel, slaDayCount`.
- Flags: `aiDiscussionSummariesEnabled, aiThreadSummariesEnabled, customersEnabled, feedEnabled, gitLinkbackDescriptionsEnabled, gitLinkbackMessagesEnabled, gitPublicLinkbackMessagesEnabled, hideNonPrimaryOrganizations, hipaaComplianceEnabled, pullRequestTourEnabled, releasesEnabled, roadmapEnabled, samlEnabled, scimEnabled, suggestedBranchNameEnabled`.

Populate explicit fixture settings and calculated counts, not generic type-based defaults.

## Workspace worker

### Teams, workflow states, and project statuses

| SDK access | Generated operation, D | Root field, S |
| --- | --- | --- |
| `team(id)` / `teams(vars)` | `team`, 20647 / `teams`, 21062 | `Query.team`, 41546 / `teams`, 41593 |
| `team.states(vars)` | `team_states`, 20929 | `Team.states`, 46899 |
| `team.issues(vars)` / `.projects(vars)` | `team_issues`, 20719 / `team_projects`, 20857 | Team relationships |
| `team.members(vars)` | `team_members`, 20788 | `Team.members`, 46642 |
| `workflowState(id)` / `workflowStates(vars)` | `workflowState`, 22117 / `workflowStates`, 22160 | Query fields 41906 / 41915 |
| `projectStatus(id)` / `projectStatuses(vars)` | `projectStatus`, 19653 / `projectStatuses`, 19659 | Query fields 40951 / 40964 |

**WorkflowState** required selected fields (D:3826; S:52392): `id, createdAt, updatedAt, name, color, position, type, team{id}`. `type` is **String**, with triage/backlog/unstarted/started/completed/canceled/duplicate values documented in the fragment. States belong to teams.

**ProjectStatus** required selected fields (D:390; S:37347): `id, createdAt, updatedAt, name, color, position, type, indefinite`. `type` is an enum: backlog/canceled/completed/paused/planned/started (S:37598). Statuses belong to the workspace.

**Team** required selected fields (D:4133; S:46284):

- `id, createdAt, updatedAt, name, displayName, key, timezone, visibility, private, inviteHash, issueCount, ledInitiativeCount, securitySettings`.
- Strings: `cycleCalenderUrl` (exact upstream spelling), `issueEstimationType, setIssueSortOrderOnStateChange`.
- Numbers: `autoArchivePeriod, cycleCooldownTime, cycleDuration, cycleStartDay, defaultIssueEstimate, upcomingCycleCount`.
- Flags: `aiDiscussionSummariesEnabled, aiThreadSummariesEnabled, cycleIssueAutoAssignCompleted, cycleIssueAutoAssignStarted, cycleLockToActive, cyclesEnabled, groupIssueHistory, inheritIssueEstimation, inheritWorkflowStatuses, initiativesEnabled, issueEstimationAllowZero, issueEstimationExtended, issueOrderingNoPriorityFirst, issueSortOrderDefaultToBottom, requirePriorityToLeaveTriage, scimManaged, slackIssueComments, slackIssueStatuses, slackNewIssue, triageEnabled, viewerCanJoin`.
- Nullable default/triage/merge/start/review state references, when present, must resolve to appropriate real states. Keep `visibility` (private/public/restricted), `private`, membership, and `viewerCanJoin` coherent.

### Issues and relations

| SDK method | Generated operation, D | Root field, S |
| --- | --- | --- |
| `issue(id)` / `issues(vars)` | `issue`, 17242 / `issues`, 18517 | Query fields 40271 / 40571 |
| `createIssue(input)` | `createIssue`, 24119 | `issueCreate`, 26221 |
| `updateIssue(id,input)` | `updateIssue`, 24525 | `issueUpdate`, 26700 |
| `archiveIssue(id,{trash?})` | `archiveIssue`, 24088 | `issueArchive`, 26186 |
| `deleteIssue(id,{permanentlyDelete?})` | `deleteIssue`, 24128 | `issueDelete`, 26230 |
| `unarchiveIssue(id)` | `unarchiveIssue`, 24490 | `issueUnarchive`, 26661 |
| `issueRelation(id)` / `issueRelations(vars)` | `issueRelation`, 17912 / `issueRelations`, 17922 | Query fields 40423 / 40432 |
| `createIssueRelation(input,{overrideCreatedAt?})` | `createIssueRelation`, 24379 | `issueRelationCreate`, 26539 |
| `updateIssueRelation(id,input)` | `updateIssueRelation`, 24399 | `issueRelationUpdate`, 26561 |
| `deleteIssueRelation(id)` | `deleteIssueRelation`, 24390 | `issueRelationDelete`, 26552 |

Nested operations: `issue_children` D:17295, `issue_relations` D:17586, `issue_inverseRelations` D:17490. SDK methods are `.children(vars)`, `.relations(vars)`, `.inverseRelations(vars)`.

Inputs: IssueCreateInput S:18890 requires teamId; implement explicit title semantics because output title is non-null. IssueUpdateInput S:22652 includes team/state/project/parent/assignee/delegate IDs, replacement labels, and added/removed label IDs. Preserve clearing versus omission. Priority input Int (0–4) becomes Float output; estimate input Int becomes Float output. UUID and human identifier lookup behavior must remain coherent after team moves.

IssueRelationCreateInput S:20927 requires issueId/relatedIssueId/type; create enum values are blocks/duplicate/related/similar (S:20989). Update input type and output type are String (S:20999, 20886). Respect outward/inverse relation orientation. Parent issues and subissues use parentId/children, not IssueRelation or an Epic wire type.

**Issue** required selected fields (D:6315; S:17464):

- `id, createdAt, updatedAt, title, number, identifier, url, branchName, priority, priorityLabel, boardOrder, sortOrder, prioritySortOrder, customerTicketCount, inheritsSharedAccess, labelIds, previousIdentifiers, reactionData, reactions, team{id}, state{id}, sharedAccess`.
- Non-null sharedAccess expands D:7410: `disallowedIssueFields, isShared, sharedWithCount, sharedWithUsers, viewerHasOnlySharedAccess`; users expand full User fragments. Derive these from stored access facts.
- Nullable description, timestamps, parent/project/assignee/delegate/creator represent genuine absence. State/team are non-null. Keep identifier/number/team key, labels, priority label, counts, archive visibility, and completion/cancellation timestamps aligned after mutations.

**IssueRelation** (D:3324; S:20886) requires `id, createdAt, updatedAt, type, issue{id}, relatedIssue{id}`; archivedAt is nullable.

### Projects

| SDK method | Generated operation, D | Root field, S |
| --- | --- | --- |
| `project(id)` / `projects(vars)` | `project`, 18884 / `projects`, 19760 | Query fields 40830 / 41039 |
| `createProject(input,vars?)` | `createProject`, 24807 | `projectCreate`, 27163 |
| `updateProject(id,input)` | `updateProject`, 25016 | Mutation `projectUpdate`, 27439 |
| `deleteProject(id)` | `deleteProject`, 24827 | `projectDelete`, 27201 |
| `archiveProject(id,{trash?})` | `archiveProject`, 24796 | `projectArchive`, 27150 |
| `unarchiveProject(id)` | `unarchiveProject`, 25007 | `projectUnarchive`, 27430 |

`projectArchive` is deprecated in favor of projectDelete. The **query operation** `projectUpdate` D:19685 reads a project status update; it is not mutation operation `updateProject`.

ProjectCreateInput S:34808 requires name and teamIds:[String!]!; validate team membership requirements beyond SDL list coercion. Optional create variables are aiConversationId/projectDraftId/slackChannelName. ProjectUpdateInput S:37906 supports statusId/teamIds/leadId/memberIds/dates/content/description. Set statusId, not a nonexistent state input. Nested operations: `project_issues` D:19158, `project_teams` D:19379, `project_members` D:19222.

**Project** required selected fields (D:2820; S:33744): `id, createdAt, updatedAt, name, description, color, url, slugId, status{id}, state, priority, priorityLabel, prioritySortOrder, sortOrder, progress, scope, resourceCount, frequencyResolution, labelIds, completedIssueCountHistory, completedScopeHistory, inProgressScopeHistory, issueCountHistory, scopeHistory, slackIssueComments, slackIssueStatuses, slackNewIssue`.

Description is non-null short text; content is nullable Markdown. Deprecated readable state is still selected by SDK: derive it coherently from status. Compute counts, progress, and histories from actual project membership and stored history.

## Agent-session worker

Agent sessions are a Workspace-owned submodule implemented after Identity, Workspace, and Delivery are integrated.

### Agent sessions and activities

| SDK method | Generated operation, D | Root field, S |
| --- | --- | --- |
| `agentSessionCreateOnIssue(input)` | same name, 22207 | same name, 23786 |
| `agentSessionCreateOnComment(input)` | same name, 22198 | same name, 23777 |
| `updateAgentSession(id,input)` | `updateAgentSession`, 22216 | `agentSessionUpdate`, 23804 |
| `agentSession(id)` / `agentSessions(vars)` | `agentSession`, 14913 / `agentSessions`, 14955 | Query fields 39119 / 39146 |
| `session.activities(vars)` | `agentSession_activities`, 14922 | `AgentSession.activities`, 733 |
| `createAgentActivity(input)` | `createAgentActivity`, 22189 | `agentActivityCreate`, 23728 |
| `agentActivity(id)` / `agentActivities(vars)` | `agentActivity`, 14904 / `agentActivities`, 14875 | Query.agentActivity / agentActivities, 39077 |

Session create inputs S:983/965 require issueId/commentId; comment creation needs a real workspace thread. Update input S:1197 supports summary/dismissedAt/plan/external URL replacement/addition/removal and has no status setter. Activity filtering uses `filter:{agentSessionId:{eq:...}}` (AgentActivityFilter S:447). For issue-session reads use valid custom GraphQL `Issue.agentSessions` (S:17484), or root session queries; the pinned SDK generates neither an Issue.agentSessions method nor an issue_agentSessions operation.

**AgentSession** required selected fields (D:3693; S:729): `id, createdAt, updatedAt, slugId, appUser{id}, status, context, externalUrls, externalLinks`. Nullable issue/comment/sourceComment/creator/summary/plan/timestamps reflect associations and lifecycle. Status enum S:1110 is active/awaitingInput/complete/error/pending/stale/**stopping**. External links are typed `{label!,url!}` values (D:6046); legacy externalUrls is JSON!. Keep both representations aligned. Plan writes are JSONObject, reads JSON; validate accepted write shape against pinned runtime behavior before selecting array semantics.

**AgentActivity** required selected fields (D:5615; S:200): `id, createdAt, updatedAt, agentSession{id}, user{id}, ephemeral, content`. Input content is JSONObject! (S:318); output content is AgentActivityContent! union (S:307). Resolve concrete __typename. Generated content fragments D:7006–7065 select type and body for prompt/thought/response/elicitation/error; prompt adds title, error adds reasonCode; action selects action/parameter/result (D:7035). SDL body variants additionally require bodyData for direct custom selections.

Enforce content rules: thought/elicitation/response/error require body; action requires action/parameter with optional result; prompt is human-generated; only thought/action can be ephemeral. Derive lifecycle from activity/timing, authorize owning app updates, and store immutable activity history independently of comments. Source-backed lifecycle, acknowledgement, URL, stop, and thread behavior: [existing research](linear-compatibility-research.md#agent-sessions-and-activities).

## Delivery worker

### Webhook registration

| SDK method | Generated operation, D | Root field, S |
| --- | --- | --- |
| `webhook(id)` / `webhooks(vars)` | `webhook`, 22082 / `webhooks`, 22091 | Query fields 41868 / 41877 |
| `createWebhook(input)` | `createWebhook`, 25843 | `webhookCreate`, 28301 |
| `updateWebhook(id,input)` | `updateWebhook`, 25871 | `webhookUpdate`, 28328 |
| `deleteWebhook(id)` | `deleteWebhook`, 25852 | `webhookDelete`, 28310 |

Create input S:51668 requires url/resourceTypes; enabled defaults true when omitted. Optional teamId accepts ID or key; other inputs are allPublicTeams/secret/label/id. Update input S:51812 changes enabled/label/resourceTypes/secret/url, not team scope or allPublicTeams.

**Webhook** required selected fields (D:5188; S:51599): `id, createdAt, updatedAt, resourceTypes, enabled, allPublicTeams`. Nullable url/secret/label/team/creator reads do not remove the need for real URL/signing state in owned registrations. Separate admin registration authorization from automatic OAuth-app provisioning and app ownership. Delivery signing/retry protocol sources: [existing research](linear-compatibility-research.md#webhooks).

## GraphQL worker validation and webhook separation

1. Build pinned SDL with buildASTSchema, then validateSchema. Parse generated documents once and index fragments.
2. For each supported operation, assemble that operation plus only its transitive FragmentSpreads. Validate with standard GraphQL rules, then execute against coherent feature fixtures. Preserve upstream operation text and fragment selections.
3. Treat documents.graphql as an inventory, not one executable document. Whole-inventory validation encounters unrelated AiConversation fragment conflicts in kind enum types, bodyData nullability, and args/entity/type selections. Validate actual operation closures rather than weakening standard validation or rewriting pinned fragments.
4. Capture unchanged SDK request bodies with an in-process fetch adapter or invoke the HTTP handler directly. Assert raw selected fields and hydrated SDK values, write→getter refetch, nested relationships, pagination/filtering, archive/unarchive, denied/missing IDs, union content, and JSON round-trip. Mutation ID success alone does not establish CRUD behavior.
5. Register executable roots explicitly. Root-reachability traversal finds AgentSessionEventWebhookPayload, AgentActivityWebhookPayload, and IssueWebhookPayload unreachable from Query/Mutation/Subscription, while ordinary mutation **WebhookPayload is reachable**. A blanket `*WebhookPayload` removal is incorrect. If deriving a schema subset, preserve selected fragment closure, field types, arguments, and nullability.
6. Keep webhook wire serializers separate from GraphQL read projections. AgentSessionEventWebhookPayload (S:1009; D:8190), AgentActivityWebhookPayload (S:649; D:8229), and AgentSessionWebhookPayload (D:8258) use embedded activity content and child serialization fields. GraphQL activity content is a typed union. Prompt webhook text belongs at content.body, not an invented top-level body.

### Fresh local observations

Read-only Node probes using installed graphql@16.11.0 produced **zero schema validation errors** and **53 passing selected root/nested operation closures** across the assignments above, including agentActivity, issue children/relations, project teams/issues, team states/issues/projects, viewer teams/delegated issues, and session activities. Whole-inventory validation produced the AiConversation conflicts described above. Installed SDK source confirms payload getters refetch entities (`index.mjs:89999`, `77426`, `77073`) and JSON parsing behavior cited above. These observations establish contract validation, not application behavior.
