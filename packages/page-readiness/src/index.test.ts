import { describe, expect, it } from "vitest";
import {
  PAGE_READINESS_API_VERSION,
  parseReadinessContract,
  type ReadinessContract
} from "./index.js";

const contract: ReadinessContract = {
  apiVersion: PAGE_READINESS_API_VERSION,
  kind: "ReadinessContract",
  metadata: {
    id: "chanmama.product.assets-ready",
    version: "1.0.0"
  },
  mode: "all",
  signals: [
    {
      kind: "target-present",
      semanticTargetId: "product.detail",
      minimumCount: 1
    },
    { kind: "dom-quiet", quietWindowMs: 500 },
    {
      kind: "network-quiet",
      quietWindowMs: 750,
      maximumInflightRequests: 0
    },
    {
      kind: "asset-count-stable",
      semanticCollectionId: "product.gallery-assets",
      minimumCount: 1,
      consecutiveSamples: 3,
      sampleIntervalMs: 400
    }
  ],
  limits: {
    timeoutMs: 30_000,
    refresh: {
      maximumAttempts: 1,
      cooldownMs: 1_000
    }
  }
};

describe("page readiness contract", () => {
  it("accepts semantic signals and bounded recovery", () => {
    expect(parseReadinessContract(contract)).toEqual(contract);
  });

  it.each([
    {
      label: "selector",
      value: {
        ...contract,
        signals: [
          {
            kind: "target-present",
            semanticTargetId: "product.detail",
            minimumCount: 1,
            selector: "#detail"
          }
        ]
      }
    },
    {
      label: "XPath encoded as a semantic target",
      value: {
        ...contract,
        signals: [
          {
            kind: "target-present",
            semanticTargetId: "//div[@id='detail']",
            minimumCount: 1
          }
        ]
      }
    },
    {
      label: "script",
      value: { ...contract, script: "return document.body" }
    },
    {
      label: "coordinate",
      value: { ...contract, coordinate: { x: 10, y: 20 } }
    }
  ])("rejects forbidden locator surface: $label", ({ value }) => {
    expect(() => parseReadinessContract(value)).toThrow(/Malformed/);
  });

  it("requires a semantic target before quiet or stability can be ready", () => {
    expect(() =>
      parseReadinessContract({
        ...contract,
        signals: [{ kind: "dom-quiet", quietWindowMs: 500 }]
      })
    ).toThrow(/Malformed/);
  });

  it("does not allow an initial zero asset scan to satisfy stability", () => {
    expect(() =>
      parseReadinessContract({
        ...contract,
        signals: contract.signals.map((signal) =>
          signal.kind === "asset-count-stable"
            ? { ...signal, minimumCount: 0 }
            : signal
        )
      })
    ).toThrow(/Malformed/);
  });

  it("bounds timeout, refresh and sampling", () => {
    expect(() =>
      parseReadinessContract({
        ...contract,
        limits: { ...contract.limits, timeoutMs: 300_001 }
      })
    ).toThrow(/Malformed/);
    expect(() =>
      parseReadinessContract({
        ...contract,
        limits: {
          ...contract.limits,
          refresh: { maximumAttempts: 4, cooldownMs: 1_000 }
        }
      })
    ).toThrow(/Malformed/);
    expect(() =>
      parseReadinessContract({
        ...contract,
        signals: contract.signals.map((signal) =>
          signal.kind === "asset-count-stable"
            ? { ...signal, consecutiveSamples: 1 }
            : signal
        )
      })
    ).toThrow(/Malformed/);
  });

  it("rejects unknown signals, duplicate surface fields and invalid identity", () => {
    expect(() =>
      parseReadinessContract({
        ...contract,
        metadata: { ...contract.metadata, version: "latest" }
      })
    ).toThrow(/Malformed/);
    expect(() =>
      parseReadinessContract({
        ...contract,
        signals: [
          ...contract.signals,
          { kind: "javascript", source: "true" }
        ]
      })
    ).toThrow(/Malformed/);
  });
});
