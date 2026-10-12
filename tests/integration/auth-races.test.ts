import { afterEach, expect, test } from "bun:test";
import { LinearClient } from "@linear/sdk";
import { request as httpRequest } from "node:http";
import { createApplication, type Application } from "../../src/application";
import { createGraphQLHandler } from "../../src/graphql/http";
import { deliveredOperations, supportingRoots } from "../../src/graphql/contract";
import type { Principal } from "../../src/core/principal";
import { fixtureOAuthClient, identityResolvers } from "../../src/identity";
import { fixtureIds } from "../../src/workspace/fixtures";
import { supportingResolvers } from "../../src/workspace/supporting";
import { Workspace } from "../../src/workspace/entities";
import {
  workspaceEntityResolvers,
  workspaceEntityRoots,
  workspaceEntityOperations,
} from "../../src/workspace/entity-resolvers";
import { startServer } from "../../src/server";

const applications: Application[] = [];
const listeners: ReturnType<typeof startServer>[] = [];
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.stop(true);
  for (const application of applications.splice(0)) await application.close();
});
async function token(application: Application) {
  const authorize = new URL("/oauth/authorize", application.url);
  authorize.search = new URLSearchParams({
    client_id: fixtureOAuthClient.id,
    redirect_uri: fixtureOAuthClient.redirectUris[0],
    response_type: "code",
    scope: "read,write",
    state: "auth-race-state",
    actor: "user",
  }).toString();
  const page = await fetch(authorize);
  expect(page.status).toBe(200);
  const consent = /name="consent" value="([^"]+)"/.exec(await page.text())![1]!;
  const approval = await fetch(new URL("/oauth/authorize", application.url), {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      consent,
      decision: "allow",
      workspace_id: fixtureIds.primary.organization,
      user_id: fixtureIds.primary.user,
      team_id: fixtureIds.primary.team,
    }),
  });
  expect(approval.status).toBe(302);
  const callback = new URL(approval.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe("auth-race-state");
  const response = await fetch(new URL("/oauth/token", application.url), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: fixtureOAuthClient.id,
      client_secret: fixtureOAuthClient.secret,
      redirect_uri: fixtureOAuthClient.redirectUris[0],
      code: callback.searchParams.get("code")!,
    }),
  });
  expect(response.status).toBe(200);
  return String((await response.json()).access_token);
}

for (const change of ["revocation", "membership"] as const) {
  for (const operation of ["read", "mutation"] as const) {
    test(`real OAuth ${change} during chunked ${operation} is revalidated before execution`, async () => {
      await race(change, operation, false);
    });
    test(`stale-principal baseline observes unauthorized ${operation} after real OAuth ${change}`, async () => {
      await race(change, operation, true);
    });
  }
}

async function race(
  change: "revocation" | "membership",
  operation: "read" | "mutation",
  staleBaseline: boolean,
) {
  const application = await createApplication({ databasePath: ":memory:", port: 0 });
  applications.push(application);
  const accessToken = await token(application);
  const client = new LinearClient({
    apiUrl: new URL("/graphql", application.url).href,
    accessToken,
  });
  const seeded = (await (
    await client.createIssue({
      teamId: fixtureIds.primary.team,
      title: "Existing authorized issue",
    })
  ).issue)!;
  const before = application.runtime.database
    .query<{ count: number }>("SELECT count(*) AS count FROM issues")
    .get()!.count;
  const eventsBefore = application.runtime.database
    .query<{ count: number }>("SELECT count(*) AS count FROM outbox")
    .get()!.count;
  const authenticated = Promise.withResolvers<void>();
  let calls = 0;
  let original: Principal | undefined;
  const entityMap = workspaceEntityResolvers(new Workspace(application.runtime));
  const graphql = await createGraphQLHandler(application.runtime, {
    authenticate(request) {
      calls++;
      const principal =
        staleBaseline && original ? original : application.identity.authenticate(request);
      original = principal;
      authenticated.resolve();
      return principal;
    },
    resolverMaps: [supportingResolvers(), identityResolvers(), entityMap],
    roots: {
      query: [...supportingRoots, ...workspaceEntityRoots],
      mutation: Object.keys(entityMap.Mutation!),
    },
    operations: [...deliveredOperations, ...workspaceEntityOperations],
  });
  const listener = startServer({ port: 0, handlers: [graphql] });
  listeners.push(listener);
  const query =
    operation === "read"
      ? `query { issue(id: "${seeded.id}") { id title } }`
      : `mutation { issueCreate(input: {teamId: "${fixtureIds.primary.team}", title: "Unauthorized race issue"}) { success issue { id } } }`;
  const completed = Promise.withResolvers<{ status: number; body: string }>();
  const request = httpRequest(
    new URL("/graphql", listener.url),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => completed.resolve({ status: response.statusCode!, body }));
      response.on("error", completed.reject);
    },
  );
  request.on("error", completed.reject);
  try {
    request.write('{"query":');
    await Promise.race([
      authenticated.promise,
      Bun.sleep(3000).then(() => {
        throw new Error("Initial authentication timed out");
      }),
    ]);
    expect(calls).toBe(1);
    expect(original?.teamIds).toContain(fixtureIds.primary.team);
    if (change === "revocation") {
      const revoked = await fetch(new URL("/oauth/revoke", application.url), {
        method: "POST",
        body: new URLSearchParams({ token: accessToken }),
      });
      expect(revoked.status).toBe(200);
    } else {
      application.runtime.database.transaction((tx) =>
        tx.run(
          "DELETE FROM team_memberships WHERE organization_id = ? AND team_id = ? AND user_id = ?",
          fixtureIds.primary.organization,
          fixtureIds.primary.team,
          fixtureIds.primary.user,
        ),
      );
      expect(
        application.runtime.database
          .query("SELECT user_id FROM team_memberships WHERE user_id = ?")
          .get(fixtureIds.primary.user),
      ).toBeNull();
    }
    request.end(`${JSON.stringify(query)}}`);
    const response = await completed.promise;
    const body = JSON.parse(response.body);
    if (staleBaseline) {
      expect(response.status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect(operation === "read" ? body.data.issue.id : body.data.issueCreate.success).toBe(
        operation === "read" ? seeded.id : true,
      );
      expect(
        application.runtime.database
          .query<{ count: number }>("SELECT count(*) AS count FROM issues")
          .get()!.count,
      ).toBe(before + (operation === "mutation" ? 1 : 0));
      expect(
        application.runtime.database
          .query<{ count: number }>("SELECT count(*) AS count FROM outbox")
          .get()!.count,
      ).toBe(eventsBefore + (operation === "mutation" ? 1 : 0));
    } else {
      expect(response.status).toBe(change === "revocation" ? 401 : 200);
      expect(body.data ?? null).toBeNull();
      expect(body.errors[0].extensions.type).toBe(
        change === "revocation"
          ? "authentication error"
          : operation === "read"
            ? "user error"
            : "forbidden",
      );
      expect(response.body).not.toContain(accessToken);
      expect(
        application.runtime.database
          .query<{ count: number }>("SELECT count(*) AS count FROM issues")
          .get()!.count,
      ).toBe(before);
      expect(
        application.runtime.database
          .query<{ count: number }>("SELECT count(*) AS count FROM outbox")
          .get()!.count,
      ).toBe(eventsBefore);
    }
    expect(calls).toBe(2);
    await expect(client.issue(seeded.id)).rejects.toThrow();
  } finally {
    request.destroy();
  }
}
