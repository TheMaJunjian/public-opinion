import { getPresentationSpec } from '../types';
import { readingStructureDirections, readingStructureLabels, type ReadingNavigationMode, type ReadingNeighbors } from '../pages/workbench/model/readingStructure';
import MessageReferenceControl from './MessageReferenceControl';

export default function ReadingStructureNavigation({ mode, onMode, neighbors, scopeIds, allowedIds, pendingIds, nextId, disabled, confirmationPending,
  messageTypes, getMessageSummary, onVisit }: {
  mode: ReadingNavigationMode; onMode: (mode: ReadingNavigationMode) => void; neighbors: ReadingNeighbors;
  scopeIds: ReadonlySet<string>; allowedIds: ReadonlySet<string>; pendingIds: ReadonlySet<string>;
  nextId: string | null; disabled: boolean; confirmationPending: boolean; messageTypes: ReadonlyMap<string, string>;
  getMessageSummary: (id: string) => string; onVisit: (id: string) => void;
}) {
  const candidates = mode === 'auto' ? [] : neighbors[mode];
  const directions = nextId ? readingStructureDirections.filter(direction => neighbors[direction].some(item => item.id === nextId)) : [];
  const reference = (id: string, label: string) => <MessageReferenceControl messageId={id} type={messageTypes.get(id) ?? '消息'}
    summary={getMessageSummary(id)} initialView="summary" navigateLabel={label} onNavigate={onVisit} disabled={disabled} />;
  const buttonStyle = (value: ReadingNavigationMode) => ({
    background: mode === value ? 'var(--button-primary-bg)' : 'var(--button-secondary-bg)',
    color: mode === value ? 'var(--button-primary-text)' : 'var(--button-secondary-text)',
    borderColor: mode === value ? 'var(--button-primary-bg)' : 'var(--button-secondary-border)',
  });
  return <div role="group" aria-label="讨论关系导航" data-reading-structure style={{ display: 'grid', gap: 6 }}>
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
      <span>继续阅读：</span>
      <button type="button" aria-pressed={mode === 'auto'} disabled={disabled} onClick={() => onMode('auto')} style={buttonStyle('auto')}>按阅读顺序</button>
      {readingStructureDirections.map(direction => <button key={direction} type="button" aria-pressed={mode === direction} disabled={disabled}
        onClick={() => onMode(direction)} style={buttonStyle(direction)}>{readingStructureLabels[direction]}（{neighbors[direction].length}）</button>)}
    </div>
    <div data-reading-continue-target style={{ overflowWrap: 'anywhere' }}>
      {nextId ? <>下一条 → {directions.length ? directions.map(direction => readingStructureLabels[direction]).join(' / ') : '按阅读顺序 · 非直接相邻'}：
        {reference(nextId, `直接阅读继续目标 ${nextId}`)}</>
        : <span style={{ color: 'var(--ink-94a3b8)' }}>{!confirmationPending ? '当前消息无需再次确认，可选择其他消息阅读。'
          : mode === 'auto' ? '当前队列没有其他待阅消息；确认后留在当前消息。' : '当前范围内该方向没有其他待阅消息；确认后留在当前消息。'}</span>}
    </div>
    {mode !== 'auto' && <>
      <div style={{ color: 'var(--ink-94a3b8)' }}>
        {mode === 'up' ? '当前消息回复、引用或关联的直接前文。' : mode === 'down' ? '直接回复、引用或关联当前消息的后续。' : '与当前消息关联同一条直接前文的其他消息。'}
        点击候选可直接阅读，不改变已读状态。
      </div>
      <div aria-label={readingStructureLabels[mode]} style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 7 }}>
        {candidates.map(candidate => <div key={candidate.id} data-reading-neighbor={candidate.id} style={{ overflowWrap: 'anywhere' }}>
          {reference(candidate.id, `阅读${readingStructureLabels[mode]} ${candidate.id}`)}
          <span style={{ color: 'var(--ink-94a3b8)' }}> · {candidate.relationTypes.map(type => getPresentationSpec(type).label).join('、')}
            {' · '}{pendingIds.has(candidate.id) ? '待阅' : '已阅'}
            {!scopeIds.has(candidate.id) ? ' · 范围外，点击继续追溯' : !allowedIds.has(candidate.id) ? ' · 筛选隐藏，点击临时显示' : ''}</span>
          {candidate.viaIds.length > 0 && <div style={{ color: 'var(--ink-94a3b8)' }}>共同前文：{candidate.viaIds.map((id, at) => <span key={id}>
            {at > 0 ? '、' : ''}{reference(id, `阅读共同前文 ${id}`)}</span>)}</div>}
        </div>)}
        {!candidates.length && <span style={{ color: 'var(--ink-94a3b8)' }}>没有该方向的直接关联消息。</span>}
      </div>
    </>}
  </div>;
}
