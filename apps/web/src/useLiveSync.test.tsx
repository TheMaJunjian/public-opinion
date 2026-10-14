import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Change } from '@gonglun/core';
import { api } from './api';
import { useLiveSync } from './useLiveSync';

class FakeEventSource {
  static last: FakeEventSource;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() { FakeEventSource.last = this; }
}
const event = (sequence: number): Change => ({ sequence, messages: [], states: [], memberships: [], removedMemberships: [], ledger: [], treasury: { operating: 0, issued: 0 } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('incremental synchronization', () => {
  it('recovers missing events before accepting a jumped live event', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const receive = vi.fn();
    const changes = vi.spyOn(api, 'changes').mockResolvedValueOnce({ changes: [], nextCursor: 10, hasMore: false }).mockResolvedValueOnce({ changes: [event(11), event(12), event(13)], nextCursor: 13, hasMore: false });
    const host = document.createElement('div'); const root = createRoot(host);
    function Harness() { useLiveSync(true, 10, receive); return null; }
    await act(async () => { root.render(<Harness/>); });
    await act(async () => { FakeEventSource.last.onopen?.(); });
    await act(async () => { FakeEventSource.last.onmessage?.({ data: JSON.stringify(event(13)) }); });
    expect(changes).toHaveBeenLastCalledWith(10);
    expect(receive.mock.calls.map(call => call[0].sequence)).toEqual([11, 12, 13]);
    await act(async () => { FakeEventSource.last.onmessage?.({ data: JSON.stringify(event(12)) }); });
    expect(receive).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    expect(FakeEventSource.last.close).toHaveBeenCalledOnce();
  });
});
