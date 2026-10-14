import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';
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
      const { messageId, kind, x, y } = decorationPopup;
      const matchingRelations = edges.filter(e =>
        e.relationType === kind && isWholeMessageSelection(e.to, messageId)
      ).map(e => {
        const relMsg = messages.find(m => m.id === e.relationMessageId);
        return relMsg ? { id: relMsg.id, author: relMsg.author, createdAt: relMsg.createdAt } : null;
      }).filter(Boolean) as { id: string; author: string; createdAt: string }[];
      return (
        <div key="dec-popup" onClick={() => onCloseDecoration()}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 200), width: 260, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
              {kind === "agree" ? "👍 赞同" : "👎 反对"} 记录（共 {matchingRelations.length} 条）
            </div>
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
            <button onClick={() => onCloseDecoration()}
              style={{ marginTop: 10, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}

    {/* Tag double-click popup: shows who tagged with the given label */}
    {tagPopup && (() => {
      const { messageId, tagLabel, relMsgIds, x, y, subDetails } = tagPopup;
      const taggers = relMsgIds.map(id => {
        const relMsg = messages.find(m => m.id === id);
        return relMsg ? { id: relMsg.id, author: relMsg.author, createdAt: relMsg.createdAt } : null;
      }).filter(Boolean) as { id: string; author: string; createdAt: string }[];
      return (
        <div key="tag-popup" onClick={() => onCloseTag()}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 300), width: 260, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
              🏷 「{tagLabel}」（共 {taggers.length} 人）<br />
              <span style={{ fontSize: 11, opacity: 0.7 }}>消息：{messageId}</span>
            </div>
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
            <button onClick={() => onCloseTag()}
              style={{ marginTop: 10, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}
    {mergeInfoPopup && (() => {
      const relMsg = messages.find(m => m.id === mergeInfoPopup.relMsgId);
      const left = Math.min(mergeInfoPopup.x, window.innerWidth - 320);
      const top = Math.min(mergeInfoPopup.y, window.innerHeight - 180);
      return (
        <div key="merge-info-popup" onClick={() => onCloseMerge()}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left, top, width: 300, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>
              归并关系信息
            </div>
            <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <div>创建者：<span style={{ fontWeight: 600 }}>{relMsg?.author ?? "未知"}</span></div>
              <div>发送时间：<span style={{ opacity: 0.8 }}>{relMsg ? new Date(relMsg.createdAt).toLocaleString() : "未知"}</span></div>
            </div>
            <button onClick={() => onCloseMerge()}
              style={{ marginTop: 12, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}

  </>
  );
}
