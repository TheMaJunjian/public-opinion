import type { DemoMessage } from '../../../utils/modelBridge';
import type { ReactNode } from 'react';
import { MessageDisplayMarker } from '../../../components/LazyMessageDisplayHints';
interface Props {
  recordCategory?:{targetId:string;label:string;recordIds:string[]}|null;
  isTemporaryFrameCategory?: boolean;
  isInsideClassify: boolean; isRouteScope?: boolean; isTemporaryJoinCategory: boolean; correctionFilterTargetId: string | null; comparisonMode: boolean;
  comparisonTargetCount: number; correctionCount: number; temporaryJoinCount: number; classificationTitle: string; classifyKindLabel: string;
  comparisonTargetId: string | null; joinFilterTargetId: string | null; currentClassifyRelMsg: DemoMessage | null | undefined;
  joinFilterDirection?: 'incoming' | 'outgoing';
  correctionRecords?:ReactNode;
  classifyTargetCount: number; classifyExitLabel: string; onExitTemporary: () => void; onExitClassify: () => void;
}
export default function ClassificationHeader({ recordCategory, isInsideClassify, isRouteScope = false, isTemporaryFrameCategory = false, isTemporaryJoinCategory, correctionFilterTargetId, comparisonMode,
  comparisonTargetCount, correctionCount, temporaryJoinCount, classificationTitle, classifyKindLabel, comparisonTargetId, joinFilterTargetId, joinFilterDirection = 'incoming', currentClassifyRelMsg,
  classifyTargetCount, classifyExitLabel, correctionRecords, onExitTemporary: exitTemporaryCategory, onExitClassify: handleExitClassification }: Props) {
  return (<>
    {(recordCategory || isInsideClassify || isTemporaryJoinCategory || correctionFilterTargetId !== null || comparisonMode) && (
      <div style={{ flex: "0 0 auto", padding: "8px 8px 12px 8px", background: "#101010" }}>
        <div style={{ border: "1px solid #334155", borderRadius: 10, padding: "8px 10px", background: "linear-gradient(180deg, #162036 0%, #0f172a 100%)", color: "#e2e8f0", boxShadow: "0 6px 16px rgba(0,0,0,0.25)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {recordCategory?`${recordCategory.label}记录临时分类（${recordCategory.recordIds.length}）`:comparisonMode
                  ? `选择对比消息（${comparisonTargetCount}）`
                  : correctionFilterTargetId !== null
                    ? `更正记录临时分类（${correctionCount}）`
                    : isTemporaryJoinCategory ? `${joinFilterDirection === 'outgoing' ? '被加入' : '加入'}记录临时分类（${temporaryJoinCount}）` : (classificationTitle || classifyKindLabel)}
              </div>
              {(!comparisonMode && (recordCategory || isTemporaryFrameCategory || correctionFilterTargetId !== null || isTemporaryJoinCategory)) && (
                <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: "rgba(34,197,94,0.18)", color: "#86efac", border: "1px solid rgba(34,197,94,0.35)", flexShrink: 0 }}>
                  临时
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 12, flexWrap: "wrap" }}>
              {recordCategory?<span>目标消息 {recordCategory.targetId} 的{recordCategory.label}消息</span>:comparisonMode ? (
                <span>{comparisonTargetId ? `正在审阅目标消息 ${comparisonTargetId}` : '选择消息，查看赞同后与反对后的显示效果'}</span>
              ) : correctionFilterTargetId !== null ? (
                <span>目标消息 {correctionFilterTargetId} 的全部更正消息</span>
              ) : isTemporaryJoinCategory ? (
                <span>{joinFilterDirection === 'outgoing' ? `成员加入容器 ${joinFilterTargetId} 的全部记录（按当前采用和未采用分组，标明目标消息当前位置）` : `消息 ${joinFilterTargetId} 加入容器的全部记录（含生效和未生效记录）`}</span>
              ) : (
                <>
                  {currentClassifyRelMsg && <span><span>{currentClassifyRelMsg.id}</span><MessageDisplayMarker messageId={currentClassifyRelMsg.id} /></span>}
                  {correctionRecords}
                  {!isRouteScope && <span>由 <span style={{ fontWeight: 600, color: "#cbd5e1" }}>{currentClassifyRelMsg?.author ?? "系统"}</span> 发起</span>}
                  <span>💬 {classifyTargetCount} 条观点</span>
                  {!isRouteScope && currentClassifyRelMsg && <span>{new Date(currentClassifyRelMsg.createdAt).toLocaleDateString('zh-CN')}</span>}
                </>
              )}
            </div>
          </div>
          <button onClick={() => {
            if (comparisonMode) {
              exitTemporaryCategory();
              return;
            }
            if (recordCategory || correctionFilterTargetId !== null || isTemporaryJoinCategory) {
              exitTemporaryCategory();
              return;
            }
            handleExitClassification();
          }} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #475569", background: "#1e293b", color: "#e2e8f0", cursor: "pointer", flexShrink: 0 }}>
            {comparisonMode ? "退出对比" : recordCategory || isTemporaryFrameCategory || correctionFilterTargetId !== null || isTemporaryJoinCategory
              ? "退出临时分类"
              : classifyExitLabel}
          </button>
        </div>
      </div>
    )}


  </>
  );
}
