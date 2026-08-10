import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RuntimeProviderRegistry,
  type RuntimeInvocation
} from "@bpa/node-runtime";
import {
  registerTeamRuntimeProvider,
  TeamRuntimeProvider,
  TeamWorkerClient
} from "./index.js";

const codeDigest = `sha256:${"a".repeat(64)}`;
const nodeDigest = `sha256:${"b".repeat(64)}`;
const handlerRef = "test.handler@1.0.0";
const fixture = fileURLToPath(
  new URL("./fixtures/team-worker-fixture.mjs", import.meta.url)
);

function options(overrides: Record<string, string | undefined> = {}) {
  return {
    process: {
      command: process.execPath,
      args: [fixture],
      env: {
        TEAM_FIXTURE_HANDLERS: JSON.stringify([handlerRef]),
        ...overrides
      }
    },
    expectedCodeDigest: codeDigest,
    expectedHandlerRefs: [handlerRef],
    helloTimeoutMs: 1_000
  };
}

function invocation(
  invocationId: string,
  deadlineMs = 1_000
): RuntimeInvocation {
  return {
    invocationId,
    identity: {
      runId: "run-1",
      scopePath: [],
      iterationKey: "root",
      stepKey: "match",
      attempt: 1
    },
    node: {
      kind: "node",
      id: "test.handler",
      version: "1.0.0",
      digest: nodeDigest
    },
    providerId: "team",
    input: {},
    permissionSnapshot: {
      riskLevel: "R0",
      permissions: [],
      domains: []
    },
    deadlineAt: Date.now() + deadlineMs,
    idempotencyKey: `idempotency-${invocationId}`,
    fencingToken: 1,
    traceId: `trace-${invocationId}`
  };
}

describe("Team Runtime Provider process lifecycle", () => {
  it("requires an absolute Worker executable", () => {
    expect(
      () =>
        new TeamWorkerClient({
          process: { command: "node", args: [] },
          expectedCodeDigest: codeDigest,
          expectedHandlerRefs: [handlerRef]
        })
    ).toThrow(/absolute path/);
  });

  it("registers provider id team with an exact node@version whitelist", () => {
    const registry = new RuntimeProviderRegistry();
    const provider = registerTeamRuntimeProvider(registry, options());
    expect(registry.list()).toEqual(["team"]);
    expect(registry.resolve("team", invocation("known").node)).toBe(provider);
    expect(() =>
      registry.resolve("team", {
        ...invocation("unknown").node,
        version: "2.0.0"
      })
    ).toThrow(/does not support/);
    provider.dispose();
  });

  it("reports the exact child PID and lifecycle without exposing process input", async () => {
    const client = new TeamWorkerClient(options());
    expect(client.status()).toEqual({
      state: "stopped",
      pid: null,
      pendingInvocationCount: 0
    });
    await client.start();
    expect(client.status()).toMatchObject({
      state: "ready",
      pendingInvocationCount: 0
    });
    expect(client.status().pid).toEqual(expect.any(Number));
    expect(client.status().pid).toBeGreaterThan(0);
    client.stop();
    expect(client.status()).toEqual({
      state: "stopped",
      pid: null,
      pendingInvocationCount: 0
    });
  });

  it("settles a crash and restarts on the next invocation", async () => {
    const provider = new TeamRuntimeProvider(
      new TeamWorkerClient(options())
    );
    await expect(
      provider.invoke(invocation("crash-first"), new AbortController().signal)
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "TEAM_WORKER_CRASHED", retryable: true }
    });
    await expect(
      provider.invoke(
        invocation("success-after-restart"),
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      status: "succeeded",
      output: { requestId: "success-after-restart" }
    });
    provider.dispose();
  });

  it("times out and cancels pending child-process invocations", async () => {
    const provider = new TeamRuntimeProvider(
      new TeamWorkerClient(options())
    );
    await expect(
      provider.invoke(invocation("hang-timeout", 20), new AbortController().signal)
    ).resolves.toMatchObject({
      status: "timed_out",
      error: { code: "TEAM_HANDLER_TIMEOUT" }
    });

    const controller = new AbortController();
    const pending = provider.invoke(invocation("hang-cancel"), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "TEAM_HANDLER_CANCELLED" }
    });
    provider.dispose();
  });

  it("rejects mismatched worker code digests", async () => {
    const provider = new TeamRuntimeProvider(
      new TeamWorkerClient(
        options({
          TEAM_FIXTURE_DIGEST_OVERRIDE: `sha256:${"c".repeat(64)}`
        })
      )
    );
    await expect(
      provider.invoke(
        invocation("digest-mismatch"),
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "TEAM_WORKER_DIGEST_MISMATCH",
        retryable: false
      }
    });
    provider.dispose();
  });

  it("settles malformed worker frames as protocol failures", async () => {
    const provider = new TeamRuntimeProvider(
      new TeamWorkerClient(
        options({ TEAM_FIXTURE_MALFORMED: "1" })
      )
    );
    await expect(
      provider.invoke(invocation("malformed"), new AbortController().signal)
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "FRAME_LENGTH_INVALID",
        retryable: false
      }
    });
    provider.dispose();
  });
});
