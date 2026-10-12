import { expect, test } from "bun:test";
import { buildSchema, Kind, parseValue } from "graphql";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import { authenticateFixture, fixtureApiKeys } from "../../src/identity/fixture";
import { contractScalars } from "../../src/graphql/scalars";
import { executeGraphQL, installResolvers } from "../../src/graphql/composition";
import { fixtureTime } from "../../src/workspace/fixtures";
import { startServer } from "../../src/server";

function scalars(now = fixtureTime) {
  return new Map(contractScalars({ now: () => now }).map((scalar) => [scalar.name, scalar]));
}

test("date coercion rejects malformed shapes and impossible dates without JavaScript fallback", () => {
  const types = scalars();
  for (const name of ["DateTime", "DateTimeOrDuration", "TimelessDate", "TimelessDateOrDuration"]) {
    const scalar = types.get(name)!;
    for (const value of [
      false,
      123,
      {},
      [],
      "",
      "tomorrow",
      "2026-02-30",
      "2026-13-01",
      "2026-00-01",
      "2026-01-00",
      "2026-01-01T25:00:00Z",
      "2026-01-01T00:00:00+24:00",
      "P",
      "PT",
      "P1DT",
    ]) {
      expect(() => scalar.parseValue(value)).toThrow();
    }
    expect(() => scalar.parseLiteral({ kind: Kind.INT, value: "123" })).toThrow();
    expect(() => scalar.serialize({ toString: () => "2026-01-01" })).toThrow();
    expect(() => scalar.serialize(Number.NaN)).toThrow();
    expect(() => scalar.serialize("-P1D")).toThrow();
  }
  expect(types.get("DateTime")!.parseValue("2024")).toBe("2024-01-01T00:00:00.000Z");
  expect(types.get("DateTime")!.parseValue("2024-02")).toBe("2024-02-01T00:00:00.000Z");
  expect(types.get("DateTime")!.parseValue("2024-02-29T02:00:00+02:00")).toBe(
    "2024-02-29T00:00:00.000Z",
  );
  expect(types.get("DateTime")!.serialize(fixtureTime)).toBe(new Date(fixtureTime).toISOString());
  expect(types.get("TimelessDate")!.serialize(new Date("2024-02-29T12:00:00Z"))).toBe("2024-02-29");
});

test("relative dates use injected advancing clock with calendar months and preserved duration scalar", () => {
  let now = Date.parse("2024-03-31T12:00:00Z");
  const types = new Map(contractScalars({ now: () => now }).map((scalar) => [scalar.name, scalar]));
  expect(types.get("DateTime")!.parseValue("-P1M")).toBe("2024-02-29T12:00:00.000Z");
  expect(types.get("DateTimeOrDuration")!.parseValue("-P2W1D")).toBe("2024-03-16T12:00:00.000Z");
  now += 86400000;
  expect(types.get("DateTimeOrDuration")!.parseValue("-P2W1D")).toBe("2024-03-17T12:00:00.000Z");
  expect(types.get("TimelessDate")!.parseValue("P1D")).toBe("2024-04-02");
  expect(types.get("TimelessDateOrDuration")!.parseValue("-P1M")).toBe("-P1M");
  expect(() =>
    contractScalars()
      .find((scalar) => scalar.name === "DateTime")!
      .parseValue("-P1D"),
  ).toThrow("clock");
});

test("JSON stringified and JSONObject embedded values retain their wire shapes and reject invalid runtime values", () => {
  const types = scalars();
  const json = types.get("JSON")!;
  const object = types.get("JSONObject")!;
  const value = { plan: [{ content: "one", complete: false }], optional: null };
  expect(json.serialize(value)).toBe(JSON.stringify(value));
  expect(json.parseValue(JSON.stringify(value))).toEqual(value);
  expect(json.serialize("text")).toBe('"text"');
  expect(object.serialize(value)).toEqual(value);
  expect(object.parseValue(value.plan)).toEqual(value.plan);
  expect(object.parseLiteral(parseValue('{content: "body", nested: [1, true, null]}'))).toEqual({
    content: "body",
    nested: [1, true, null],
  });
  for (const bad of [value, undefined, 1, false, "bad json"])
    expect(() => json.parseValue(bad)).toThrow();
  for (const bad of ["text", 1, false, null]) expect(() => object.parseValue(bad)).toThrow();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const bad of [
    { value: undefined },
    { value: NaN },
    { value: Infinity },
    { value: () => 1 },
    new Date(),
    cycle,
    Array(2),
    { [Symbol("secret")]: 1 },
  ]) {
    expect(() => json.serialize(bad)).toThrow();
    expect(() => object.serialize(bad)).toThrow();
  }
});

