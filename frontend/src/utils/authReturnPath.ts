/** Only application message routes may be restored after explicit authentication. */
export function authReturnPath(state: unknown): string {
  const value = (state as { returnTo?: unknown } | null)?.returnTo;
  return typeof value === 'string' && /^\/messages(?:\/[^?#]*)?(?:\?[^#]*)?$/.test(value) ? value : '/';
}
