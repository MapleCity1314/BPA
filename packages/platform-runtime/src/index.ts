import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SupportedDesktopPlatform = "darwin" | "win32";
export type LocalIpcChannel = "core" | "staging";

export interface DesktopPathEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly localAppData?: string;
  readonly bpaHome?: string;
}

function supportedPlatform(
  platform: NodeJS.Platform
): SupportedDesktopPlatform {
  if (platform === "darwin" || platform === "win32") return platform;
  throw new Error(`BPA desktop runtime does not support ${platform}`);
}

export function resolveDefaultBpaHome(
  environment: DesktopPathEnvironment = {}
): string {
  if (environment.bpaHome?.trim()) {
    return resolve(environment.bpaHome.trim());
  }
  const platform = supportedPlatform(environment.platform ?? process.platform);
  const homeDirectory = environment.homeDirectory ?? homedir();
  if (platform === "win32") {
    const localAppData =
      environment.localAppData ?? process.env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is required by the BPA Windows runtime");
    }
    return resolve(localAppData, "BPA");
  }
  return resolve(homeDirectory, "Library", "Application Support", "BPA");
}

export function resolveDefaultBpaLogRoot(
  environment: DesktopPathEnvironment = {}
): string {
  const platform = supportedPlatform(environment.platform ?? process.platform);
  if (platform === "win32") {
    return join(resolveDefaultBpaHome(environment), "logs");
  }
  return resolve(
    environment.homeDirectory ?? homedir(),
    "Library",
    "Logs",
    "BPA"
  );
}

export function resolveLocalIpcEndpoint(
  root: string,
  channel: LocalIpcChannel,
  platform: NodeJS.Platform = process.platform
): string {
  const supported = supportedPlatform(platform);
  if (supported === "darwin") {
    return join(resolve(root), "run", `${channel}.sock`);
  }
  const identity = createHash("sha256")
    .update(resolve(root).toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `\\\\.\\pipe\\bpa-${identity}-${channel}`;
}

export function isWindowsNamedPipe(endpoint: string): boolean {
  return /^\\\\\.\\pipe\\/iu.test(endpoint);
}
