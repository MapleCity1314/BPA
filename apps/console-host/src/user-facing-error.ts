/**
 * A deliberately business-facing error whose message is safe to return to the
 * loopback Console UI. Unexpected errors must never be converted to this type.
 */
export class ConsoleUserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleUserFacingError";
  }
}
