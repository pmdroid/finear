import {
  defaultFieldResolver,
  GraphQLError,
  graphql,
  isObjectType,
  isScalarType,
  type GraphQLFieldResolver,
  type GraphQLScalarType,
  type GraphQLSchema,
  type ExecutionResult,
} from "graphql";
import type { Principal } from "../core/principal";
import type { Runtime } from "../core/runtime";
import { DomainError } from "../core/errors";

export interface GraphQLContext {
  principal: Principal;
  runtime: Runtime;
}

export type FieldResolver = GraphQLFieldResolver<unknown, GraphQLContext, Record<string, unknown>>;
export type ResolverMap = Readonly<Record<string, Readonly<Record<string, FieldResolver>>>>;

export function composeResolvers(...maps: readonly ResolverMap[]): ResolverMap {
  const result: Record<string, Record<string, FieldResolver>> = Object.create(null);
  for (const map of maps) {
    for (const [type, fields] of Object.entries(map)) {
      result[type] ??= Object.create(null);
      for (const [field, resolver] of Object.entries(fields)) {
        if (Object.hasOwn(result[type]!, field))
          throw new DomainError("CONFLICT", `Duplicate resolver ${type}.${field}`);
        result[type]![field] = resolver;
      }
    }
  }
  return result;
}

export function installResolvers(
  schema: GraphQLSchema,
  resolvers: ResolverMap,
  scalars: readonly GraphQLScalarType[] = [],
): GraphQLSchema {
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (!isObjectType(type))
      throw new DomainError("INVALID_INPUT", `Unknown object type ${typeName}`);
    for (const [fieldName, resolver] of Object.entries(fields)) {
      const field = type.getFields()[fieldName];
      if (!field) throw new DomainError("INVALID_INPUT", `Unknown field ${typeName}.${fieldName}`);
      if (field.resolve)
        throw new DomainError(
          "CONFLICT",
          `Resolver already installed for ${typeName}.${fieldName}`,
        );
      field.resolve = resolver;
    }
  }
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (!isObjectType(type) || name.startsWith("__")) continue;
    for (const field of Object.values(type.getFields())) {
      field.resolve ??= (source, args, context, info) => {
        if (
          !source ||
          (typeof source !== "object" && typeof source !== "function") ||
          !Object.hasOwn(source, info.fieldName)
        ) {
          throw new DomainError("INVALID_INPUT", `Field ${name}.${info.fieldName} has no resolver`);
        }
        return defaultFieldResolver(source, args, context, info);
      };
    }
  }
  const scalarNames = new Set<string>();
  for (const scalar of scalars) {
    const type = schema.getType(scalar.name);
    if (!isScalarType(type) || scalarNames.has(scalar.name))
      throw new DomainError("INVALID_INPUT", `Invalid scalar registration ${scalar.name}`);
    scalarNames.add(scalar.name);
    type.serialize = scalar.serialize;
    type.parseValue = scalar.parseValue;
    type.parseLiteral = scalar.parseLiteral;
  }
  return schema;
}

export function graphQLError(error: unknown): GraphQLError {
  const types = {
    UNAUTHENTICATED: "authentication error",
    FORBIDDEN: "forbidden",
    NOT_FOUND: "user error",
    INVALID_INPUT: "invalid input",
    CONFLICT: "user error",
  };
  if (error instanceof GraphQLError) {
    let original: Error | undefined = error.originalError;
    while (original instanceof GraphQLError && original.originalError)
      original = original.originalError;
    const publicError =
      original instanceof DomainError ? graphQLError(original) : graphQLError(new Error());
    const extensions = original || error.path ? publicError.extensions : { type: "graphql error" };
    const message =
      !error.path && original
        ? `Invalid GraphQL input${original instanceof DomainError ? `: ${original.message}` : ""}`
        : original || error.path
          ? publicError.message
          : error.message;
    return new GraphQLError(message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      extensions:
        !error.path && original && !(original instanceof DomainError)
          ? { code: "INVALID_INPUT", type: "invalid input" }
          : extensions,
    });
  }
  return new GraphQLError(error instanceof DomainError ? error.message : "Internal server error", {
    extensions: {
      code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
      type: error instanceof DomainError ? types[error.code] : "internal error",
    },
  });
}

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export async function executeGraphQL(
  schema: GraphQLSchema,
  request: GraphQLRequest,
  context: GraphQLContext,
): Promise<ExecutionResult> {
  const result = await graphql({
    schema,
    source: request.query,
    variableValues: request.variables,
    operationName: request.operationName,
    contextValue: context,
    fieldResolver: defaultFieldResolver,
  });
  if (!result.errors) return result;
  return {
    ...result,
    errors: result.errors.map(graphQLError),
  };
}
