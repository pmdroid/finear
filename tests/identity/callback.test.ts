import { expect, test } from "bun:test";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import { createIdentity, fixtureOAuthClient, identityMigrations } from "../../src/identity";
import { fixtureIds, fixtureTime } from "../../src/workspace/fixtures";
import { startServer } from "../../src/server";

test("HTTP client follows consent redirect into registered callback and exchanges its observed code", async () => {
  let observed: URL | undefined;
  const callback = startServer({
    port: 0,
    handlers: [
      (request) => {
        observed = new URL(request.url);
        return new Response("callback received");
      },
    ],
  });
  const redirectUri = new URL("/callback?client_context=original", callback.url).href;
  const runtime = createRuntime({
    databasePath: ":memory:",
    clockSource: () => fixtureTime,
    migrations: [identityMigrations],
  });
  const identity = createIdentity(runtime, {
    clients: [{ ...fixtureOAuthClient, redirectUris: [redirectUri] }],
  });
  resetRuntime(runtime, [identity.resetOwner]);
  const server = startServer({ port: 0, handlers: [identity.handler] });
  try {
    const page = await fetch(
      new URL(
        "/oauth/authorize?" +
          new URLSearchParams({
            client_id: fixtureOAuthClient.id,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "read",
            state: "callback-nonce",
          }),
        server.url,
      ),
    );
    const nonce = /name="consent" value="([^"]+)"/.exec(await page.text())![1]!;
    const landed = await fetch(new URL("/oauth/authorize", server.url), {
      method: "POST",
      body: new URLSearchParams({
        consent: nonce,
        decision: "allow",
        user_id: fixtureIds.primary.user,
        workspace_id: fixtureIds.primary.organization,
        team_id: fixtureIds.primary.team,
      }),
    });
    expect(landed.redirected).toBe(true);
    expect(await landed.text()).toBe("callback received");
    expect(observed!.searchParams.get("state")).toBe("callback-nonce");
    expect(observed!.searchParams.get("client_context")).toBe("original");
    const exchanged = await fetch(new URL("/oauth/token", server.url), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: fixtureOAuthClient.id,
        client_secret: fixtureOAuthClient.secret,
        code: observed!.searchParams.get("code")!,
        redirect_uri: redirectUri,
      }),
    });
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(
      identity.authenticate(
        new Request(new URL("/graphql", server.url), {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      ).userId,
    ).toBe(fixtureIds.primary.user);
  } finally {
    server.stop(true);
    runtime.close();
    callback.stop(true);
  }
});
