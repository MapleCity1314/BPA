import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

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

function pathsFor(platform: SupportedDesktopPlatform) {
  return platform === "win32" ? win32 : posix;
}

export function resolveDefaultBpaHome(
  environment: DesktopPathEnvironment = {}
): string {
  const platform = supportedPlatform(environment.platform ?? process.platform);
  const paths = pathsFor(platform);
  if (environment.bpaHome?.trim()) {
    return paths.resolve(environment.bpaHome.trim());
  }
  const homeDirectory = environment.homeDirectory ?? homedir();
  if (platform === "win32") {
    const localAppData =
      environment.localAppData ?? process.env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is required by the BPA Windows runtime");
    }
    return paths.resolve(localAppData, "BPA");
  }
  return paths.resolve(homeDirectory, "Library", "Application Support", "BPA");
}

export function resolveDefaultBpaLogRoot(
  environment: DesktopPathEnvironment = {}
): string {
  const platform = supportedPlatform(environment.platform ?? process.platform);
  const paths = pathsFor(platform);
  if (platform === "win32") {
    return paths.join(resolveDefaultBpaHome(environment), "logs");
  }
  return paths.resolve(
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
  const paths = pathsFor(supported);
  if (supported === "darwin") {
    return paths.join(paths.resolve(root), "run", `${channel}.sock`);
  }
  const identity = createHash("sha256")
    .update(paths.resolve(root).toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `\\\\.\\pipe\\bpa-${identity}-${channel}`;
}

export function isWindowsNamedPipe(endpoint: string): boolean {
  return /^\\\\\.\\pipe\\/iu.test(endpoint);
}
