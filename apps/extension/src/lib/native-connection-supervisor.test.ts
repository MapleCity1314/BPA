import { describe, expect, it } from "vitest";
import { NativeConnectionSupervisor } from "./native-connection-supervisor";

function fixture() {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const cancelled: unknown[] = [];
  let reconnects = 0;
  const supervisor = new NativeConnectionSupervisor({
    onReconnect: () => {
      reconnects += 1;
    },
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs };
      scheduled.push(handle);
      return handle;
    },
    cancelScheduled: (handle) => {
      cancelled.push(handle);
    },
    initialDelayMs: 2_000,
    maximumDelayMs: 8_000
  });
  return {
    supervisor,
    scheduled,
    cancelled,
    reconnects: () => reconnects
  };
}

describe("NativeConnectionSupervisor", () => {
  it("allows one in-flight connection and applies bounded backoff", () => {
    const state = fixture();
    const first = state.supervisor.begin()!;
    expect(state.supervisor.begin()).toBeUndefined();
    expect(state.supervisor.failed(first)).toBe(2_000);
    expect(state.supervisor.failed(first)).toBeUndefined();
    state.scheduled[0]!.callback();
    expect(state.reconnects()).toBe(1);

    const second = state.supervisor.begin()!;
    expect(state.supervisor.failed(second)).toBe(4_000);
    state.scheduled[1]!.callback();
    const third = state.supervisor.begin()!;
    expect(state.supervisor.failed(third)).toBe(8_000);
    state.scheduled[2]!.callback();
    const fourth = state.supervisor.begin()!;
    expect(state.supervisor.failed(fourth)).toBe(8_000);
  });

  it("isolates stale Port callbacks and resets backoff only after ready", () => {
    const state = fixture();
    const first = state.supervisor.begin()!;
    expect(state.supervisor.connected(first)).toBe(true);
    expect(state.supervisor.disconnected(first)).toBe(2_000);
    state.scheduled[0]!.callback();
    const second = state.supervisor.begin()!;
    expect(state.supervisor.connected(second)).toBe(true);

    expect(state.supervisor.accepts(first)).toBe(false);
    expect(state.supervisor.disconnected(first)).toBeUndefined();
    expect(state.supervisor.ready(second)).toBe(true);
    expect(state.supervisor.disconnected(second)).toBe(2_000);
  });

  it("cancels a scheduled retry and invalidates its generation on stop", () => {
    const state = fixture();
    const generation = state.supervisor.begin()!;
    state.supervisor.failed(generation);
    const pending = state.scheduled[0]!;

    state.supervisor.stop();
    pending.callback();

    expect(state.cancelled).toEqual([pending]);
    expect(state.reconnects()).toBe(0);
    expect(state.supervisor.accepts(generation)).toBe(false);
    expect(state.supervisor.begin()).toBeUndefined();
    expect(state.supervisor.state()).toMatchObject({
      phase: "stopped",
      scheduled: false
    });
  });
});
