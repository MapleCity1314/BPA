import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  exportPublicKeySpkiBase64,
  signPermissionGrant
} from "@bpa/gateway-core";
import { verifyCommandAuthorization } from "./index.js";

describe("browser bridge authorization", () => {
  it("verifies the Core signature and every command binding", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const grant = signPermissionGrant(
      {
        grant_id: "grant-1",
        permissions: ["browser.dom.read"],
        domains: ["https://fxg.jinritemai.com"],
        risk_level: "R0",
        expires_at: "2026-07-28T00:00:00.000Z",
        run_id: "run-1",
        node_execution_id: "execution-1",
        node_id: "doudian.shop.context.read",
        node_version: "1.0.0",
        fencing_token: 1
      },
      "core-key",
      privateKey
    );
    const base = {
      command: {
        run_id: "run-1",
        node_execution_id: "execution-1",
        fencing_token: 1,
        node: {
          id: "doudian.shop.context.read",
          version: "1.0.0"
        },
        permission_grant: grant,
        deadline: "2026-07-28T00:00:00.000Z"
      },
      publicKeySpkiBase64: exportPublicKeySpkiBase64(publicKey),
      keyId: "core-key",
      capability: {
        nodeId: "doudian.shop.context.read",
        nodeVersion: "1.0.0",
        riskLevel: "R0",
        permissions: ["browser.dom.read"]
      },
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
      at: new Date("2026-07-27T00:00:00.000Z")
    };
    await expect(verifyCommandAuthorization(base)).resolves.toEqual({
      valid: true
    });
    await expect(
      verifyCommandAuthorization({
        ...base,
        command: { ...base.command, fencing_token: 2 }
      })
    ).resolves.toEqual({
      valid: false,
      reason: "GRANT_COMMAND_BINDING_MISMATCH"
    });
    await expect(
      verifyCommandAuthorization({
        ...base,
        currentUrl: "https://example.com/ffa/g/list"
      })
    ).resolves.toEqual({
      valid: false,
      reason: "PAGE_ORIGIN_NOT_GRANTED"
    });
  });
});
