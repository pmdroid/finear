import { LinearClient } from "@linear/sdk";

let origin: URL;
try {
  try {
    origin = new URL(process.env.FINEAR_URL ?? "http://127.0.0.1:4444");
  } catch {
    throw new Error("FINEAR_URL must be an absolute HTTP or HTTPS origin without credentials");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("FINEAR_URL must be an HTTP or HTTPS origin without credentials");
  }
  try {
    const response = await fetch(new URL("/health", origin), {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error();
  } catch {
    throw new Error(
      "Finear is not ready. Start `bun run start` in a separate terminal, wait for its listening URL, then run the OAuth example again. If using another port, set FINEAR_URL to the server origin.",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "OAuth preflight failed");
  process.exit(1);
}
const redirectUri = "http://127.0.0.1:5555/callback";
const clientId = "30000000-0000-4000-8000-000000000001";
const clientSecret = "finear-fixture-oauth-secret";
const state = crypto.randomUUID();
let settle!: (value: string) => void;
let fail!: (error: Error) => void;
const completed = new Promise<string>((resolve, reject) => {
  settle = resolve;
  fail = reject;
});
let consumed = false;
const callback = Bun.serve({
  hostname: "127.0.0.1",
  port: 5555,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/callback" || request.method !== "GET")
      return new Response("Not found", { status: 404 });
    if (url.searchParams.get("state") !== state)
      return new Response("Invalid OAuth state", { status: 400 });
    if (consumed) return new Response("Callback already consumed", { status: 409 });
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) {
      fail(new Error("OAuth authorization was denied"));
      return new Response("Authorization denied", { status: 400 });
    }
    consumed = true;
    try {
      const response = await fetch(new URL("/oauth/token", origin), {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      if (!response.ok) throw new Error("OAuth token exchange failed");
      const tokens = (await response.json()) as { access_token?: string };
      if (!tokens.access_token) throw new Error("OAuth response has no access token");
      const client = new LinearClient({
        apiUrl: new URL("/graphql", origin).href,
        accessToken: tokens.access_token,
      });
      const viewer = await client.viewer;
      settle(JSON.stringify({ viewerId: viewer.id, name: viewer.name, app: viewer.app }));
      return new Response("Finear authorization completed. Return to your terminal.");
    } catch {
      fail(new Error("OAuth token exchange or SDK request failed"));
      return new Response("Authorization failed", { status: 502 });
    }
  },
});
const timeout = setTimeout(() => fail(new Error("Authorization timed out")), 300000);
const authorize = new URL("/oauth/authorize", origin);
authorize.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "read,write,app:assignable",
  actor: "app",
  state,
}).toString();
console.log(
  `Waiting for you to open this URL in a browser and approve the fixture workspace:\n${authorize}`,
);
try {
  console.log(await completed);
} catch (error) {
  console.error(error instanceof Error ? error.message : "OAuth failed");
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await callback.stop(false);
}
