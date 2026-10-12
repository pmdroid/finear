import type { JsonObject, Transaction } from "../core/database";
import type { AppOwner, Principal } from "../core/principal";

export interface WorkspaceAccess {
  organizationId: string;
  teamId?: string;
  scope?: string;
}
export interface WorkspaceDelegate {
  organizationId: string;
  teamId: string;
  appUserId: string;
}
export type OnDelegated = (
  tx: Transaction,
  principal: Principal,
  issue: Entity,
  previousDelegateId: string | null,
  owner?: AppOwner,
) => void;
export interface WorkspaceOptions {
  requireAccess?: (tx: Transaction, principal: Principal, access: WorkspaceAccess) => void;
  requireDelegate?: (tx: Transaction, delegate: WorkspaceDelegate) => AppOwner;
  onDelegated?: OnDelegated;
}

export type Entity = Record<string, unknown> & { id: string };
export type EntityRow = {
  id: string;
  organization_id: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  creator_id: string;
  data: string;
};
export type IssueRow = EntityRow & {
  team_id: string;
  number: number;
  identifier: string;
  title: string;
  state_id: string;
  project_id: string | null;
  parent_id: string | null;
  assignee_id: string | null;
  delegate_id: string | null;
};
export type ProjectRow = EntityRow & {
  name: string;
  status_id: string;
  lead_id: string | null;
};
export type CommentRow = EntityRow & {
  issue_id: string;
  parent_id: string | null;
  user_id: string;
  body: string;
};
export type IssueInput = {
  id?: string;
  teamId?: string;
  title?: string | null;
  description?: string | null;
  stateId?: string;
  projectId?: string | null;
  parentId?: string | null;
  assigneeId?: string | null;
  delegateId?: string | null;
  labelIds?: string[];
  addedLabelIds?: string[];
  removedLabelIds?: string[];
  priority?: number;
  estimate?: number | null;
  dueDate?: string | null;
  boardOrder?: number;
  sortOrder?: number;
  prioritySortOrder?: number;
  subIssueSortOrder?: number | null;
};
export type ProjectInput = {
  id?: string;
  name?: string;
  teamIds?: string[];
  statusId?: string;
  leadId?: string | null;
  memberIds?: string[];
  description?: string;
  content?: string | null;
  color?: string;
  icon?: string | null;
  priority?: number;
  sortOrder?: number;
  prioritySortOrder?: number;
  startDate?: string | null;
  targetDate?: string | null;
};
export type CommentInput = {
  id?: string;
  issueId: string;
  parentId?: string | null;
  body: string;
};
export type LabelInput = {
  id?: string;
  name: string;
  color?: string;
  teamId?: string | null;
  description?: string | null;
};
export type ListArgs = {
  first?: number | null;
  last?: number | null;
  after?: string | null;
  before?: string | null;
  includeArchived?: boolean | null;
  orderBy?: string | null;
  sort?: unknown;
  filter?: unknown;
};
export type MutationResult<T extends Entity> = {
  success: true;
  lastSyncId: number;
  entity: T;
};
export type Snapshot = JsonObject;
