import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReviewPresence } from '../hooks/useReviewPresence';

const { heartbeat }=vi.hoisted(()=>({heartbeat:vi.fn()}));
vi.mock('../api/client',()=>({updateReviewPresence:heartbeat}));
function Presence({userId}:{userId?:string}){useReviewPresence(userId);return null;}
let hidden=false,online=true;
beforeEach(()=>{
  vi.useFakeTimers();hidden=false;online=true;heartbeat.mockReset().mockResolvedValue({ok:true});
  vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
  vi.spyOn(navigator,'onLine','get').mockImplementation(()=>online);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();});

it('reports only a signed-in foreground page and resumes immediately on return or reconnection',async()=>{
  const view=render(<Presence />);
  await act(()=>vi.advanceTimersByTimeAsync(30_000));expect(heartbeat).not.toHaveBeenCalled();
  view.rerender(<Presence userId="reviewer" />);
  await act(async()=>{});expect(heartbeat).toHaveBeenCalledTimes(1);
  await act(()=>vi.advanceTimersByTimeAsync(30_000));expect(heartbeat).toHaveBeenCalledTimes(2);
  hidden=true;document.dispatchEvent(new Event('visibilitychange'));
  await act(()=>vi.advanceTimersByTimeAsync(120_000));expect(heartbeat).toHaveBeenCalledTimes(2);
  hidden=false;await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));});
  expect(heartbeat).toHaveBeenCalledTimes(3);
  online=false;await act(()=>vi.advanceTimersByTimeAsync(60_000));expect(heartbeat).toHaveBeenCalledTimes(3);
  online=true;await act(async()=>{window.dispatchEvent(new Event('online'));});expect(heartbeat).toHaveBeenCalledTimes(4);
  view.rerender(<Presence />);
  await act(()=>vi.advanceTimersByTimeAsync(60_000));expect(heartbeat).toHaveBeenCalledTimes(4);
});

it('does not overlap requests, retries failures, and aborts the old account heartbeat on switch or unmount',async()=>{
  let fail!:(error:Error)=>void;
  heartbeat.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
  const view=render(<Presence userId="first" />),firstSignal=heartbeat.mock.calls[0]![0] as AbortSignal;
  await act(()=>vi.advanceTimersByTimeAsync(60_000));expect(heartbeat).toHaveBeenCalledTimes(1);
  await act(async()=>{fail(new Error('offline'));});
  await act(()=>vi.advanceTimersByTimeAsync(30_000));expect(heartbeat).toHaveBeenCalledTimes(2);
  view.rerender(<Presence userId="second" />);
  await act(async()=>{});expect(firstSignal.aborted).toBe(true);expect(heartbeat).toHaveBeenCalledTimes(3);
  const secondSignal=heartbeat.mock.calls[2]![0] as AbortSignal;
  view.unmount();expect(secondSignal.aborted).toBe(true);
  await act(()=>vi.advanceTimersByTimeAsync(60_000));window.dispatchEvent(new Event('focus'));
  expect(heartbeat).toHaveBeenCalledTimes(3);
});
