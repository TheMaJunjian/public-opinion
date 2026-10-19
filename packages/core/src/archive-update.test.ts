import { expect, it } from 'vitest';
import { archiveChangeFingerprint, normalizeArchiveChange } from './archive-update.js';
import type { Change } from './types.js';

const change: Change = { sequence: 1, messages: [], states: [], memberships: [], removedMemberships: [], ledger: [], treasury: { issued: 0, operating: 0 } };

it('fingerprints historical exports identically despite whitespace, key order and omitted predecessors', () => {
  const reordered = { treasury: { operating: 0, issued: 0 }, ledger: [], removedMemberships: [], memberships: [], states: [], messages: [], previousSequence: 0, sequence: 1 };
  expect(archiveChangeFingerprint(change)).toBe(archiveChangeFingerprint(reordered));
  expect(normalizeArchiveChange(change).previousSequence).toBe(0);
  expect(change.previousSequence).toBeUndefined();
  expect(archiveChangeFingerprint(change)).not.toBe(archiveChangeFingerprint({ ...change, treasury: { operating: 1, issued: 1 } }));
});

it('preserves explicit predecessor links across rolled back sequence gaps', () => {
  expect(normalizeArchiveChange({ ...change, sequence: 5, previousSequence: 1 }).previousSequence).toBe(1);
});
