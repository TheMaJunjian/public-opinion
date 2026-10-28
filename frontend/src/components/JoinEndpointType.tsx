import type { DemoMessage } from '../utils/modelBridge';
import { getMessageTypeLabel } from '../utils/messageDisplay';

export default function JoinEndpointType({ messageId, messages, containerType, containerLabel = false }: {
  messageId: string; messages: ReadonlyMap<string, DemoMessage>; containerType?: string; containerLabel?: boolean;
}) {
  const message = messages.get(messageId);
  const concreteType = ({ CLASSIFY: '分类', SUMMARY: '总结', ARRANGE: '排列', MERGE: '归并' } as Record<string, string>)[(message?.relationType ?? containerType)?.toUpperCase() ?? ''];
  const label = concreteType ?? (message ? getMessageTypeLabel(message) : '类型未知');
  if (containerLabel) return <span data-join-endpoint-type={messageId} data-join-container-label="true"
    style={{fontSize:11,color:'#9ca3af',flexShrink:0}}>【{concreteType ?? '容器'}】ID：</span>;
  return <span data-join-endpoint-type={messageId} style={{fontSize:10,fontWeight:600,color:'#a5b4fc',padding:'1px 4px',borderRadius:3,
    background:'rgba(129,140,248,0.14)',whiteSpace:'nowrap',flexShrink:0}}>【{label}】</span>;
}
