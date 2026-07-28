import type { BridgeCapability } from "@bpa/browser-bridge";

export const BROWSER_PROTOCOL = "bpa.browser/1";
export const DOUDIAN_ADAPTER_VERSION = "1.1.0";
export const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";

export type ExtensionNodeId =
  | "doudian.shop.context.read"
  | "doudian.product.scope.collect"
  | "doudian.product.editor.open"
  | "doudian.editor.priority-items.inspect";

export interface ExtensionCapability {
  readonly nodeId: ExtensionNodeId;
  readonly versions: readonly string[];
  readonly riskLevel: "R0";
  readonly permissions: readonly string[];
  readonly origin: typeof DOUDIAN_ORIGIN;
  readonly pathname: "/ffa/g/list" | "/ffa/g/create";
}

const READ_ONLY_PERMISSIONS = [
  "browser.dom.read",
  "browser.tabs.read"
] as const;

export const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = [
  {
    nodeId: "doudian.shop.context.read",
    versions: ["1.0.0", "1.1.0", "1.2.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    origin: DOUDIAN_ORIGIN,
    pathname: "/ffa/g/list"
  },
  {
    nodeId: "doudian.product.scope.collect",
    versions: ["1.0.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    origin: DOUDIAN_ORIGIN,
    pathname: "/ffa/g/list"
  },
  {
    nodeId: "doudian.product.editor.open",
    versions: ["1.0.0"],
    riskLevel: "R0",
    permissions: [
      "browser.dom.read",
      "browser.tabs.read",
      "browser.tabs.navigate"
    ],
    origin: DOUDIAN_ORIGIN,
    pathname: "/ffa/g/create"
  },
  {
    nodeId: "doudian.editor.priority-items.inspect",
    versions: ["1.0.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    origin: DOUDIAN_ORIGIN,
    pathname: "/ffa/g/create"
  }
];

/**
 * Digest of the canonical public projection in `capabilityReport`.
 * Updating a capability requires updating this value and its fixture test.
 */
export const CAPABILITY_MANIFEST_DIGEST =
  "sha256:46b9dd94f854528a4c28b5709c68e614d959c65057120a48cc35c6bd3e9519b3";

export function capabilityReport(): {
  capabilities: Array<{
    node_id: ExtensionNodeId;
    versions: string[];
    risk_level: "R0";
    permissions: string[];
    adapter_id: "doudian";
    adapter_version: typeof DOUDIAN_ADAPTER_VERSION;
  }>;
  manifest_digest: typeof CAPABILITY_MANIFEST_DIGEST;
} {
  return {
    capabilities: EXTENSION_CAPABILITIES.map((capability) => ({
      node_id: capability.nodeId,
      versions: [...capability.versions],
      risk_level: capability.riskLevel,
      permissions: [...capability.permissions],
      adapter_id: "doudian",
      adapter_version: DOUDIAN_ADAPTER_VERSION
    })),
    manifest_digest: CAPABILITY_MANIFEST_DIGEST
  };
}

export type CapabilityRouteResult =
  | {
      readonly valid: true;
      readonly capability: ExtensionCapability;
      readonly url: URL;
    }
  | {
      readonly valid: false;
      readonly reason:
        | "UNKNOWN_ACTION"
        | "UNSUPPORTED_NODE_VERSION"
        | "PAGE_URL_INVALID"
        | "PAGE_ORIGIN_MISMATCH"
        | "PAGE_PATH_MISMATCH"
        | "PERMISSION_MISMATCH";
    };

export function resolveCapability(
  nodeId: string,
  nodeVersion: string
): ExtensionCapability | undefined {
  const capability = EXTENSION_CAPABILITIES.find(
    (candidate) => candidate.nodeId === nodeId
  );
  return capability?.versions.includes(nodeVersion)
    ? capability
    : undefined;
}

export function validateCapabilityRoute(input: {
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly currentUrl: string;
  readonly grantedPermissions: readonly string[];
}): CapabilityRouteResult {
  const knownNode = EXTENSION_CAPABILITIES.find(
    (candidate) => candidate.nodeId === input.nodeId
  );
  if (!knownNode) return { valid: false, reason: "UNKNOWN_ACTION" };
  if (!knownNode.versions.includes(input.nodeVersion)) {
    return { valid: false, reason: "UNSUPPORTED_NODE_VERSION" };
  }
  let url: URL;
  try {
    url = new URL(input.currentUrl);
  } catch {
    return { valid: false, reason: "PAGE_URL_INVALID" };
  }
  if (url.origin !== knownNode.origin) {
    return { valid: false, reason: "PAGE_ORIGIN_MISMATCH" };
  }
  if (url.pathname !== knownNode.pathname) {
    return { valid: false, reason: "PAGE_PATH_MISMATCH" };
  }
  if (
    knownNode.permissions.some(
      (permission) => !input.grantedPermissions.includes(permission)
    )
  ) {
    return { valid: false, reason: "PERMISSION_MISMATCH" };
  }
  return { valid: true, capability: knownNode, url };
}

const PAGE_EPOCH_PATTERN =
  /^tab-(?<tabId>\d+):(?<timestamp>\d{10,16}):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export function validPageEpoch(
  pageEpoch: unknown,
  expectedTabId?: number
): pageEpoch is string {
  if (typeof pageEpoch !== "string") return false;
  const matched = pageEpoch.match(PAGE_EPOCH_PATTERN);
  if (!matched?.groups) return false;
  const tabId = Number(matched.groups.tabId);
  const timestamp = Number(matched.groups.timestamp);
  return (
    Number.isSafeInteger(tabId) &&
    tabId >= 0 &&
    Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    (expectedTabId === undefined || tabId === expectedTabId)
  );
}

export function bridgeCapabilityFor(
  nodeId: string,
  nodeVersion: string
): BridgeCapability {
  const capability = resolveCapability(nodeId, nodeVersion);
  return {
    nodeId,
    nodeVersion: capability ? nodeVersion : "unsupported",
    riskLevel: capability?.riskLevel ?? "unsupported",
    permissions: capability ? [...capability.permissions] : []
  };
}
