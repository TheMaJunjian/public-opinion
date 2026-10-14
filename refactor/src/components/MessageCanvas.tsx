import type { TopicMessage } from '../domain/messages';
import { createTopicIndex, isContentMessage, relationLabel } from '../domain/messages';
import type { TopicSnapshot } from '../domain/topicSnapshot';
import { RelationItem } from './RelationItem';

interface MessageCanvasProps {
  snapshot: TopicSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  visibleIds?: Set<string> | null;
}

export function MessageCanvas({ snapshot, selectedId, onSelect, visibleIds = null }: MessageCanvasProps) {
  const index = createTopicIndex(snapshot.messages);
  const messages = visibleIds ? snapshot.messages.filter((message) => visibleIds.has(message.id)) : snapshot.messages;
  const contentMessages = messages.filter(isContentMessage);
  const relations = messages.filter((message): message is Extract<TopicMessage, { kind: 'RELATION' }> => message.kind === 'RELATION');

  return <section className="canvas" aria-label="消息画布">
    <div className="canvas-section">
      <div className="section-label">内容消息 <span>{contentMessages.length}</span></div>
      <div className="content-grid">
        {contentMessages.map((message) => <article key={message.id} className={`content-card${selectedId === message.id ? ' is-selected' : ''}`} data-msgid={message.id} onClick={() => onSelect(message.id)}>
          <header><span>{message.kind === 'TEXT' ? '观点' : message.kind}</span><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header>
          <p>{message.content}</p>
          <footer>{message.createdBy.username}<span>{index.relationsByTargetId.get(message.id)?.length || 0} 条关联</span></footer>
        </article>)}
      </div>
    </div>
    <div className="canvas-section">
      <div className="section-label">关系消息 <span>{relations.length}</span></div>
      <div className="relation-grid">
        {relations.map((relation) => <RelationItem key={relation.id} relation={relation} index={index} selected={selectedId === relation.id} onSelect={onSelect} />)}
      </div>
      <p className="canvas-note">每个组件对应一条实际关系消息。连接、框线和附着位置只解释该消息，不拥有其身份。</p>
    </div>
  </section>;
}

interface MessageInspectorProps extends Pick<MessageCanvasProps, 'snapshot' | 'selectedId'> {
  onSelect: (id: string) => void;
  onOpenContainer: (id: string) => void;
}

export function MessageInspector({ snapshot, selectedId, onSelect, onOpenContainer }: MessageInspectorProps) {
  const index = createTopicIndex(snapshot.messages);
  const message = selectedId ? index.byId.get(selectedId) : null;
  if (!message) return <aside className="inspector"><p>选择一个消息，查看它作为独立对象的结构信息。</p></aside>;

  const incoming = index.relationsByTargetId.get(message.id) ?? [];
  const outgoing = index.relationsBySourceId.get(message.id) ?? [];
  return <aside className="inspector">
    <div className="inspector-label">消息检查器</div>
    <h2>{message.kind === 'RELATION' ? relationLabel(message.relationType) : message.kind}</h2>
    <code>{message.id}</code>
    <dl><dt>作者</dt><dd>{message.createdBy.username}</dd><dt>创建时间</dt><dd>{new Date(message.createdAt).toLocaleString('zh-CN')}</dd></dl>
    {message.kind === 'RELATION' ? <><h3>结构</h3><dl><dt>来源</dt><dd>{message.sourceMessageId ? <button type="button" className="jump-link" onClick={() => onSelect(message.sourceMessageId!)}>{message.sourceMessageId}</button> : '无来源关系'}</dd><dt>目标</dt><dd className="target-links">{message.targetRefs.length > 0 ? message.targetRefs.map((target) => {
      const targetId = target.kind === 'relation' ? target.relationId : target.messageId;
      return <button key={`${targetId}-${target.kind}`} type="button" className="jump-link" onClick={() => onSelect(targetId)}>{targetId}</button>;
    }) : '无目标'}</dd></dl>{['CLASSIFY', 'MERGE', 'SUMMARY', 'ARRANGE'].includes(message.relationType) ? <button type="button" className="container-button" onClick={() => onOpenContainer(message.id)}>进入容器视图</button> : null}</> : <p className="inspector-content">{message.content}</p>}
    <h3>关联</h3><p>指向此消息：{incoming.length} 条</p><p>以此消息为来源：{outgoing.length} 条</p>
  </aside>;
}
