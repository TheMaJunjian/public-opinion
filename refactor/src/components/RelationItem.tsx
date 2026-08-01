import type { RelationMessage, TopicIndex } from '../domain/messages';
import { relationLabel, targetLabel } from '../domain/messages';

interface RelationItemProps {
  relation: RelationMessage;
  index: TopicIndex;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function RelationItem({ relation, index, selected, onSelect }: RelationItemProps) {
  const targets = relation.targetRefs.map((target) => targetLabel(target, index));
  const source = relation.sourceMessageId ? targetLabel({ kind: 'message', messageId: relation.sourceMessageId }, index) : null;
  const className = `relation-item relation-${relation.relationType.toLowerCase()}${selected ? ' is-selected' : ''}`;
  const select = () => onSelect(relation.id);

  switch (relation.relationType) {
    case 'REPLY':
      return <article className={`${className} reply-item`} data-msgid={relation.id} onClick={select}>
        <div className="relation-kicker">回复关系</div>
        <div className="reply-flow"><span>{source}</span><b>回应</b><span>{targets[0]}</span></div>
        <p>{relation.relationPayload?.label || '建立一条可追踪的回应路径'}</p>
      </article>;
    case 'REFERENCE':
      return <article className={`${className} reference-item`} data-msgid={relation.id} onClick={select}>
        <div className="reference-mark">引</div>
        <div><div className="relation-kicker">引用关系</div><strong>{targets[0]}</strong><p>由 {source} 引入讨论</p></div>
      </article>;
    case 'ANNOTATION':
      return <article className={`${className} annotation-item`} data-msgid={relation.id} onClick={select}>
        <div className="relation-kicker">注释关系</div><p>{relation.relationPayload?.content || relation.content}</p><small>锚定：{targets[0]}</small>
      </article>;
    case 'AGREE':
    case 'DISAGREE':
      return <article className={`${className} stance-item`} data-msgid={relation.id} onClick={select}>
        <div className="stance-sign">{relation.relationType === 'AGREE' ? '支持' : '反对'}</div>
        <div><strong>{targets[0]}</strong><p>{relation.createdBy.username} 的独立立场记录</p></div>
        {relation.relationPayload?.amount ? <b className="stake">{relation.relationPayload.amount} 点</b> : null}
      </article>;
    case 'RECOMMEND':
    case 'ARCHIVE':
      return <article className={`${className} valuation-item`} data-msgid={relation.id} onClick={select}>
        <div className="valuation-state">{relation.relationType === 'RECOMMEND' ? '推荐' : '冷藏'}</div>
        <div><strong>{targets[0]}</strong><p>{relation.relationPayload?.subType || 'CUSTOM'} 价值判断</p></div>
        <span className="settlement-kind">价值</span>
      </article>;
    case 'CLASSIFY':
    case 'MERGE':
    case 'ARRANGE':
      return <article className={`${className} container-item`} data-msgid={relation.id} onClick={select}>
        <div className="container-header"><span>{relationLabel(relation.relationType)}</span><b>{relation.relationPayload?.title || `${targets.length} 个成员`}</b></div>
        <div className="member-list">{targets.map((target) => <span key={target}>{target}</span>)}</div>
      </article>;
    case 'SUMMARY':
      return <article className={`${className} summary-item`} data-msgid={relation.id} onClick={select}>
        <div className="relation-kicker">总结关系</div><blockquote>{relation.relationPayload?.content || relation.content}</blockquote><small>覆盖 {targets.length} 个对象</small>
      </article>;
    case 'CORRECT':
      return <article className={`${className} correction-item`} data-msgid={relation.id} onClick={select}>
        <div className="relation-kicker">更正关系</div><p>以 {source || '新的内容'} 修订 {targets[0]}</p>
      </article>;
    case 'TAG':
      return <article className={`${className} tag-item`} data-msgid={relation.id} onClick={select}><span>#{relation.relationPayload?.label || '标注'}</span><p>{targets.join('、')}</p></article>;
    case 'NOTIFY':
    case 'ATTENTION':
    case 'BLOCK':
    case 'JOIN':
      return <article className={`${className} activity-item`} data-msgid={relation.id} onClick={select}><b>{relationLabel(relation.relationType)}</b><span>{targets.join('、') || '系统范围'}</span><small>{relation.createdBy.username}</small></article>;
    case 'PROPOSAL':
    case 'CODE_CHANGE':
    case 'OPERATIONS':
      return <article className={`${className} action-item`} data-msgid={relation.id} onClick={select}><div className="relation-kicker">{relationLabel(relation.relationType)}</div><p>{relation.relationPayload?.content || relation.content}</p></article>;
  }
}
