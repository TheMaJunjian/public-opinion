import { expect, it } from 'vitest';
import { archiveChangeFingerprint } from './archive-update.js';
import type { Change } from './types.js';

const change: Change = { sequence: 1, previousSequence:0,messages: [], states: [], memberships: [], removedMemberships: [], ledger: [], treasury: { issued: 0, operating: 0 } };

it('fingerprints current exports identically despite whitespace and key order', () => {
  const reordered = { treasury: { operating: 0, issued: 0 }, ledger: [], removedMemberships: [], memberships: [], states: [], messages: [], previousSequence: 0, sequence: 1 };
  expect(archiveChangeFingerprint(change)).toBe(archiveChangeFingerprint(reordered));
  expect(archiveChangeFingerprint(change)).not.toBe(archiveChangeFingerprint({ ...change, treasury: { operating: 1, issued: 1 } }));
});

it('preserves explicit predecessor links across rolled back sequence gaps', () => {
  expect(archiveChangeFingerprint({ ...change, sequence: 5, previousSequence: 1 })).not.toBe(archiveChangeFingerprint({...change,sequence:5,previousSequence:4}));
});
