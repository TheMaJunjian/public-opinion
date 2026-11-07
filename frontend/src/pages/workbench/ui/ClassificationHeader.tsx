import type { DemoMessage } from '../../../utils/modelBridge';
import type { ReactNode } from 'react';
import { MessageDisplayMarker } from '../../../components/LazyMessageDisplayHints';
interface Props {
  zhihuQuestion?: { description: string; known: boolean; completeness: 'complete' | 'partial' | 'unknown'; createdAt?: string | null; createdAtText?: string | null; locallyCorrectedBody?: boolean; locallyCorrectedTitle?: boolean };
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
  classifyTargetCount, classifyExitLabel, correctionRecords, zhihuQuestion, onExitTemporary: exitTemporaryCategory, onExitClassify: handleExitClassification }: Props) {
  const question = !recordCategory && !comparisonMode && correctionFilterTargetId === null && !isTemporaryJoinCategory ? zhihuQuestion : undefined;
  const questionDate = question?.createdAt ? new Date(question.createdAt) : null;
  const questionTime = question?.createdAtText || (questionDate && Number.isFinite(questionDate.getTime()) ? questionDate.toLocaleDateString('zh-CN') : '时间未记录');
  const classificationDate = currentClassifyRelMsg?.createdAt ? new Date(currentClassifyRelMsg.createdAt) : null;
  const classificationTime = classificationDate && Number.isFinite(classificationDate.getTime()) ? classificationDate.toLocaleDateString('zh-CN') : null;
  return (<>
    {(recordCategory || isInsideClassify || isTemporaryJoinCategory || correctionFilterTargetId !== null || comparisonMode) && (
      <div className="workbench-scope-header" style={{ flex: "0 0 auto", padding: "8px 8px 12px 8px", background: "var(--surface-101010)" }}>
        <div className="workbench-scope-card" style={{ border: "1px solid var(--line-334155)", borderRadius: 10, padding: "8px 10px", background: "linear-gradient(180deg, var(--surface-162036) 0%, var(--surface-0f172a) 100%)", color: "var(--ink-e2e8f0)", boxShadow: "0 6px 16px var(--shadow-rgba-0-0-0-0-25)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {recordCategory?`${recordCategory.label}记录临时分类（${recordCategory.recordIds.length}）`:comparisonMode
                  ? `选择对比消息（${comparisonTargetCount}）`
                  : correctionFilterTargetId !== null
                    ? `更正记录临时分类（${correctionCount}）`
                    : isTemporaryJoinCategory ? `${joinFilterDirection === 'outgoing' ? '被加入' : '加入'}记录临时分类（${temporaryJoinCount}）` : (classificationTitle || classifyKindLabel)}
              </div>
              {question?.locallyCorrectedTitle && <span style={{ fontSize: 11, color: 'var(--ink-93c5fd)', flexShrink: 0 }}>标题 · 本地补充</span>}
              {(!comparisonMode && (recordCategory || isTemporaryFrameCategory || correctionFilterTargetId !== null || isTemporaryJoinCategory)) && (
                <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: "var(--surface-rgba-34-197-94-0-18)", color: "var(--ink-86efac)", border: "1px solid var(--line-rgba-34-197-94-0-35)", flexShrink: 0 }}>
                  临时
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-94a3b8)", display: "flex", gap: 12, flexWrap: "wrap" }}>
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
                  {!isRouteScope && <span>{question ? '提问者：' : '由 '}<span style={{ fontWeight: 600, color: "var(--ink-cbd5e1)" }}>{currentClassifyRelMsg?.author ?? (question ? '作者未记录' : '系统')}</span>{question ? '' : ' 发起'}</span>}
                  <span>💬 {classifyTargetCount} 条观点</span>
                  {!isRouteScope && currentClassifyRelMsg && (question || classificationTime) && <span>{question ? questionTime : classificationTime}</span>}
                </>
              )}
            </div>
            {question && <details key={currentClassifyRelMsg?.id} open data-zhihu-question-description="true" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.8 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--ink-cbd5e1)', fontWeight: 600 }}>问题描述{question.locallyCorrectedBody && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--ink-93c5fd)' }}>本地补充</span>}</summary>
              {question.description ? <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 6 }}>{question.description}</div>
                : <p style={{ margin: '6px 0 0', color: 'var(--ink-94a3b8)' }}>{question.known && question.completeness === 'complete' ? '原站无问题描述' : '问题描述未取得'}</p>}
              {question.completeness === 'partial' && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ink-fbbf24)' }}>{question.locallyCorrectedBody ? '原文件只取得部分问题描述；本地补充不改变原始完整性记录。' : '这里只取得部分问题描述，内容可能不完整。'}</p>}
              {question.description && question.completeness === 'unknown' && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ink-94a3b8)' }}>{question.locallyCorrectedBody ? question.known ? '原文件问题描述的完整性尚未确认；当前显示本地补充。' : '原文件未取得问题描述；当前显示本地补充。' : '问题描述的完整性尚未确认。'}</p>}
            </details>}
          </div>
          <button className="workbench-scope-exit" onClick={() => {
            if (comparisonMode) {
              exitTemporaryCategory();
              return;
            }
            if (recordCategory || correctionFilterTargetId !== null || isTemporaryJoinCategory) {
              exitTemporaryCategory();
              return;
            }
            handleExitClassification();
          }} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid var(--line-475569)", background: "var(--surface-1e293b)", color: "var(--ink-e2e8f0)", cursor: "pointer", flexShrink: 0 }}>
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
