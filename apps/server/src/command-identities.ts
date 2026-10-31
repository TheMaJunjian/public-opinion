import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

const identities = new AsyncLocalStorage<{ seed: string; next: number }>();

/** Generated JOINs, rounds and receipts keep their identity from rehearsal to commit. */
export function commandIdentity() {
  const context = identities.getStore();
  if (!context) return randomUUID();
  const bytes = createHash('sha256').update(`${context.seed}:${context.next++}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function withCommandIdentities<T>(seed: string, work: () => T): T {
  return identities.run({ seed, next: 0 }, work);
}
