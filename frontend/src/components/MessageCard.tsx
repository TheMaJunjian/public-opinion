import type { DemoMessage, UnitSelection } from '../utils/modelBridge';
import { isContentKind } from '../utils/modelBridge';
import MessageAuthors from './MessageAuthors';
import { getPresentationSpec } from '../types';
import { getRelationMessageLabel } from '../utils/attachedRelationLabels';
import MessageTextPart from './MessageTextPart';
import MessageElement from './MessageElement';
import { MessageDisplayMarker } from './MessageDisplayHints';
import { isMessageElementSelected, messageMembersReference, messageTypeReference } from '../utils/messageElementSelection';
import { getMessageProminence } from '../utils/messageDisplay';
import { activateMessageFromKeyboard } from '../utils/messageKeyboard';

export interface MessageCardContext {
  isRelationRecord?: boolean;
  isWholeSelected?: boolean;
  isActiveText?: boolean;
  isOrganizationMessage?: boolean;
  isClassification?: boolean;
  isSummary?: boolean;
  isMerge?: boolean;
  isGovernanceMsg?: boolean;
  governanceColor?: string;
  organizationTitle?: string;
  memberCount?: number;
  relType?: string | null;
  settlementTargetId?: string | undefined;
  settlementTargetContent?: string;
  isValueSettlement?: boolean;
  lastClickedMsgId?: string | null;
  readStatus?: 'READ' | 'UNREAD';
  homeMatch?: boolean;
  homeContextRole?: 'source' | 'target' | 'source-target';
}

export interface MessageCardProps {
  msg: DemoMessage;
  ctx: MessageCardContext;
  selectedUnits?: readonly UnitSelection[];
  onClick?: (e: React.MouseEvent, msgId: string) => void;
  onDoubleClick?: (e: React.MouseEvent, msgId: string) => void;
  onMouseDown?: (e: React.MouseEvent, msgId: string) => void;
  onMouseUp?: (e: React.MouseEvent, msgId: string) => void;
  /** Extra content rendered in the header right area (stances, stakes, settlement toggles) */
  headerExtra?: React.ReactNode;
  headerAuthor?:React.ReactNode;
  /** Override the default message title in the header. */
  headerLabel?: React.ReactNode;
  /** Content rendered at the far left of the header. */
  headerLeading?: React.ReactNode;
  /** Status rendered between the message ID and author. */
  headerBetweenIdAuthor?: React.ReactNode;
  /** Status rendered after the author. */
  headerAfterAuthor?: React.ReactNode;
  /** Extra badges below header (relation type, stance status, etc.) */
  badges?: React.ReactNode;
  /** Extra overlays (settlement panel, etc.) */
  overlays?: React.ReactNode;
  /** Click handler for settlement target link (ROUND/RESULT messages) */
  onSettlementTargetClick?: (e: React.MouseEvent, targetId: string) => void;
  /** Override readable content, including existing fragment highlights. */
  children?: React.ReactNode;
  /** onMouseUp handler for content area text selection */
  onContentMouseUp?: (e: React.MouseEvent, msgId: string) => void;
  relatedMessages?:React.ReactNode;
}

