export class BridgeError extends Error {
  public readonly code: string;

  public constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "BridgeError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertNever(value: never): never {
  throw new BridgeError(`Unexpected value: ${JSON.stringify(value)}`, "UNEXPECTED_VALUE");
}
