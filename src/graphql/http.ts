import { parse, validate, validateSchema, type GraphQLScalarType } from "graphql";
import type { Runtime } from "../core/runtime";
import type { Principal } from "../core/principal";
import { DomainError } from "../core/errors";
import { authenticateFixture } from "../identity/fixture";
import { supportingResolvers } from "../workspace/supporting";
import type { HttpHandler } from "../server";
import {
  composeResolvers,
  executeGraphQL,
  graphQLError,
  installResolvers,
  type ResolverMap,
} from "./composition";
import { deriveSchema, loadContract, operationInventory, type OperationRoots } from "./contract";
import { contractScalars } from "./scalars";

export interface GraphQLHandlerOptions {
  authenticate?: (request: Request) => Principal | Promise<Principal>;
  resolverMaps?: readonly ResolverMap[];
  roots?: OperationRoots;
  operations?: readonly string[];
  scalars?: readonly GraphQLScalarType[];
}

export async function createGraphQLHandler(
  runtime: Runtime,
  options: GraphQLHandlerOptions = {},
): Promise<HttpHandler> {
  const { source, documents } = await loadContract();
  const schema = deriveSchema(source, options.roots);
  const errors = validateSchema(schema);
  if (errors.length)
    throw new DomainError("INVALID_INPUT", errors.map((error) => error.message).join("; "));
  operationInventory(schema, documents, options.operations);
  const scalars = [
    ...contractScalars(runtime.clock).filter((scalar) => schema.getType(scalar.name)),
    ...(options.scalars ?? []),
  ];
  installResolvers(
    schema,
    composeResolvers(...(options.resolverMaps ?? [supportingResolvers()])),
    scalars,
  );
  const authenticate =
    options.authenticate ?? ((request: Request) => authenticateFixture(request, runtime));
  return async (request) => {
    if (new URL(request.url).pathname !== "/graphql") return null;
    if (request.method !== "POST")
      return Response.json(
        { errors: [graphQLError(new DomainError("INVALID_INPUT", "POST required"))] },
        { status: 405 },
      );
    let principal: Principal;
    try {
      principal = await authenticate(request);
    } catch (error) {
      return Response.json(
        { errors: [graphQLError(error instanceof DomainError ? error : new Error())] },
        { status: error instanceof DomainError ? 401 : 500 },
      );
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
        Array.isArray(body) ||
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
      const document = parse(input.query);
      const validationErrors = validate(schema, document);
      if (validationErrors.length)
        return Response.json({ errors: validationErrors.map(graphQLError) }, { status: 400 });
      try {
        principal = await authenticate(request);
      } catch (error) {
        return Response.json(
          { errors: [graphQLError(error instanceof DomainError ? error : new Error())] },
          { status: error instanceof DomainError ? 401 : 500 },
        );
      }
      const result = await executeGraphQL(schema, input, { principal, runtime });
      return Response.json(result, {
        status: result.errors?.some((error) => !error.path) ? 400 : 200,
      });
    } catch (error) {
      return Response.json(
        { errors: [graphQLError(error)] },
        {
          status:
            error instanceof DomainError ||
            (error instanceof Error && error.name === "GraphQLError")
              ? 400
              : 500,
        },
      );
    }
  };
}
