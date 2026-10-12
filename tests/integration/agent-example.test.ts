import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual agent example installs OAuth app and processes signed HTTP events exactly once", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "finear-agent-example-cli-")));
  const home = join(directory, "home");
  const kyotoRoot = join(home, ".kyotoagent");
  mkdirSync(kyotoRoot, { recursive: true });
  expect(realpathSync(home)).toBe(home);
  expect(realpathSync(kyotoRoot)).toBe(kyotoRoot);
  const child = Bun.spawn([process.execPath, "examples/agent.ts"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      HOME: home,
      KYOTOAGENT_ROOT: kyotoRoot,
      TMPDIR: directory,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const [stdout, stderr, exit] = await Promise.race([
      output,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Agent example CLI timed out")), 15000);
      }),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("OAuth: approved fixture consent, validated state");
    expect(stdout).toContain("signed created event → thought → elicitation");
    expect(stdout).toContain("signed prompted event → response");
    expect(stdout).toContain("acknowledged duplicate without processing twice");
    const resultLine = stdout.split("\n").find((line) => line.startsWith("Result: "));
    expect(resultLine).toBeDefined();
    expect(JSON.parse(resultLine!.slice("Result: ".length))).toEqual({
      status: "complete",
      issue: "ENG-1",
      appViewer: true,
      humanAssigneePreserved: true,
      actions: ["created", "prompted"],
      statuses: ["pending", "active", "awaitingInput", "complete"],
      activities: 4,
      comments: 3,
      webhooks: { verified: 3, rejected: 1, duplicates: 1, processed: 2 },
    });
    expect(stdout).not.toMatch(
      /access_token|refresh_token|Bearer |client_secret|linear-signature/i,
    );
    const resourceLine = stdout.split("\n").find((line) => line.startsWith("Resources: "));
    expect(resourceLine).toBeDefined();
    const resources = JSON.parse(resourceLine!.slice("Resources: ".length)) as {
      application: string;
      receiver: string;
      directory: string;
    };
    expect(resources.directory.startsWith(directory + "/")).toBe(true);
    expect(existsSync(resources.directory)).toBe(false);
    for (const origin of [resources.application, resources.receiver]) {
      const url = new URL(origin);
      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).toBeGreaterThan(0);
      await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const environment = readFileSync(`/proc/${child.pid}/environ`, "utf8").split("\0");
      expect(environment).toContain(`HOME=${home}`);
      expect(environment).toContain(`KYOTOAGENT_ROOT=${kyotoRoot}`);
      expect(environment).toContain(`TMPDIR=${directory}`);
      child.kill("SIGTERM");
      await child.exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
