import { useState } from 'react';
import type { ReadingMark } from '@gonglun/core';
import { normalizeHomeFilter, type HomeFilterMode } from '../pages/workbench/model/homeFilter';

/** Keep this unread visit's membership stable while its live reading indicators update. */
export function useHomeFilterReadingMarks(mode: HomeFilterMode | null, owner: string, marks: ReadingMark[], ready: boolean) {
  const selection = normalizeHomeFilter(mode);
  const key = JSON.stringify([owner, selection, ready]);
  const [snapshot, setSnapshot] = useState({ key, marks });
  if (snapshot.key !== key) {
    setSnapshot({ key, marks });
    return marks;
  }
  return ready && selection.status === 'pending' ? snapshot.marks : marks;
}
