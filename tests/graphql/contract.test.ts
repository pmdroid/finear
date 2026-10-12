import { expect, test } from "bun:test";
import { Kind, print, validate, validateSchema } from "graphql";
import {
  deliveredOperations,
  deriveSchema,
  featureOperations,
  featureRoots,
  loadContract,
  operationDocument,
  operationInventory,
  supportingRoots,
} from "../../src/graphql/contract";

test("selected feature inventories validate original generated documents and exact fragments", async () => {
  const { source, documents } = await loadContract();
  const inventory = (await Bun.file(
    new URL("../../contracts/operations.json", import.meta.url),
  ).json()) as { name: string; sha256: string }[];
  for (const feature of Object.keys(featureOperations) as (keyof typeof featureOperations)[]) {
    const schema = deriveSchema(source, featureRoots[feature]);
    expect(validateSchema(schema)).toEqual([]);
    const selected = operationInventory(schema, documents, featureOperations[feature]);
    expect(selected).toEqual(
      inventory.filter((item) => featureOperations[feature].some((name) => name === item.name)),
    );
    for (const name of featureOperations[feature]) {
      const closure = operationDocument(documents, name);
      expect(validate(schema, closure)).toEqual([]);
      expect(closure.definitions[0]?.kind).toBe(Kind.OPERATION_DEFINITION);
      for (const definition of closure.definitions)
        expect(documents.definitions.includes(definition)).toBe(true);
      expect(print(closure)).toContain(name);
    }
  }
  expect(operationInventory(deriveSchema(source), documents)).toEqual(
    inventory.filter((item) => deliveredOperations.some((name) => name === item.name)),
  );
});

test("schema root selection retains original named closure without unrelated callable roots", async () => {
  const { source, documents } = await loadContract();
  const schema = deriveSchema(source, { query: ["agentActivity"], mutation: ["webhookCreate"] });
  expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(["agentActivity"]);
  expect(Object.keys(schema.getMutationType()!.getFields())).toEqual(["webhookCreate"]);
  expect(schema.getType("AgentActivityContent")).toBeDefined();
  expect(schema.getType("AgentActivityThoughtContent")).toBeDefined();
  expect(schema.getType("WebhookPayload")).toBeDefined();
  expect(schema.getType("AgentSessionEventWebhookPayload")).toBeUndefined();
  expect(validateSchema(schema)).toEqual([]);
  expect(operationInventory(schema, documents, ["agentActivity", "createWebhook"])).toHaveLength(2);
  expect(() => operationInventory(schema, documents, ["createIssue"])).toThrow(
    "Invalid delivered operation",
  );
  expect(() => operationInventory(schema, documents, ["agentActivity", "agentActivity"])).toThrow(
    "Duplicate",
  );
  expect(() => deriveSchema(source, { query: ["missing"] })).toThrow("Unknown root");
  expect(deriveSchema(source, supportingRoots).getMutationType()).toBeUndefined();
});
