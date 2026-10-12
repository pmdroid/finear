import { afterEach, expect, test } from "bun:test";
import { LinearClient } from "@linear/sdk";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const origins = new Map<ReturnType<typeof Bun.spawn>, URL>();
const processEnvironments = new Map<ReturnType<typeof Bun.spawn>, ReturnType<typeof environment>>();
function environment(extra: Record<string, string | undefined> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "finear-cli-"));
  directories.push(directory);
  const home = join(directory, "home");
  const kyotoRoot = join(home, ".kyotoagent");
  mkdirSync(kyotoRoot, { recursive: true });
  if (
    realpathSync(home) !== home ||
    realpathSync(kyotoRoot) !== kyotoRoot ||
    !home.startsWith(directory + "/")
  )
    throw new Error("Invalid isolated paths");
  return {
    ...process.env,
    HOME: home,
    KYOTOAGENT_ROOT: kyotoRoot,
    DATABASE_PATH: join(directory, "workspace.sqlite"),
    HOST: "127.0.0.1",
    PORT: "0",
    CONTROL_TOKEN: "cli-control",
    ...extra,
  };
}
function spawn(entry: string, env: ReturnType<typeof environment>) {
  const child = Bun.spawn([process.execPath, entry], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(child);
  processEnvironments.set(child, env);
  return child;
}
async function stop(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!processes.includes(child) || !child.pid || !origins.has(child))
    throw new Error("Unowned application process");
  const expected = processEnvironments.get(child);
  const actual = readFileSync(`/proc/${child.pid}/environ`, "utf8").split("\0");
  if (
    !expected ||
    !actual.includes(`HOME=${expected.HOME}`) ||
    !actual.includes(`KYOTOAGENT_ROOT=${expected.KYOTOAGENT_ROOT}`)
  )
    throw new Error("Process isolation mismatch");
  child.kill("SIGTERM");
  await Promise.race([
    child.exited,
    Bun.sleep(5000).then(() => {
      throw new Error("Owned server did not exit");
    }),
  ]);
}
afterEach(async () => {
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      const expected = processEnvironments.get(child);
      const actual = readFileSync(`/proc/${child.pid}/environ`, "utf8").split("\0");
      if (
        !expected ||
        !actual.includes(`HOME=${expected.HOME}`) ||
        !actual.includes(`KYOTOAGENT_ROOT=${expected.KYOTOAGENT_ROOT}`)
      )
        throw new Error("Process isolation mismatch");
      child.kill("SIGTERM");
      await child.exited;
    }
    origins.delete(child);
    processEnvironments.delete(child);
  }
  processes.length = 0;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function start(extra: Record<string, string | undefined> = {}) {
  const env = environment(extra);
  const child = spawn("src/main.ts", env);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let output = "";
  const read = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Server exited before readiness: ${output}`);
      output += new TextDecoder().decode(value);
      const match = /Finear listening at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
      if (match) return new URL(match[1]!);
    }
  };
  const url = await Promise.race([
    read(),
    Bun.sleep(5000).then(() => {
      throw new Error("Server readiness timeout");
    }),
  ]);
  origins.set(child, url);
  expect(Number(url.port)).toBeGreaterThan(0);
  expect(child.pid).toBeGreaterThan(0);
  expect(resolve(env.DATABASE_PATH)).toBe(env.DATABASE_PATH);
  reader.releaseLock();
  return { child, url, env };
}
async function result(entry: string, extra: Record<string, string | undefined> = {}) {
  const child = spawn(entry, environment(extra));
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

test("CLI starts, SDK persists, authenticated reset restores fixtures, and SIGTERM closes/reopens", async () => {
  const first = await start();
  expect((await fetch(new URL("/health", first.url))).status).toBe(200);
  const client = new LinearClient({
    apiUrl: new URL("/graphql", first.url).href,
    apiKey: "finear-fixture-primary-key",
  });
  const team = (await client.teams()).nodes[0]!;
  const project = (await (
    await client.createProject({ name: "CLI project", teamIds: [team.id] })
  ).project)!;
  const issue = (await (
    await client.createIssue({ title: "CLI issue", teamId: team.id, projectId: project.id })
  ).issue)!;
  expect(issue.identifier).toBe("ENG-1");
  await stop(first.child);
  expect(first.child.exitCode).toBe(0);
  await expect(fetch(new URL("/health", first.url))).rejects.toThrow();
  const second = await start({ DATABASE_PATH: first.env.DATABASE_PATH });
  const persisted = new LinearClient({
    apiUrl: new URL("/graphql", second.url).href,
    apiKey: "finear-fixture-primary-key",
  });
  expect((await persisted.issue(issue.id)).title).toBe("CLI issue");
  const reset = await result("src/reset.ts", { FINEAR_URL: second.url.origin });
  expect(reset.exit).toBe(0);
  expect(reset.stdout).toContain("Finear fixtures reset");
  expect((await persisted.issues()).nodes).toHaveLength(0);
  expect((await persisted.projects()).nodes).toHaveLength(0);
  await stop(second.child);
  const third = await start({ DATABASE_PATH: first.env.DATABASE_PATH });
  const clean = new LinearClient({
    apiUrl: new URL("/graphql", third.url).href,
    apiKey: "finear-fixture-primary-key",
  });
  expect((await clean.viewer).name).toBe("Human 1");
  const repeated = (await (await clean.createIssue({ title: "Repeat", teamId: team.id })).issue)!;
  expect(repeated.identifier).toBe("ENG-1");
  await stop(third.child);
}, 15000);

test("CLI rejects invalid port and reset configuration without exposing secrets", async () => {
  for (const PORT of ["wrong", "-1", "65536", "1.5"]) {
    const output = await result("src/main.ts", { PORT });
    expect(output.exit).not.toBe(0);
    expect(output.stderr).toContain("PORT must be an integer");
  }
  for (const config of [
    { CONTROL_TOKEN: undefined },
    { CONTROL_TOKEN: "bad token" },
    { FINEAR_URL: "not-a-url" },
    { FINEAR_URL: "file:///tmp/finear" },
    { FINEAR_URL: "http://fixture-user@127.0.0.1:4444" },
  ]) {
    const output = await result("src/reset.ts", config);
    expect(output.exit).toBe(1);
    expect(output.stderr).not.toContain("fixture-user");
    expect(output.stdout).toBe("");
  }
  const app = await start();
  const denied = await result("src/reset.ts", {
    FINEAR_URL: app.url.origin,
    CONTROL_TOKEN: "wrong-secret",
  });
  expect(denied.exit).toBe(1);
  expect(denied.stderr).toContain("HTTP 401");
  expect(denied.stderr).not.toContain("wrong-secret");
  const credential = await result("src/reset.ts", {
    FINEAR_URL: app.url.origin,
    CONTROL_TOKEN: "finear-fixture-primary-key",
  });
  expect(credential.exit).toBe(1);
  await stop(app.child);
}, 15000);

test("documented SDK example runs against the CLI entry point", async () => {
  const app = await start();
  const output = await result("examples/sdk.ts", { FINEAR_URL: app.url.origin });
  expect(output.exit).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({
    parent: "ENG-1",
    children: ["ENG-2", "ENG-3"],
  });
  await stop(app.child);
});

test("documented OAuth callback example verifies state and exchanges local form credentials", async () => {
  const app = await start();
  const callback = spawn("examples/oauth-client.ts", environment({ FINEAR_URL: app.url.origin }));
  const reader = (callback.stdout as ReadableStream<Uint8Array>).getReader();
  let output = "";
  const readAuthorize = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("OAuth example exited before authorization URL");
      output += new TextDecoder().decode(value);
      const match = /http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?\S+/.exec(output);
      if (match) return new URL(match[0]);
    }
  };
  const authorize = await Promise.race([
    readAuthorize(),
    Bun.sleep(5000).then(() => {
      throw new Error("OAuth callback example timeout");
    }),
  ]);
  const callbackUrl = new URL(authorize.searchParams.get("redirect_uri")!);
  const invalid = new URL(callbackUrl);
  invalid.search = new URLSearchParams({ state: "wrong-state", code: "invalid" }).toString();
  expect((await fetch(invalid)).status).toBe(400);
  const page = await fetch(authorize);
  const consent = /name="consent" value="([^"]+)"/.exec(await page.text())![1]!;
  const completed = await fetch(new URL("/oauth/authorize", app.url), {
    method: "POST",
    body: new URLSearchParams({
      consent,
      decision: "allow",
      user_id: "10000000-0000-4000-8000-000000000002",
      workspace_id: "10000000-0000-4000-8000-000000000001",
      team_id: "10000000-0000-4000-8000-000000000003",
    }),
  });
  expect(completed.status).toBe(200);
  expect(await completed.text()).toContain("authorization completed");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  expect(await callback.exited).toBe(0);
  expect(output).toContain('"app":true');
  expect(output).not.toContain("access_token");
  await expect(fetch(callbackUrl)).rejects.toThrow();
  await stop(app.child);
}, 15000);
