import { createHash } from "node:crypto";
import {
  buildASTSchema,
  Kind,
  parse,
  print,
  visit,
  validate,
  type DefinitionNode,
  type DocumentNode,
  type GraphQLSchema,
} from "graphql";
import { DomainError } from "../core/errors";

export const contractProvenance = {
  sdkVersion: "97.1.0",
  sdkTarballSha1: "a2ecda50a74cefe5d42d8febe064f0fd408cb0fa",
  sdkIntegrity:
    "sha512-HPk0zY8+SAOEoUEPxZZgqTU7xpNJ5BYcN3grngaWsesecaGMUrn2bzhmWtsQ0jOtTvLImZKHxgiL3hqEjb6oig==",
  upstreamCommit: "6f99687aa115c8d82528231d7ec1ca48124f92a0",
  schemaSha256: "d09d9ddf47cd05f0d9a98c032e65f68abc3fed12d6e1d2228fe8f4dc9290859c",
  documentsSha256: "c6bbde7f879c9d61a4b86c475c19689d10fd22a5bfafb8963265239ae06af506",
} as const;

export const deliveredOperations = [
  "viewer",
  "organization",
  "user",
  "users",
  "team",
  "teams",
  "workflowState",
  "workflowStates",
  "projectStatus",
  "projectStatuses",
  "viewer_teams",
  "user_teams",
  "organization_teams",
  "organization_users",
  "team_members",
  "team_states",
] as const;
export const supportingRoots = [
  "viewer",
  "organization",
  "user",
  "users",
  "team",
  "teams",
  "workflowState",
  "workflowStates",
  "projectStatus",
  "projectStatuses",
] as const;

function pinned(text: string, expected: string) {
  if (createHash("sha256").update(text).digest("hex") !== expected)
    throw new DomainError("CONFLICT", "Pinned contract checksum mismatch");
  return parse(text);
}

export async function loadContract() {
  const source = pinned(
    await Bun.file(new URL("../../contracts/upstream.graphql", import.meta.url)).text(),
    contractProvenance.schemaSha256,
  );
  const documents = pinned(
    await Bun.file(new URL("../../contracts/documents.graphql", import.meta.url)).text(),
    contractProvenance.documentsSha256,
  );
  return { source, documents };
}

export function operationDocument(documents: DocumentNode, name: string): DocumentNode {
  const operation = documents.definitions.find(
    (definition) =>
      definition.kind === Kind.OPERATION_DEFINITION && definition.name?.value === name,
  );
  if (!operation) throw new DomainError("NOT_FOUND", `Operation ${name} not found`);
  const definitions: DefinitionNode[] = [operation];
  const added = new Set<string>();
  for (let index = 0; index < definitions.length; index++) {
    visit(definitions[index]!, {
      FragmentSpread(node) {
        if (added.has(node.name.value)) return;
        added.add(node.name.value);
        const fragment = documents.definitions.find(
          (definition) =>
            definition.kind === Kind.FRAGMENT_DEFINITION &&
            definition.name.value === node.name.value,
        );
        if (!fragment) throw new DomainError("CONFLICT", "Missing contract fragment");
        definitions.push(fragment);
      },
    });
  }
  return { kind: Kind.DOCUMENT, definitions };
}

export function deriveSchema(
  source: DocumentNode,
  roots: readonly string[] = supportingRoots,
): GraphQLSchema {
  const definitions = source.definitions
    .filter((definition) => definition.kind !== Kind.SCHEMA_DEFINITION)
    .map((definition) => {
      if (definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === "Query") {
        return {
          ...definition,
          fields: definition.fields?.filter((field) => roots.includes(field.name.value)),
        };
      }
      return definition;
    });
  const byName = new Map(
    definitions
      .filter((definition) => "name" in definition)
      .map((definition) => [(definition as { name: { value: string } }).name.value, definition]),
  );
  const needed = new Set(["Query"]);
  const selected: DefinitionNode[] = [];
  for (const name of needed) {
    const definition = byName.get(name);
    if (!definition) continue;
    selected.push(definition);
    visit(definition, {
      NamedType(node) {
        needed.add(node.name.value);
      },
    });
    if (definition.kind === Kind.INTERFACE_TYPE_DEFINITION) {
      for (const candidate of definitions) {
        if (
          candidate.kind === Kind.OBJECT_TYPE_DEFINITION &&
          candidate.interfaces?.some((value) => value.name.value === name)
        )
          needed.add(candidate.name.value);
      }
    }
  }
  selected.push(
    ...definitions.filter((definition) => definition.kind === Kind.DIRECTIVE_DEFINITION),
  );
  return buildASTSchema({ kind: Kind.DOCUMENT, definitions: selected });
}

export function operationInventory(schema: GraphQLSchema, documents: DocumentNode) {
  return deliveredOperations.map((name) => {
    const document = operationDocument(documents, name);
    const errors = validate(schema, document);
    if (errors.length)
      throw new DomainError(
        "CONFLICT",
        `Invalid delivered operation ${name}: ${errors.map((error) => error.message).join(", ")}`,
      );
    return { name, sha256: createHash("sha256").update(print(document)).digest("hex") };
  });
}
