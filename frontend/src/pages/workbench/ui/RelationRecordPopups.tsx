import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';
import { useRef, type ReactNode } from 'react';
import PopupOverlay from '../../../components/PopupOverlay';
import { DIALOG_BACKDROP, dialogStyles } from '../../../components/dialogStyles';

function RecordDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  return <PopupOverlay contentRef={contentRef} zIndex={1000} background={DIALOG_BACKDROP} onClick={onClose}
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }}>
    <div ref={contentRef} role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}
      style={{ ...dialogStyles.panel, width: 'min(460px, 100%)', maxHeight: '100%', overflow: 'auto' }}>
      <div style={dialogStyles.header}>{title}</div>
      <div style={dialogStyles.body}>{children}</div>
      <div style={dialogStyles.footer}><button data-shortcut-cancel="true" onClick={onClose} style={dialogStyles.button}>关闭</button></div>
    </div>
  </PopupOverlay>;
}
interface DecorationPopup { messageId: string; kind: 'agree' | 'disagree'; x: number; y: number }
interface TagPopup { messageId: string; tagLabel: string; relMsgIds: string[]; x: number; y: number; subDetails?: Array<{ subType: string; customLabel?: string; count: number }> }
interface MergePopup { relMsgId: string; x: number; y: number }
interface Props {
  messages: DemoMessage[]; edges: DemoEdge[];
  decorationPopup: DecorationPopup | null; tagPopup: TagPopup | null; mergeInfoPopup: MergePopup | null;
  onCloseDecoration: () => void; onCloseTag: () => void; onCloseMerge: () => void;
}
export default function RelationRecordPopups({ messages, edges, decorationPopup, tagPopup, mergeInfoPopup, onCloseDecoration, onCloseTag, onCloseMerge }: Props) {
  return (<>
    {/* Decoration double-click popup: shows sender info for agree/disagree relations */}
    {decorationPopup && (() => {
      const { messageId, kind } = decorationPopup;
      const matchingRelations = edges.filter(e =>
        e.relationType === kind && isWholeMessageSelection(e.to, messageId)
      ).map(e => {
        const relMsg = messages.find(m => m.id === e.relationMessageId);
        return relMsg ? { id: relMsg.id, author: relMsg.author, createdAt: relMsg.createdAt } : null;
      }).filter(Boolean) as { id: string; author: string; createdAt: string }[];
      return (
        <RecordDialog title={`${kind === 'agree' ? '👍 赞同' : '👎 反对'} 记录（共 ${matchingRelations.length} 条）`} onClose={onCloseDecoration}>
            {matchingRelations.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>暂无记录</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 160, overflow: "auto", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {matchingRelations.map(r => (
                  <li key={r.id} style={{ padding: "4px 6px", borderRadius: 4, background: "#2a2a2a", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{r.author}</span>
                    <span style={{ opacity: 0.6 }}>{new Date(r.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
        </RecordDialog>
      );
    })()}

    {/* Tag double-click popup: shows who tagged with the given label */}
    {tagPopup && (() => {
      const { messageId, tagLabel, relMsgIds, subDetails } = tagPopup;
      const taggers = relMsgIds.map(id => {
        const relMsg = messages.find(m => m.id === id);
        return relMsg ? { id: relMsg.id, author: relMsg.author, createdAt: relMsg.createdAt } : null;
      }).filter(Boolean) as { id: string; author: string; createdAt: string }[];
      return (
        <RecordDialog title={`🏷 「${tagLabel}」（共 ${taggers.length} 人）`} onClose={onCloseTag}>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8, overflowWrap: 'anywhere' }}>消息：{messageId}</div>
            {/* SubType breakdown */}
            {subDetails && subDetails.length > 0 && (
              <div style={{ marginBottom: 8, padding: "6px 8px", borderRadius: 4, background: "#2a2a2a", fontSize: 11 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, opacity: 0.8 }}>理由明细：</div>
                {subDetails.map(d => {
                  const stLabels: Record<string, string> = { SPAM: '垃圾', OFFTOPIC: '跑题', LOWVALUE: '低质', IMPORTANT: '重要', CUSTOM: '自定义' };
                  return (
                    <div key={d.subType} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                      <span>{d.customLabel || stLabels[d.subType] || d.subType}</span>
                      <span style={{ fontWeight: 600 }}>{d.count}人</span>
                    </div>
                  );
                })}
              </div>
            )}
            {taggers.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>暂无记录</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 160, overflow: "auto", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {taggers.map(r => (
                  <li key={r.id} style={{ padding: "4px 6px", borderRadius: 4, background: "#2a2a2a", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{r.author}</span>
                    <span style={{ opacity: 0.6 }}>{new Date(r.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
        </RecordDialog>
      );
    })()}
    {mergeInfoPopup && (() => {
      const relMsg = messages.find(m => m.id === mergeInfoPopup.relMsgId);
      return (
        <RecordDialog title="归并关系信息" onClose={onCloseMerge}>
            <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <div>创建者：<span style={{ fontWeight: 600 }}>{relMsg?.author ?? "未知"}</span></div>
              <div>发送时间：<span style={{ opacity: 0.8 }}>{relMsg ? new Date(relMsg.createdAt).toLocaleString() : "未知"}</span></div>
            </div>
        </RecordDialog>
      );
    })()}

  </>
  );
}
