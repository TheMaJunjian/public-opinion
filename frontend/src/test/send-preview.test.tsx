import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { prepareCommandBatch, queueCommand } from '../api/commandBatch';
import { useWorkbenchComposer } from '../pages/workbench/useWorkbenchComposer';
import { useSendPreview } from '../pages/workbench/useSendPreview';

beforeEach(()=>{
  vi.restoreAllMocks();sessionStorage.clear();localStorage.setItem('user',JSON.stringify({id:'u',username:'测试'}));
  vi.spyOn(api,'prepareCommandBatch').mockImplementation((work,previous)=>prepareCommandBatch(work,undefined,previous));
  vi.spyOn(api,'previewCommandBatch').mockImplementation(async prepared=>({snapshots:[],messageIds:prepared.envelope.commands.map(command=>command.id),baseSequence:1}));
  vi.spyOn(api,'confirmCommandPreview').mockResolvedValue({snapshots:[{scope:{messageId:null,title:'公论'},messages:[],relations:[],users:[],stakes:{},tagCounts:{},attentionUsers:{},sequence:3}]});
});
function setup() {
  const show=vi.fn(),clear=vi.fn(),promote=vi.fn(),error=vi.fn();
  const view=renderHook(({scope,sequence})=>{
    const composer=useWorkbenchComposer();
    const preview=useSendPreview({composer,owner:'u',scope,liveSequence:sequence,sendInFlightRef:{current:false},
      captureTransient:async work=>{await work();},showSendPreview:show,clearSendPreview:clear,confirmSendPreview:promote,error,
      work:async()=>{queueCommand('/messages',{method:'POST',body:JSON.stringify({content:composer.newMessageContent})});composer.setNewMessageContent('');},
    });
    return {composer,preview};
  },{initialProps:{scope:'root',sequence:1}});
  act(()=>view.result.current.composer.setNewMessageContent('待发送内容'));
  return {view,show,clear,promote,error};
}
it('keeps the composer intact during preview and consumes it only after confirmation',async()=>{
  const {view,show,promote}=setup();const before=view.result.current.composer.capture();
  await act(()=>view.result.current.preview.prepare());
  expect(view.result.current.composer.capture()).toEqual(before);expect(view.result.current.preview.active).toBe(true);
  expect(show).toHaveBeenCalledOnce();expect(api.confirmCommandPreview).not.toHaveBeenCalled();expect(sessionStorage.length).toBe(0);
  await act(()=>view.result.current.preview.confirm());
  expect(api.confirmCommandPreview).toHaveBeenCalledExactlyOnceWith(vi.mocked(api.previewCommandBatch).mock.calls[0][0]);
  expect(promote).toHaveBeenCalledOnce();expect(view.result.current.preview.active).toBe(false);
  expect(view.result.current.composer.newMessageContent).toBe('');
});
it('invalidates changed input, permits updating the preview, and cancels without sending',async()=>{
  const {view,clear}=setup();await act(()=>view.result.current.preview.prepare());
  act(()=>view.result.current.composer.setNewMessageContent('已修改'));
  expect(view.result.current.preview.stale).toBe(true);await act(()=>view.result.current.preview.confirm());
  expect(api.confirmCommandPreview).not.toHaveBeenCalled();
  await act(()=>view.result.current.preview.prepare());expect(view.result.current.preview.stale).toBe(false);
  act(()=>view.result.current.preview.cancel());expect(view.result.current.preview.active).toBe(false);
  expect(view.result.current.composer.newMessageContent).toBe('已修改');expect(clear).toHaveBeenCalled();
});
it('preserves the preview and input after rejection and retries the identical prepared request',async()=>{
  const {view,error}=setup();await act(()=>view.result.current.preview.prepare());
  vi.mocked(api.confirmCommandPreview).mockRejectedValueOnce(new Error('服务器拒绝'));
  await act(()=>view.result.current.preview.confirm());expect(view.result.current.preview.active).toBe(true);
  expect(view.result.current.composer.newMessageContent).toBe('待发送内容');expect(error).toHaveBeenCalledWith('服务器拒绝');
  await act(()=>view.result.current.preview.confirm());
  expect(vi.mocked(api.confirmCommandPreview).mock.calls[1][0]).toBe(vi.mocked(api.confirmCommandPreview).mock.calls[0][0]);
});
it('reconciles an uncertain send with the original request while preserving later edits',async()=>{
  const {view}=setup();await act(()=>view.result.current.preview.prepare());
  vi.mocked(api.confirmCommandPreview).mockRejectedValueOnce(Object.assign(new Error('结果待核对'),{unknownOutcome:true}));
  await act(()=>view.result.current.preview.confirm());
  act(()=>view.result.current.composer.setNewMessageContent('下一条草稿'));
  expect(view.result.current.preview.uncertain).toBe(true);expect(view.result.current.preview.ready).toBe(true);
  await act(()=>view.result.current.preview.prepare());expect(api.previewCommandBatch).toHaveBeenCalledOnce();
  await act(()=>view.result.current.preview.confirm());
  expect(vi.mocked(api.confirmCommandPreview).mock.calls[1][0]).toBe(vi.mocked(api.confirmCommandPreview).mock.calls[0][0]);
  expect(view.result.current.preview.active).toBe(false);expect(view.result.current.composer.newMessageContent).toBe('下一条草稿');
});
it('discards a pending preview on scope change and releases the preparation lock',async()=>{
  const {view}=setup();let resolve!: (value:Awaited<ReturnType<typeof api.previewCommandBatch>>)=>void;
  vi.mocked(api.previewCommandBatch).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  let preparing!:Promise<void>;
  await act(async()=>{preparing=view.result.current.preview.prepare();});
  expect(api.previewCommandBatch).toHaveBeenCalledOnce();
  view.rerender({scope:'another-scope',sequence:1});
  await act(async()=>{resolve({snapshots:[],messageIds:[],baseSequence:1});await preparing;});
  expect(view.result.current.preview.active).toBe(false);
  await act(()=>view.result.current.preview.prepare());
  expect(api.previewCommandBatch).toHaveBeenCalledTimes(2);expect(view.result.current.preview.active).toBe(true);
  view.rerender({scope:'another-scope',sequence:2});expect(view.result.current.preview.stale).toBe(true);
});
