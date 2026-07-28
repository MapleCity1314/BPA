import {
  validateDoudianEditorTarget,
  validateDoudianScopeRestoreTarget
} from "@bpa/adapter-doudian";

export type NavigationTargetResult =
  | {
      readonly valid: true;
      readonly executionUrl: string;
      readonly navigate: boolean;
    }
  | {
      readonly valid: false;
      readonly reason:
        | "PAGE_URL_INVALID"
        | "EDITOR_TARGET_INVALID"
        | "SCOPE_RESTORE_TARGET_INVALID";
    };

function recordInput(
  value: unknown
): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * Resolves the only two reviewed navigations. Scope restore is deliberately
 * constrained to the current tab's origin and the exact `/ffa/g/list` path.
 */
export function resolveNavigationTarget(input: {
  readonly nodeId: string;
  readonly payloadInput: unknown;
  readonly currentUrl: string;
}): NavigationTargetResult {
  let current: URL;
  try {
    current = new URL(input.currentUrl);
  } catch {
    return { valid: false, reason: "PAGE_URL_INVALID" };
  }
  if (/login|passport|signin|authorize/iu.test(current.pathname)) {
    return { valid: false, reason: "PAGE_URL_INVALID" };
  }
  const payload = recordInput(input.payloadInput);
  try {
    const executionUrl =
      input.nodeId === "doudian.product.editor.open"
        ? validateDoudianEditorTarget(payload).editUrl
        : input.nodeId === "doudian.product.scope.restore"
          ? validateDoudianScopeRestoreTarget(payload, current.href).listUrl
          : current.href;
    return {
      valid: true,
      executionUrl,
      navigate:
        (input.nodeId === "doudian.product.editor.open" ||
          input.nodeId === "doudian.product.scope.restore") &&
        executionUrl !== current.href
    };
  } catch (error) {
    return {
      valid: false,
      reason:
        input.nodeId === "doudian.product.scope.restore"
          ? "SCOPE_RESTORE_TARGET_INVALID"
          : "EDITOR_TARGET_INVALID"
    };
  }
}
