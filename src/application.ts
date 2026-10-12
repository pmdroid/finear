import { timingSafeEqual } from "node:crypto";
import { DomainError, errorResponse } from "./core/errors";
import { createRuntime, resetRuntime, type Runtime } from "./core/runtime";
import {
  createIdentity,
  identityMigrations,
  identityResolvers,
  requireDelegate,
  requireIdentityAccess,
  type ClientRegistration,
  type Identity,
} from "./identity";
import {
  createDelivery,
  deliveryMigrations,
  deliveryResetOwner,
  deliveryResolvers,
  provisionAppWebhook,
  type Delivery,
} from "./delivery";
import { createGraphQLHandler } from "./graphql/http";
import {
  deliveredOperations,
  featureOperations,
  featureRoots,
  supportingRoots,
} from "./graphql/contract";
import { supportingResolvers } from "./workspace/supporting";
import { Workspace } from "./workspace/entities";
import {
  RepositorySuggestions,
  repositorySuggestionMigrations,
  repositorySuggestionsResetOwner,
} from "./workspace/repositories";
import { workspaceEntityMigrations, workspaceEntityResetOwner } from "./workspace/entity-schema";
import {
  workspaceEntityResolvers,
  workspaceEntityRoots,
  workspaceEntityOperations,
} from "./workspace/entity-resolvers";
import { fixtureApiKeys } from "./identity/fixture";
import {
  agentMigrations,
  agentsResetOwner,
  createAgents,
  agentsResolvers,
  agentsRoots,
  agentsOperations,
  type Agents,
} from "./workspace/agents";
import { startServer, type HttpHandler } from "./server";

export interface ApplicationOptions {
  databasePath: string;
  hostname?: string;
  port?: number;
  controlToken?: string;
  clockSource?: () => number;
  clients?: readonly ClientRegistration[];
}

export interface Application {
  readonly url: URL;
  readonly runtime: Runtime;
  readonly identity: Identity;
  readonly delivery: Delivery;
  readonly workspace: Workspace;
  readonly agents: Agents;
  drain(): Promise<void>;
  advance(milliseconds: number): Promise<number>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createApplication(options: ApplicationOptions): Promise<Application> {
  const runtime = createRuntime({
    databasePath: options.databasePath,
    clockSource: options.clockSource,
    migrations: [
      identityMigrations,
      workspaceEntityMigrations,
      agentMigrations,
      repositorySuggestionMigrations,
      deliveryMigrations,
    ],
  });
  let identity: Identity;
  const resetOwners = [] as import("./core/runtime").ResetOwner[];
  try {
    identity = createIdentity(runtime, { clients: options.clients, provisionAppWebhook });
    resetOwners.push(
      identity.resetOwner,
      workspaceEntityResetOwner,
      repositorySuggestionsResetOwner,
      agentsResetOwner,
      deliveryResetOwner,
    );
    if (!runtime.database.query("SELECT id FROM organizations LIMIT 1").get())
      resetRuntime(runtime, resetOwners);
  } catch (error) {
    runtime.close();
    throw error;
  }
  let agents: Agents;
  const workspace = new Workspace(runtime, {
    requireAccess: requireIdentityAccess,
    requireDelegate,
    onDelegated: (...args) => agents.onDelegated(...args),
  });
  agents = createAgents(runtime, workspace, identity);
  const repositories = new RepositorySuggestions(runtime, workspace, agents);
  const delivery = createDelivery(runtime);
  let server: ReturnType<typeof startServer>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let activeRequests = 0;
  let paused = false;
  async function exclusively<T>(work: () => T | Promise<T>): Promise<T> {
    paused = true;
    try {
      while (activeRequests) await Bun.sleep(1);
      return await work();
    } finally {
      paused = false;
    }
  }

  function serialize<T>(work: () => T | Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new DomainError("CONFLICT", "Application is closing"));
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  }

