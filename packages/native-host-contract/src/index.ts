export const DEFAULT_BPA_EXTENSION_ID =
  "hoobbnlkcdhbemedpfhhoicklplggmbc";

export function assertNativeHostOrigin(
  origin: string,
  allowedExtensionId: string
): void {
  const expected = `chrome-extension://${allowedExtensionId}/`;
  if (origin !== expected) {
    throw new Error(`Native host origin rejected: ${origin}`);
  }
}
