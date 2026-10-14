export function sendErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