  async function advance(milliseconds: number) {
    const now = runtime.clock.now();
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      !Number.isSafeInteger(now + milliseconds)
    )
      throw new DomainError("INVALID_INPUT", "Clock advance must be a nonnegative safe integer");
    const target = now + milliseconds;
    await delivery.runDue();
    for (;;) {
      const due = delivery.nextDueAt();
      if (due === null || due > target) break;
      runtime.clock.advance(Math.max(0, due - runtime.clock.now()));
      await delivery.runDue();
    }
    runtime.clock.advance(Math.max(0, target - runtime.clock.now()));
    await delivery.runDue();
    return runtime.clock.now();
  }

  const control: HttpHandler = async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__test/")) return null;
    if (!options.controlToken) return Response.json({ error: "not_found" }, { status: 404 });
    const expected = Buffer.from(`Bearer ${options.controlToken}`);
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return errorResponse(new DomainError("UNAUTHENTICATED", "Control token required"));
    if (url.pathname === "/__test/clock" && request.method === "GET")
      return Response.json({ now: runtime.clock.now() });
    if (url.pathname === "/__test/deliveries" && request.method === "GET")
      return Response.json({ deliveries: delivery.deliveries() });
    if (url.pathname === "/__test/attempts" && request.method === "GET")
      return Response.json({
        attempts: delivery.attempts(url.searchParams.get("deliveryId") ?? undefined),
      });
    if (url.pathname === "/__test/drain" && request.method === "POST") {
      await delivery.runDue();
      return Response.json({ success: true });
    }
    if (url.pathname === "/__test/reset" && request.method === "POST") {
      resetRuntime(runtime, resetOwners);
      return Response.json({ success: true });
    }
    if (url.pathname === "/__test/repository-suggestions" && request.method === "POST") {
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        throw new DomainError("INVALID_INPUT", "Invalid JSON body");
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new DomainError("INVALID_INPUT", "Expected object");
      const values = input as Record<string, unknown>;
      if (Object.keys(values).some((key) => !["fixture", "issueId", "suggestions"].includes(key)))
        throw new DomainError("INVALID_INPUT", "Unsupported repository control field");
      const fixture = values.fixture ?? "primary";
      if (fixture !== "primary" && fixture !== "secondary")
        throw new DomainError("INVALID_INPUT", "Unknown fixture human");
      if (typeof values.issueId !== "string" || !values.issueId.trim())
        throw new DomainError("INVALID_INPUT", "Expected issueId");
      const human = identity.authenticate(
        new Request("http://localhost/graphql", {
          headers: { authorization: fixtureApiKeys[fixture] },
        }),
      );
      repositories.configure(human, values.issueId, values.suggestions);
      return Response.json({ success: true });
    }
    if (url.pathname.startsWith("/__test/agents/") && request.method === "POST") {
      const action = url.pathname.slice("/__test/agents/".length);
      const allowed: Record<string, readonly string[]> = {
        delegate: ["fixture", "issueId", "appUserId"],
        mention: ["fixture", "issueId", "appUserId", "commentId"],
        prompt: ["fixture", "sessionId", "body"],
        stop: ["fixture", "sessionId", "body"],
      };
      if (!Object.hasOwn(allowed, action))
        return Response.json({ error: "not_found" }, { status: 404 });
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        throw new DomainError("INVALID_INPUT", "Invalid JSON body");
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new DomainError("INVALID_INPUT", "Expected object");
      const values = input as Record<string, unknown>;
      if (Object.keys(values).some((key) => !allowed[action]!.includes(key)))
        throw new DomainError("INVALID_INPUT", "Unsupported agent control field");
      const fixture = values.fixture ?? "primary";
      if (fixture !== "primary" && fixture !== "secondary")
        throw new DomainError("INVALID_INPUT", "Unknown fixture human");
      const human = identity.authenticate(
        new Request("http://localhost/graphql", {
          headers: { authorization: fixtureApiKeys[fixture] },
        }),
      );
      function text(name: string) {
        const value = values[name];
        if (typeof value !== "string" || !value.trim())
          throw new DomainError("INVALID_INPUT", `${name} must be nonempty text`);
        return value;
      }
      const result =
        action === "delegate"
          ? agents.delegate(human, text("issueId"), text("appUserId"))
          : action === "mention"
            ? agents.mention(
                human,
                text("issueId"),
                text("appUserId"),
                values.commentId === undefined ? undefined : text("commentId"),
              )
            : action === "prompt"
              ? agents.prompt(human, text("sessionId"), text("body"))
              : agents.stop(
                  human,
                  text("sessionId"),
                  values.body === undefined ? undefined : text("body"),
                );
      return Response.json(result);
    }
    if (url.pathname === "/__test/clock/advance" && request.method === "POST") {
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        throw new DomainError("INVALID_INPUT", "Invalid JSON body");
      }
      if (
        !input ||
        typeof input !== "object" ||
        !("milliseconds" in input) ||
        typeof input.milliseconds !== "number"
      )
        throw new DomainError("INVALID_INPUT", "milliseconds is required");
      return Response.json({ now: await advance(input.milliseconds) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  try {
    const graphql = await createGraphQLHandler(runtime, {
      authenticate: identity.authenticate,
      resolverMaps: [
        {
          Query: {
            issueRepositorySuggestions: (_source, args, { principal }) =>
              repositories.query(
                principal,
                String(args.issueId),
                args.candidateRepositories,
                args.agentSessionId as string | null | undefined,
              ),
          },
        },
        supportingResolvers(),
        identityResolvers(),
        workspaceEntityResolvers(workspace),
        agentsResolvers(agents),
        deliveryResolvers(),
      ],
      roots: {
        query: [
          "issueRepositorySuggestions",
          ...supportingRoots,
          ...workspaceEntityRoots,
          ...agentsRoots.query,
          ...featureRoots.webhook.query,
        ],
        mutation: [
          ...Object.keys(workspaceEntityResolvers(workspace).Mutation!),
          ...agentsRoots.mutation,
          ...featureRoots.webhook.mutation,
        ],
      },
      operations: [
        ...deliveredOperations,
        ...workspaceEntityOperations,
        ...agentsOperations,
        ...featureOperations.webhook,
      ],
    });
    server = startServer({
      hostname: options.hostname,
      port: options.port,
      handlers: [
        async (request) => {
          try {
            if (closing || paused) return Response.json({ error: "unavailable" }, { status: 503 });
            if (new URL(request.url).pathname.startsWith("/__test/")) {
              return await serialize(() => exclusively(() => control(request)));
            }
            activeRequests++;
            try {
              return (await identity.handler(request)) ?? (await graphql(request));
            } finally {
              activeRequests--;
            }
          } catch (error) {
            return errorResponse(error);
          }
        },
      ],
    });
  } catch (error) {
    await delivery.close();
    runtime.close();
    throw error;
  }

  function schedule() {
    if (closing) return;
    timer = setTimeout(() => {
      timer = undefined;
      void serialize(() => delivery.runDue())
        .catch(() => {
          console.error("Delivery scheduler failed");
        })
        .finally(schedule);
    }, 50);
  }
  schedule();
  return {
    url: server.url,
    runtime,
    identity,
    delivery,
    workspace,
    agents,
    drain: () => serialize(() => delivery.runDue()),
    advance: (milliseconds) => serialize(() => exclusively(() => advance(milliseconds))),
    reset: () => serialize(() => exclusively(() => resetRuntime(runtime, resetOwners))),
    close() {
      closePromise ??= (async () => {
        closing = true;
        if (timer !== undefined) clearTimeout(timer);
        server.stop(false);
        await queue;
        while (activeRequests) await Bun.sleep(1);
        await delivery.close();
        runtime.close();
      })();
      return closePromise;
    },
  };
}
