import { expect,it } from 'vitest';
import { legacyTimestamp } from './legacy-time.js';
it('keeps Prisma UTC timestamps independent of the host timezone',()=>{
  expect(legacyTimestamp('2026-08-13T11:37:29.865')).toBe('2026-08-13T11:37:29.865Z');
  expect(legacyTimestamp('2026-08-13T19:37:29.865+08:00')).toBe('2026-08-13T11:37:29.865Z');
});