export default function MessageCard({
  msg,
  ctx,
  selectedUnits,
  onClick,
  onDoubleClick,
  onMouseDown,
  onMouseUp,
  headerAfterAuthor,
  headerBetweenIdAuthor,
  headerLeading,
  headerExtra,
  headerAuthor,
  headerLabel,
  badges,
  overlays,
  onSettlementTargetClick,
  children,
  onContentMouseUp,
  relatedMessages,
}: MessageCardProps) {
  const {
    isWholeSelected, isActiveText, isOrganizationMessage, isRelationRecord,
    isClassification, isSummary, isMerge,
    isGovernanceMsg, governanceColor,
    organizationTitle, memberCount,
    relType,
    settlementTargetId, settlementTargetContent, isValueSettlement,
    lastClickedMsgId,
    readStatus,
    homeMatch,
    homeContextRole,
  } = ctx;

  const bk = (msg as any).backendKind as string | undefined;
  const prominence = getMessageProminence(msg);
  const isDelegationMsg = msg.kind === 'relation' && msg.relationType === 'delegation';
  const delegationColor = '#f97316';
  const govColor = governanceColor ?? (bk === 'GOVERNANCE' ? '#f59e0b' : bk === 'CODE' ? '#3b82f6' : '#10b981');
  const organizationBackground = isSummary ? '#14352a' : isMerge ? '#1e293b' : '#1f1f1f';
  const specificMessageLabel = getRelationMessageLabel(msg);
  const messageTypeLabel = isRelationRecord && msg.kind === 'relation'
    ? getPresentationSpec(relType ?? msg.relationType ?? 'relation').label
    : specificMessageLabel ?? (msg.kind === 'relation'
    ? getPresentationSpec(relType ?? msg.relationType ?? 'relation').label
    : msg.kind === 'normal'
      ? '文本'
      : msg.kind === 'join'
        ? '加入'
        : msg.kind === 'round'
          ? ((msg as any).roundPayload?.settlementType === 'VALUE' ? '价值仲裁' : '真假仲裁')
          : msg.kind === 'round_result'
            ? ((msg as any).roundPayload?.settlementType === 'VALUE' ? '价值仲裁结算' : '真假仲裁结算')
            : bk === 'GOVERNANCE' ? '治理提案'
              : bk === 'CODE' ? '代码'
                : bk === 'OPERATIONS' ? '运营'
                  : '消息');
  const typeBadgeLabel = isClassification ? '分类' : isSummary ? '总结' : isMerge ? '归并' : messageTypeLabel;
  const inlineRelationContent = isRelationRecord && !isOrganizationMessage && children != null;
  const defaultHeaderLabel = isRelationRecord || isClassification || isSummary || isMerge || isDelegationMsg || msg.kind === 'relation'
    ? msg.id
    : bk === 'ROUND' ? ((msg as any).roundPayload?.settlementType === 'VALUE' ? '发起价值仲裁' : '发起真假仲裁')
      : bk === 'ROUND_RESULT' ? ((msg as any).roundPayload?.settlementType === 'VALUE' ? '价值仲裁已结算' : '真假仲裁已结算')
        : bk === 'GOVERNANCE' ? (specificMessageLabel ? msg.id : '治理提案')
          : bk === 'CODE' ? '代码'
            : bk === 'OPERATIONS' ? '运营'
              : msg.id;

  const cardBorder = isWholeSelected ? '2px solid #fbbf24'
    : isRelationRecord ? isActiveText ? '2px dashed #0b84ff' : '1px dashed #32363d'
    : isOrganizationMessage ? isSummary ? '1px solid rgba(52,211,153,0.7)' : isMerge ? '1px solid rgba(148,163,184,0.75)' : '1px solid #444'
      : isDelegationMsg ? `1px solid ${delegationColor}66` : isGovernanceMsg ? `1px solid ${govColor}44` : isActiveText ? '2px dashed #0b84ff' : '1px solid #444';

  return (
    <div
      key={msg.id}
      data-msgid={msg.id}
      data-relation-record={isRelationRecord || undefined}
      role="group"
      tabIndex={0}
      aria-label={`消息 ${msg.id}，${isWholeSelected ? '已选中' : '未选中'}`}
      aria-keyshortcuts="Enter Space Shift+Enter"
      onKeyDown={activateMessageFromKeyboard}
      onClick={e => onClick?.(e, msg.id)}
      onDoubleClick={e => onDoubleClick?.(e, msg.id)}
      onMouseDown={e => onMouseDown?.(e, msg.id)}
      onMouseUp={e => onMouseUp?.(e, msg.id)}
      style={{
        position: 'relative',
        borderRadius: isRelationRecord ? 3 : isOrganizationMessage ? 8 : 6,
        borderTop: cardBorder,
        borderRight: cardBorder,
        borderBottom: cardBorder,
        borderLeft: isWholeSelected
          ? '4px solid #fbbf24'
          : isRelationRecord ? isActiveText ? '3px solid #0b84ff' : '2px solid #4b5563'
          : isOrganizationMessage ? `4px solid ${isSummary ? '#34d399' : isMerge ? '#94a3b8' : '#6366f1'}`
          : isDelegationMsg ? `3px solid ${delegationColor}` : isGovernanceMsg ? `3px solid ${govColor}` : cardBorder,
        backgroundColor: isWholeSelected
          ? 'rgba(91,65,0,0.55)'
          : isRelationRecord ? '#15171a'
          : isDelegationMsg ? 'rgba(249,115,22,0.1)' : isOrganizationMessage ? organizationBackground
          : isGovernanceMsg ? '#1a1f2e' : '#1f1f1f',
        padding: isRelationRecord ? '4px 10px' : isOrganizationMessage ? '10px 12px' : '10px 14px',
        cursor: 'pointer',
        fontSize: isRelationRecord ? 12 : prominence.fontSize,
        backgroundImage: isWholeSelected || isRelationRecord ? undefined : prominence.backgroundImage,
        boxShadow: isWholeSelected
          ? '0 4px 18px rgba(251,191,36,0.45)'
          : isRelationRecord ? undefined
          : prominence.boxShadow ?? (isOrganizationMessage ? '0 2px 8px rgba(0,0,0,0.15)' : undefined),
        outline: isWholeSelected ? 'none' : lastClickedMsgId === msg.id ? '1px dashed #0b84ff' : 'none',
        userSelect: isActiveText ? 'text' : 'auto',
        opacity: readStatus === 'READ' ? 0.72 : 1,
      }}
    >
      {/* Header */}
      <div style={{
        fontSize: 11,
        opacity: isOrganizationMessage && !isRelationRecord ? 0.65 : 0.8,
        marginBottom: inlineRelationContent ? 0 : 4,
        display: 'flex',
        flexDirection: 'column',
        color: isOrganizationMessage && !isRelationRecord ? '#94a3b8' : undefined,
      }}>
        <div style={{ display: 'flex', justifyContent: isRelationRecord ? 'flex-start' : 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: '4px 8px' }}>
        <span style={{ minWidth: 0, maxWidth:'100%', overflowWrap: 'anywhere' }}>
          {headerLeading}
          <MessageElement reference={messageTypeReference(msg)} selected={isMessageElementSelected(selectedUnits, messageTypeReference(msg))} label={typeBadgeLabel} style={{ marginRight: 6, padding: '2px 6px', borderRadius: 4, background: isWholeSelected ? '#fbbf24' : 'rgba(148,163,184,0.16)', color: isWholeSelected ? '#111827' : '#cbd5e1', border: isWholeSelected ? '1px solid #fbbf24' : '1px solid rgba(148,163,184,0.35)', fontWeight: 700, opacity: 1 }}>
            {typeBadgeLabel}
          </MessageElement>
          {' '}
          {homeMatch && (
            <span style={{ marginRight: 6, padding: '2px 6px', borderRadius: 4, background: '#0e7490', color: '#cffafe', fontWeight: 700, opacity: 1 }}>
              命中
            </span>
          )}
          {!homeMatch && homeContextRole && (
            <span style={{ marginRight: 6, padding: '2px 6px', borderRadius: 4, background: '#374151', color: '#d1d5db', fontWeight: 600, opacity: 1 }}>
              {homeContextRole === 'source' ? '来源' : homeContextRole === 'target' ? '目标' : '来源/目标'}
            </span>
          )}
          {headerLabel ?? defaultHeaderLabel}
          {headerLeading === undefined && <MessageDisplayMarker messageId={msg.id} />}
          {headerBetweenIdAuthor && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 6, verticalAlign: 'middle', maxWidth: '100%', flexWrap: 'wrap' }}>{headerBetweenIdAuthor}</span>}
        </span>
        {inlineRelationContent && <div style={{ display: 'contents' }} onMouseUp={e => onContentMouseUp?.(e, msg.id)}>{children}</div>}
        {isRelationRecord && badges}
        <span style={{ textAlign: 'right', marginLeft: 'auto', maxWidth: '100%', ...(isRelationRecord ? { order: 2 } : {}) }}>
          <div data-message-author-controls="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
            <span style={{minWidth:0,display:'inline-flex',alignItems:'center',gap:5}}>{headerAuthor??<MessageAuthors message={msg} prefix="作者："/>}{headerAfterAuthor}</span>
            {headerExtra}
          </div>
        </span>
        </div>
      </div>

      {!isRelationRecord && badges}
      {isOrganizationMessage && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 8, marginBottom: 6,
        }}>
          <div style={{
            fontWeight: isRelationRecord ? 500 : 600, color: isRelationRecord ? '#cbd5e1' : '#f1f5f9',
            flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            userSelect: isActiveText ? 'text' : 'auto',
            cursor: isActiveText ? 'text' : 'inherit',
          }}>
          <MessageTextPart message={msg} activeText={isActiveText} onMouseUp={onContentMouseUp}>
            {isActiveText && msg.parts ? undefined : isSummary && organizationTitle ? (
              <>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{organizationTitle}</div>
              </>
            ) : organizationTitle || (isClassification ? `分类（${memberCount ?? 0}）`
              : isMerge ? `归并（${memberCount ?? 0}）`
              : `总结（${memberCount ?? 0}）`)}
          </MessageTextPart></div>
          {isClassification&&<span style={{
            fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 999,
            background: 'rgba(2,150,80,0.2)', color: '#86efac',
          }}>
            双击进入分类
          </span>}
        </div>
      )}

      {/* Text selection mode indicator */}
      {isActiveText && (isContentKind(msg.kind) || isOrganizationMessage) && (
        <div style={{ fontSize: 11, color: '#0b84ff', marginBottom: 4 }}>
          拖选文字即可选择片段，或点击已有高亮片段
        </div>
      )}

      {/* Content */}
      {!isOrganizationMessage && !inlineRelationContent && !(children != null && (msg.kind === 'relation' || msg.kind === 'join')) && msg.parts?.some(part => part.type === 'text' || part.type === 'code' || part.type === 'web') ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {msg.parts.filter(part => part.type === 'text' || part.type === 'code' || part.type === 'web').map(part => (
            <MessageTextPart key={part.id} message={msg} partId={part.id} activeText={isActiveText} onMouseUp={onContentMouseUp}>{msg.kind === 'normal' && msg.parts!.filter(item => ['text', 'code', 'web'].includes(item.type)).length === 1 ? children : undefined}</MessageTextPart>
          ))}
        </div>
      ) : !isOrganizationMessage && !inlineRelationContent && (
        <div style={{ fontSize: isRelationRecord ? 12 : prominence.fontSize, color: isRelationRecord ? '#9ca3af' : '#f5f5f5' }} onMouseUp={e => onContentMouseUp?.(e, msg.id)}>
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

      {/* Organization membership */}
      {isOrganizationMessage && (
        <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <MessageElement reference={messageMembersReference(msg)} selected={isMessageElementSelected(selectedUnits, messageMembersReference(msg))} label="所含消息">💬 {memberCount ?? 0} 条观点</MessageElement>
          <span>{new Date(msg.createdAt).toLocaleDateString('zh-CN')}</span>
        </div>
      )}

      {/* Overlays */}
      {relatedMessages}
      {overlays}
    </div>
  );
}
