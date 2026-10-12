import { GraphQLScalarType, Kind, parse, validate, validateSchema } from "graphql";
import type { Runtime } from "../core/runtime";
import { DomainError } from "../core/errors";
import { authenticateFixture } from "../identity/fixture";
import { supportingResolvers } from "../workspace/supporting";
import type { HttpHandler } from "../server";
import { executeGraphQL, graphQLError, installResolvers } from "./composition";
import { deriveSchema, loadContract, operationInventory } from "./contract";

export async function createGraphQLHandler(runtime: Runtime): Promise<HttpHandler> {
  const { source, documents } = await loadContract();
  const schema = deriveSchema(source);
  const errors = validateSchema(schema);
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  operationInventory(schema, documents);
  installResolvers(schema, supportingResolvers(), [
    new GraphQLScalarType({
      name: "DateTime",
      serialize(value) {
        const date = new Date(typeof value === "number" ? value : String(value));
        if (!Number.isFinite(date.getTime()))
          throw new DomainError("INVALID_INPUT", "Invalid date");
        return date.toISOString();
      },
      parseValue: (value) => value,
      parseLiteral: (node) => (node.kind === Kind.STRING ? node.value : null),
    }),
    new GraphQLScalarType({
      name: "JSONObject",
      serialize: (value) => value,
      parseValue: (value) => value,
    }),
    new GraphQLScalarType({
      name: "JSON",
      serialize: (value) => JSON.stringify(value),
      parseValue: (value) => value,
    }),
  ]);
  return async (request) => {
    if (new URL(request.url).pathname !== "/graphql") return null;
    if (request.method !== "POST")
      return Response.json(
        { errors: [graphQLError(new DomainError("INVALID_INPUT", "POST required"))] },
        { status: 405 },
      );
    let principal;
    try {
      principal = authenticateFixture(request, runtime);
    } catch (error) {
      return Response.json({ errors: [graphQLError(error)] }, { status: 401 });
    }
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new DomainError("INVALID_INPUT", "Invalid JSON body");
      }
      if (
        !body ||
        typeof body !== "object" ||
        !("query" in body) ||
        typeof body.query !== "string" ||
        !body.query.trim()
      )
        throw new DomainError("INVALID_INPUT", "query must be a nonempty string");
      const input = body as {
        query: string;
        variables?: Record<string, unknown>;
        operationName?: string;
      };
      if (
        input.variables !== undefined &&
        (input.variables === null ||
          typeof input.variables !== "object" ||
          Array.isArray(input.variables))
      )
        throw new DomainError("INVALID_INPUT", "variables must be an object");
      if (input.operationName !== undefined && typeof input.operationName !== "string")
        throw new DomainError("INVALID_INPUT", "operationName must be a string");
      let document;
      try {
        document = parse(input.query);
      } catch {
        throw new DomainError("INVALID_INPUT", "Invalid GraphQL syntax");
      }
      const validationErrors = validate(schema, document);
      if (validationErrors.length)
        return Response.json(
          {
            errors: validationErrors.map((error) => ({
              message: error.message,
              extensions: { type: "graphql error" },
            })),
          },
          { status: 400 },
        );
      const result = await executeGraphQL(schema, input, { principal, runtime });
      return Response.json(result, {
        status: result.errors?.some((error) => !error.path) ? 400 : 200,
      });
    } catch (error) {
      return Response.json(
        { errors: [graphQLError(error)] },
        { status: error instanceof DomainError ? 400 : 500 },
      );
    }
  };
}
