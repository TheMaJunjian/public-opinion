import type { DemoMessage } from '../utils/modelBridge';
import { isContentKind } from '../utils/modelBridge';
import { getPresentationSpec } from '../types';

export interface MessageCardContext {
  isWholeSelected?: boolean;
  isActiveText?: boolean;
  isTopicMsg?: boolean;
  isClassifyTopic?: boolean;
  isSummaryTopic?: boolean;
  isMergeTopic?: boolean;
  isGovernanceMsg?: boolean;
  governanceColor?: string;
  topicMsgTitle?: string;
  topicMsgTargetCount?: number;
  relType?: string | null;
  settlementTargetId?: string | undefined;
  settlementTargetContent?: string;
  isValueSettlement?: boolean;
  lastClickedMsgId?: string | null;
  readStatus?: 'READ' | 'UNREAD';
}

export interface MessageCardProps {
  msg: DemoMessage;
  ctx: MessageCardContext;
  onClick?: (e: React.MouseEvent, msgId: string) => void;
  onDoubleClick?: (e: React.MouseEvent, msgId: string) => void;
  onMouseDown?: (e: React.MouseEvent, msgId: string) => void;
  onMouseUp?: (e: React.MouseEvent, msgId: string) => void;
  /** Extra content rendered in the header right area (stances, stakes, settlement toggles) */
  headerExtra?: React.ReactNode;
  /** Override the default message title in the header. */
  headerLabel?: React.ReactNode;
  /** Status rendered after the author. */
  headerAfterAuthor?: React.ReactNode;
  /** Extra badges below header (relation type, stance status, etc.) */
  badges?: React.ReactNode;
  /** Extra overlays (settlement panel, etc.) */
  overlays?: React.ReactNode;
  /** Click handler for settlement target link (ROUND/RESULT messages) */
  onSettlementTargetClick?: (e: React.MouseEvent, targetId: string) => void;
  /** Override content area (TopicDetailPage uses renderMessageContentWithAnchorsForList) */
  children?: React.ReactNode;
  /** onMouseUp handler for content area text selection */
  onContentMouseUp?: (e: React.MouseEvent, msgId: string) => void;
}

