import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRuntime, resetRuntime } from "../../src/core/runtime";
import { createIdentity, fixtureOAuthClient, identityMigrations } from "../../src/identity";
import { renderConsent } from "../../src/identity/consent";
import { fixtureIds } from "../../src/workspace/fixtures";
import { startServer } from "../../src/server";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

const page = {
  clientName: "Fixture Agent",
  actor: "app",
  scopes: ["read", "write", "app:assignable"],
  nonce: "consent-nonce",
  callbackUrl: new URL("http://127.0.0.1:5555/callback?existing=value"),
  choices: [
    {
      userId: "user-1",
      userName: "Human 1",
      workspaceId: "workspace-1",
      workspaceName: "Workspace 1",
      teams: [
        { id: "team-1", name: "Engineering" },
        { id: "team-2", name: "Design" },
      ],
    },
  ],
};

test("consent provides a responsive document and named native authorization controls", async () => {
  const response = renderConsent(page);
  const body = await response.text();
  expect(body).toContain('<html lang="en">');
  expect(body).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  expect(body).toContain(
    '<form method="post" action="/oauth/authorize" aria-labelledby="choice-0">',
  );
  expect(body).toContain('<h2 id="choice-0">Human 1</h2>');
  expect(body).toContain('<p class="workspace">Workspace 1</p>');
  expect(body).toContain('<input type="hidden" name="consent" value="consent-nonce">');
  expect(body).toContain('<input type="hidden" name="user_id" value="user-1">');
  expect(body).toContain('<input type="hidden" name="workspace_id" value="workspace-1">');
  expect(body).toContain("<fieldset><legend>Team access</legend>");
  for (const team of page.choices[0]!.teams) {
    expect(body).toContain(
      `<label class="team"><input type="checkbox" name="team_id" value="${team.id}" checked><span>${team.name}</span></label>`,
    );
  }
  expect(body).toContain(
    '<button type="submit" name="decision" value="allow">Authorize Fixture Agent</button>',
  );
  expect(body).toContain('<button type="submit" name="decision" value="deny">Deny</button>');
  expect(body).toContain("<dt>Acting as</dt><dd>app</dd>");
  for (const scope of page.scopes) expect(body).toContain(`<li><code>${scope}</code></li>`);
});

test("consent escapes all dynamic text and attribute values", async () => {
  const unsafe = `A & <script>bad()</script> " ' </style>`;
  const escaped = "A &amp; &lt;script&gt;bad()&lt;/script&gt; &quot; &#39; &lt;/style&gt;";
  const body = await renderConsent({
    clientName: unsafe,
    actor: unsafe,
    scopes: [unsafe],
    nonce: unsafe,
    callbackUrl: page.callbackUrl,
    choices: [
      {
        userId: unsafe,
        userName: unsafe,
        workspaceId: unsafe,
        workspaceName: unsafe,
        teams: [{ id: unsafe, name: unsafe }],
      },
    ],
  }).text();
  expect(body).not.toContain(unsafe);
  expect(body.split(escaped).length - 1).toBe(11);
  expect(body).not.toContain("<script>");
  expect(body).not.toContain("<link");
});

test("consent allows only its exact stylesheet while retaining restrictive response headers", async () => {
  const response = renderConsent(page);
  const body = await response.text();
  const styles = /<style>([\s\S]*?)<\/style>/.exec(body)![1]!;
  const hash = createHash("sha256").update(styles).digest("base64");
  expect(response.headers.get("content-security-policy")).toBe(
    `default-src 'none'; style-src 'sha256-${hash}'; form-action 'self' http://127.0.0.1:5555; frame-ancestors 'none'; base-uri 'none'`,
  );
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("same-origin");
});

test("authorization reads workspace names without changing fixture identity and team choices", async () => {
  const runtime = createRuntime({ databasePath: ":memory:", migrations: [identityMigrations] });
  cleanup.push(() => runtime.close());
  const identity = createIdentity(runtime);
  resetRuntime(runtime, [identity.resetOwner]);
  runtime.database.transaction((tx) => {
    tx.run(
      "UPDATE organizations SET name = ? WHERE id = ?",
      "Studio <One> & Co",
      fixtureIds.primary.organization,
    );
    tx.run("UPDATE users SET name = ? WHERE id = ?", 'Human "One"', fixtureIds.primary.user);
    tx.run(
      "UPDATE teams SET name = ? WHERE id = ?",
      "Engineering & Design",
      fixtureIds.primary.team,
    );
  });
  const server = startServer({ port: 0, handlers: [identity.handler] });
  cleanup.push(() => server.stop(true));
  const query = new URLSearchParams({
    client_id: fixtureOAuthClient.id,
    redirect_uri: fixtureOAuthClient.redirectUris[0],
    response_type: "code",
    scope: "read",
  });
  const response = await fetch(new URL("/oauth/authorize?" + query, server.url));
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('class="workspace">Studio &lt;One&gt; &amp; Co</p>');
  expect(body).toContain('id="choice-0">Human &quot;One&quot;</h2>');
  expect(body).toContain("Engineering &amp; Design</span>");
  expect(body).toContain("<dt>Acting as</dt><dd>user</dd>");
  for (const ids of Object.values(fixtureIds)) {
    expect(body).toContain(`name="user_id" value="${ids.user}"`);
    expect(body).toContain(`name="workspace_id" value="${ids.organization}"`);
    expect(body).toContain(`name="team_id" value="${ids.team}" checked`);
    expect(body).not.toContain(`name="team_id" value="${ids.privateTeam}"`);
  }
});
