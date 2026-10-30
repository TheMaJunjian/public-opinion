import { Suspense,useState } from 'react';
import type { DemoMessage } from '../utils/modelBridge';
import { getMessageCardContent, getMessageTypeLabel } from '../utils/messageDisplay';
import MessageReferenceControl from './MessageReferenceControl';
import {MessageDisplayMarker} from './LazyMessageDisplayHints';

/** Inspect a collection entry without changing its source/target/candidate selection. */
export default function StagedMessageLabel({ messageId, message, status, content, ariaLabel, onNavigate, wholeMessage=true }: {
  messageId: string; message?: DemoMessage; status?: string; content?: string; ariaLabel?: string;onNavigate?:(id:string)=>void;wholeMessage?:boolean;
}) {
  const [selected, setSelected] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const copyMessageId = async () => {
    try {
      await navigator.clipboard.writeText(messageId);
      setCopyStatus('已复制消息 ID');
    } catch {
      setCopyStatus('复制失败，请重试');
    }
  };
  if(onNavigate)return <MessageReferenceControl messageId={messageId} type={getMessageTypeLabel(message)} summary={content??getMessageCardContent(message)}
    ariaLabel={ariaLabel??`暂存消息 ${messageId}`} status={status} onNavigate={onNavigate} wholeMessage={wholeMessage} style={{flex:1,minWidth:0,padding:'4px 6px',fontSize:12}}/>;
  return <span style={{display:'inline-flex',alignItems:'center',flex:1,minWidth:0}}><button type="button" aria-label={ariaLabel ?? `暂存消息 ${messageId}`} aria-pressed={selected}
    title={`${selected ? '单击取消选中并显示消息 ID' : '单击选中并显示消息内容'}；双击复制消息 ID`}
    onClick={() => { setSelected(value => !value); setCopyStatus(''); }}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); void copyMessageId(); }}
    style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: '4px 6px', borderRadius: 4,
      border: selected ? '1px solid var(--line-38bdf8)' : '1px solid transparent',
      background: selected ? 'var(--surface-123047)' : 'transparent', color: 'var(--ink-eee)', fontSize: 12,
      cursor: 'pointer', overflowWrap: 'anywhere' }}>
    <span style={{ color: 'var(--ink-94a3b8)' }}>【{getMessageTypeLabel(message)}】 </span>
    <span style={{ whiteSpace: selected ? 'pre-wrap' : 'normal', fontFamily: selected ? 'inherit' : 'monospace' }}>
      {selected ? (content ?? getMessageCardContent(message)) || '（暂无消息内容）' : messageId}
    </span>
    {status && <span style={{ color: 'var(--ink-94a3b8)' }}> · {status}</span>}
    {copyStatus && <span role="status" style={{ color: 'var(--ink-94a3b8)' }}> · {copyStatus}</span>}
  </button>{wholeMessage&&<Suspense fallback={null}><MessageDisplayMarker messageId={messageId} compact/></Suspense>}</span>;
}
