import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  negotiateControlHello,
  parseControlHelloRequest,
  parseControlHelloResponse
} from "@bpa/control-protocol";
import { parseReadinessContract } from "@bpa/page-readiness";

function example(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../docs/protocols/examples/${name}`, import.meta.url),
      "utf8"
    )
  );
}

describe("v0.5 protocol review examples", () => {
  it("keeps the Control Hello example internally consistent", () => {
    const messages = example("control-hello-v1.example.json") as Record<
      string,
      unknown
    >;
    const hello = parseControlHelloRequest(messages.hello);
    expect(parseControlHelloResponse(messages.welcome)).toMatchObject({
      kind: "welcome",
      requestId: hello.requestId
    });
    expect(parseControlHelloResponse(messages.incompatible)).toMatchObject({
      kind: "error",
      connection: "close"
    });
    expect(
      negotiateControlHello(hello, {
        supportedApplicationProtocols: ["bpa.control/1"],
        runtime: { name: "bpa-core", version: "0.4.0" },
        maxFrameBytes: 512 * 1024,
        features: ["evidence_refs", "resource_bindings"]
      })
    ).toEqual(messages.welcome);
  });

  it("parses the reviewed semantic Page Readiness example", () => {
    expect(
      parseReadinessContract(
        example("page-readiness-v1alpha1.example.json")
      )
    ).toMatchObject({
      apiVersion: "bpa.page-readiness/v1alpha1",
      kind: "ReadinessContract",
      mode: "all"
    });
  });
});
