export type SqliteObservabilityExtension =
  | {
      status: "available";
      target: "darwin-arm64";
      extensionPath: string;
    }
  | {
      status: "not_supported";
      target: string;
    };

export declare function resolveSqliteObservabilityExtension(
  platform?: NodeJS.Platform,
  architecture?: string
): SqliteObservabilityExtension;
