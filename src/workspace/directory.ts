import type { Transaction } from "../core/database";
import { userSettings } from "../../fixtures/settings";
import { DomainError } from "../core/errors";

export interface AppUserInput {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  createdAt: number;
}

export function createAppUser(tx: Transaction, input: AppUserInput): string {
  if (
    !tx.query<{ id: string }>("SELECT id FROM organizations WHERE id = ?").get(input.organizationId)
  ) {
    throw new DomainError("NOT_FOUND", "Workspace not found");
  }
  tx.run(
    "INSERT INTO users (id, organization_id, name, email, app, admin, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)",
    input.id,
    input.organizationId,
    input.name,
    input.email,
    input.createdAt,
  );
  tx.run("UPDATE users SET settings = ? WHERE id = ?", JSON.stringify(userSettings), input.id);
  return input.id;
}