export default function MessageCard({
  msg,
  ctx,
  onClick,
  onDoubleClick,
  onMouseDown,
  onMouseUp,
  headerAfterAuthor,
  headerExtra,
  headerLabel,
  badges,
  overlays,
  onSettlementTargetClick,
  children,
  onContentMouseUp,
}: MessageCardProps) {
  const {
    isWholeSelected, isActiveText, isTopicMsg,
    isClassifyTopic, isSummaryTopic, isMergeTopic,
    isGovernanceMsg, governanceColor,
    topicMsgTitle, topicMsgTargetCount,
    relType,
    settlementTargetId, settlementTargetContent, isValueSettlement,
    lastClickedMsgId,
    readStatus,
  } = ctx;

  const bk = (msg as any).backendKind as string | undefined;
  const govColor = governanceColor ?? (bk === 'GOVERNANCE' ? '#f59e0b' : bk === 'CODE' ? '#3b82f6' : '#10b981');
  const topicBackground = isSummaryTopic ? '#14352a' : isMergeTopic ? '#1e293b' : '#1f1f1f';
  const topicLabel = isSummaryTopic ? '总结容器' : isMergeTopic ? '归并' : '进行中';
  const selectedTypeLabel = isClassifyTopic ? '分类' : isSummaryTopic ? '总结' : isMergeTopic ? '归并' : msg.kind === 'relation' ? (relType ? getPresentationSpec(relType).label : '关系') : '文本';

  return (
    <div
      key={msg.id}
      data-msgid={msg.id}
      onClick={e => onClick?.(e, msg.id)}
      onDoubleClick={e => onDoubleClick?.(e, msg.id)}
      onMouseDown={e => onMouseDown?.(e, msg.id)}
      onMouseUp={e => onMouseUp?.(e, msg.id)}
      style={{
        position: 'relative',
        borderRadius: isTopicMsg ? 8 : 6,
        border: isWholeSelected
          ? '2px solid #fbbf24'
          : isTopicMsg
            ? isSummaryTopic ? '1px solid rgba(52,211,153,0.7)' : isMergeTopic ? '1px solid rgba(148,163,184,0.75)' : '1px solid #444'
            : isGovernanceMsg ? `1px solid ${govColor}44` : isActiveText ? '2px dashed #0b84ff' : '1px solid #444',
        borderLeft: isWholeSelected
          ? '4px solid #fbbf24'
          : isTopicMsg ? `4px solid ${isSummaryTopic ? '#34d399' : isMergeTopic ? '#94a3b8' : '#6366f1'}`
          : isGovernanceMsg ? `3px solid ${govColor}` : undefined,
        background: isWholeSelected
          ? 'rgba(91,65,0,0.55)'
          : isTopicMsg ? topicBackground
          : isGovernanceMsg ? '#1a1f2e' : '#1f1f1f',
        padding: isTopicMsg ? '10px 12px' : '10px 14px',
        cursor: 'pointer',
        fontSize: 13,
        boxShadow: isWholeSelected
          ? '0 0 0 3px #111827, 0 0 0 5px #fbbf24, 0 4px 18px rgba(251,191,36,0.45)'
          : isTopicMsg ? '0 2px 8px rgba(0,0,0,0.15)' : undefined,
        outline: isWholeSelected ? 'none' : lastClickedMsgId === msg.id ? '1px dashed #0b84ff' : 'none',
        userSelect: isActiveText ? 'text' : 'auto',
        opacity: readStatus === 'READ' ? 0.72 : 1,
      }}
    >
      {/* Header */}
      <div style={{
        fontSize: 11,
        opacity: isTopicMsg ? 0.65 : 0.8,
        marginBottom: 4,
        display: 'flex',
        justifyContent: 'space-between',
        color: isTopicMsg ? '#94a3b8' : undefined,
      }}>
        <span>
          {isWholeSelected && (
            <span style={{ marginRight: 6, padding: '2px 6px', borderRadius: 4, background: '#fbbf24', color: '#111827', fontWeight: 800, opacity: 1 }}>
              {selectedTypeLabel}
            </span>
          )}
          {headerLabel ?? (isClassifyTopic ? `分类 ${msg.id}`
            : isSummaryTopic ? `总结 ${msg.id}`
            : isMergeTopic ? `归并 ${msg.id}`
            : msg.kind === 'relation' ? `关系消息 ${msg.id}`
            : bk === 'ROUND' ? ((msg as any).roundPayload?.settlementType === 'VALUE' ? '💎 发起价值仲裁' : '⚖️ 发起真假仲裁')
            : bk === 'ROUND_RESULT' ? ((msg as any).roundPayload?.settlementType === 'VALUE' ? '💎 价值仲裁已结算' : '⚖️ 真假仲裁已结算')
            : bk === 'GOVERNANCE' ? '🏛️ 治理提案'
            : bk === 'CODE' ? '💻 代码'
            : bk === 'OPERATIONS' ? '📊 运营'
            : `消息 ${msg.id}`)}
        </span>
        <span style={{ textAlign: 'right' }}>
          <div>
            {isClassifyTopic ? '双击进入分类'
              : isSummaryTopic ? '双击进入总结容器'
              : isMergeTopic ? '双击进入归并'
              : <>{`作者：${msg.author}`}{headerAfterAuthor && ' '}{headerAfterAuthor}</>}
          </div>
          {headerExtra}
        </span>
      </div>
      {readStatus && (
        <div title={readStatus === 'READ' ? '已读' : '未读'} style={{ position: 'absolute', right: 8, bottom: 6, fontSize: 13, color: readStatus === 'READ' ? '#86efac' : '#fca5a5' }}>
          {readStatus === 'READ' ? '✓' : '○'}
        </div>
      )}

      {/* Badges (external) or built-in relation type badge */}
      {badges != null ? badges : (
        !isTopicMsg && msg.kind === 'relation' && (
          <div style={{ marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.08)', color: '#9ca3af' }}>
              {relType ? String(relType) : '关系'}
            </span>
          </div>
        )
      )}
      {isTopicMsg && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 8, marginBottom: 6,
        }}>
          <div style={{
            fontWeight: 600, color: '#f1f5f9',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isSummaryTopic ? 'pre-wrap' : 'nowrap',
            userSelect: isActiveText ? 'text' : 'auto',
            cursor: isActiveText ? 'text' : 'inherit',
          }} onMouseUp={e => onContentMouseUp?.(e, msg.id)}>
            {isSummaryTopic && topicMsgTitle ? (
              <>
                <div style={{ fontSize: 10, color: '#6ee7b7', marginBottom: 3 }}>总结内容</div>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{topicMsgTitle}</div>
              </>
            ) : topicMsgTitle || (isClassifyTopic ? `分类（${topicMsgTargetCount ?? 0}）`
              : isMergeTopic ? `归并（${topicMsgTargetCount ?? 0}）`
              : `总结（${topicMsgTargetCount ?? 0}）`)}
          </div>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 999,
            background: isMergeTopic ? 'rgba(148,163,184,0.18)' : isSummaryTopic ? 'rgba(52,211,153,0.2)' : 'rgba(2,150,80,0.2)',
            color: isMergeTopic ? '#94a3b8' : isSummaryTopic ? '#6ee7b7' : '#86efac',
          }}>
            {topicLabel}
          </span>
        </div>
      )}

      {/* Text selection mode indicator */}
      {isActiveText && (isContentKind(msg.kind) || isTopicMsg) && (
        <div style={{ fontSize: 11, color: '#0b84ff', marginBottom: 4 }}>
          文本选择模式：拖选记录 start+len；或点击高亮片段
        </div>
      )}

      {/* Content */}
      {!isTopicMsg && (
        <div style={{ fontSize: 13, color: '#f5f5f5' }} onMouseUp={e => onContentMouseUp?.(e, msg.id)}>
          {children != null ? children : (
            isContentKind(msg.kind) && (msg.kind === 'round' || msg.kind === 'round_result') ? (() => {
            const sid = settlementTargetId ?? (msg as any).settlementTargetId as string | undefined;
            const tgtContent = settlementTargetContent ?? '';
            const preview = tgtContent.length > 40 ? tgtContent.slice(0, 40) + '…' : tgtContent;
            const isVal = isValueSettlement ?? (msg as any).roundPayload?.settlementType === 'VALUE';
            const isRound = msg.kind === 'round';
            const tc = isVal
              ? (isRound ? '#fcd34d' : '#f59e0b')
              : (isRound ? '#a5b4fc' : '#818cf8');
            const lines = (msg.content ?? '').split('\n');
            return (
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{lines[0]}</span>
                  {sid && (
                    <span
                      onClick={e => { e.stopPropagation(); onSettlementTargetClick?.(e, sid); }}
                      style={{
                        fontSize: 11, fontWeight: 500, padding: '1px 6px', borderRadius: 4,
                        background: `${tc}12`, color: tc, border: `1px solid ${tc}35`,
                        cursor: onSettlementTargetClick ? 'pointer' : 'default',
                        maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                      title={sid.slice(-6) + (tgtContent ? '：' + tgtContent : '')}
                    >
                      → {sid.slice(-6)}{preview ? `「${preview}」` : ''}
                    </span>
                  )}
                </div>
                {lines.slice(1).join('\n') && (
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'Menlo, Monaco, Consolas, monospace', fontSize: 13 }}>
                    {lines.slice(1).join('\n')}
                  </pre>
                )}
              </div>
            );
          })() : isContentKind(msg.kind) ? (
            <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#d1d5db' }}>{msg.content}</div>
          ))}
        </div>
      )}

      {/* Topic card description */}
      {isTopicMsg && (
        <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>由 <span style={{ fontWeight: 600, color: '#cbd5e1' }}>{msg.author}</span> 发起</span>
          <span>💬 {topicMsgTargetCount ?? 0} 条观点</span>
          <span>{new Date(msg.createdAt).toLocaleDateString('zh-CN')}</span>
        </div>
      )}

      {/* Overlays */}
      {overlays}
    </div>
  );
}
