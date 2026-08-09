export interface NativeConnectionSupervisorOptions {
  readonly onReconnect: () => void;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelScheduled?: (handle: unknown) => void;
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
}

export interface NativeConnectionSupervisorState {
  readonly phase: "idle" | "connecting" | "connected" | "waiting" | "stopped";
  readonly generation: number;
  readonly consecutiveFailures: number;
  readonly scheduled: boolean;
}

/**
 * Owns the single Native Host connection generation and its bounded retry
 * schedule. Browser Port callbacks must carry the generation they were
 * created under so stale ports cannot mutate the current connection.
 */
export class NativeConnectionSupervisor {
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  readonly #initialDelayMs: number;
  readonly #maximumDelayMs: number;
  #phase: NativeConnectionSupervisorState["phase"] = "idle";
  #generation = 0;
  #consecutiveFailures = 0;
  #scheduled: unknown;

  constructor(readonly options: NativeConnectionSupervisorOptions) {
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#initialDelayMs = options.initialDelayMs ?? 2_000;
    this.#maximumDelayMs = options.maximumDelayMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#initialDelayMs) ||
      this.#initialDelayMs < 100 ||
      !Number.isSafeInteger(this.#maximumDelayMs) ||
      this.#maximumDelayMs < this.#initialDelayMs
    ) {
      throw new Error("Native connection retry bounds are invalid");
    }
  }

  begin(): number | undefined {
    if (this.#phase !== "idle") return undefined;
    this.#phase = "connecting";
    this.#generation += 1;
    return this.#generation;
  }

  connected(generation: number): boolean {
    if (!this.#isCurrent(generation) || this.#phase !== "connecting") {
      return false;
    }
    this.#phase = "connected";
    return true;
  }

  connecting(generation: number): boolean {
    return this.#isCurrent(generation) && this.#phase === "connecting";
  }

  ready(generation: number): boolean {
    if (!this.#isCurrent(generation) || this.#phase !== "connected") {
      return false;
    }
    this.#consecutiveFailures = 0;
    return true;
  }

  failed(generation: number): number | undefined {
    if (
      !this.#isCurrent(generation) ||
      (this.#phase !== "connecting" && this.#phase !== "connected")
    ) {
      return undefined;
    }
    return this.#scheduleReconnect();
  }

  disconnected(generation: number): number | undefined {
    return this.failed(generation);
  }

  accepts(generation: number): boolean {
    return this.#isCurrent(generation) && this.#phase === "connected";
  }

  stop(): void {
    if (this.#scheduled !== undefined) {
      this.#cancelScheduled(this.#scheduled);
      this.#scheduled = undefined;
    }
    this.#generation += 1;
    this.#phase = "stopped";
  }

  state(): NativeConnectionSupervisorState {
    return {
      phase: this.#phase,
      generation: this.#generation,
      consecutiveFailures: this.#consecutiveFailures,
      scheduled: this.#scheduled !== undefined
    };
  }

  #isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  #scheduleReconnect(): number {
    const delayMs = Math.min(
      this.#maximumDelayMs,
      this.#initialDelayMs * 2 ** this.#consecutiveFailures
    );
    this.#consecutiveFailures += 1;
    this.#phase = "waiting";
    this.#scheduled = this.#schedule(() => {
      if (this.#phase !== "waiting") return;
      this.#scheduled = undefined;
      this.#phase = "idle";
      this.options.onReconnect();
    }, delayMs);
    return delayMs;
  }
}