test("custom scalars roundtrip through real GraphQL variables, literals and union execution", async () => {
  const runtime = createRuntime({ databasePath: ":memory:", clockSource: () => fixtureTime });
  try {
    resetRuntime(runtime);
    const principal = authenticateFixture(
      new Request("http://localhost/graphql", {
        headers: { authorization: fixtureApiKeys.primary },
      }),
      runtime,
    );
    const schema = buildSchema(`scalar JSON
      scalar JSONObject
      scalar DateTime
      scalar TimelessDate
      type Echo { json: JSON!, structured: JSONObject!, timestamp: DateTime!, day: TimelessDate! }
      union Result = Echo
      type Query { echo(json: JSON!, structured: JSONObject!, timestamp: DateTime!, day: TimelessDate!): Result! }`);
    installResolvers(
      schema,
      { Query: { echo: (_source, args) => ({ __typename: "Echo", ...args }) } },
      contractScalars(runtime.clock).filter((scalar) => schema.getType(scalar.name)),
    );
    const query = `query Echo($json: JSON!, $structured: JSONObject!, $timestamp: DateTime!, $day: TimelessDate!) {
      alias: echo(json: $json, structured: $structured, timestamp: $timestamp, day: $day) {
        __typename ...Fields
      }
    }
    fragment Fields on Echo { json structured timestamp day }`;
    const variables = {
      json: '{"a":[1,null]}',
      structured: { content: "hello", list: [false] },
      timestamp: "-P1D",
      day: "2024-02-29",
    };
    const server = startServer({
      port: 0,
      handlers: [
        async (request) => {
          const input = (await request.json()) as {
            query: string;
            variables?: Record<string, unknown>;
            operationName?: string;
          };
          const result = await executeGraphQL(schema, input, { runtime, principal });
          return Response.json(result, {
            status: result.errors?.some((error) => !error.path) ? 400 : 200,
          });
        },
      ],
    });
    let result;
    try {
      const response = await fetch(new URL("/graphql", server.url), {
        method: "POST",
        body: JSON.stringify({ query, variables, operationName: "Echo" }),
      });
      expect(response.status).toBe(200);
      result = await response.json();
      const invalidResponse = await fetch(new URL("/graphql", server.url), {
        method: "POST",
        body: JSON.stringify({ query, variables: { ...variables, structured: "not-structured" } }),
      });
      expect(invalidResponse.status).toBe(400);
      expect((await invalidResponse.json()).errors[0].locations).toBeDefined();
    } finally {
      server.stop(true);
    }
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      alias: {
        __typename: "Echo",
        json: variables.json,
        structured: variables.structured,
        timestamp: new Date(fixtureTime - 86400000).toISOString(),
        day: "2024-02-29",
      },
    });
    const literal = await executeGraphQL(
      schema,
      {
        query:
          '{ echo(json: "[1,true]", structured: {body: "hello"}, timestamp: "2024", day: "2024-02-29") { ... on Echo { json structured } } }',
      },
      { runtime, principal },
    );
    expect(literal.errors).toBeUndefined();
    expect(literal.data).toEqual({ echo: { json: "[1,true]", structured: { body: "hello" } } });
    const invalid = await executeGraphQL(
      schema,
      { query, variables: { ...variables, json: { secret: "sensitive-variable" } } },
      { runtime, principal },
    );
    expect(invalid.errors?.[0]?.extensions.type).toBe("invalid input");
    expect(invalid.errors?.[0]?.locations).toBeDefined();
    expect(JSON.stringify(invalid)).not.toContain("sensitive-variable");
  } finally {
    runtime.close();
  }
});
