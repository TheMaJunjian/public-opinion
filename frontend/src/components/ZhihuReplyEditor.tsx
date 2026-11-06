import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UnitSelection } from '../utils/modelBridge';
import { zhihuStanceReference, zhihuWholeMessageUnit } from '../utils/zhihuSelection';
import { isCardWidth } from '../utils/cardWidth';
import { CARD_W } from '../utils/layout';
export { zhihuWholeMessageUnit } from '../utils/zhihuSelection';
import { getRelationTitle, type RelationPayload } from '../types';
import type { LocalSendControls } from './WorkbenchPanel';
import { useWorkbenchSendingProgress } from './WorkbenchLoadingBoundary';
import type { LocalRelationType } from '../pages/workbench/ui/RelationToolbar';
import { secondaryRelationLabel } from '../pages/workbench/model/relationComposition';
import { getZhihuCorrectableFields, getZhihuMissingContent, getZhihuInactiveRelationIds, sendZhihuLocalRelation, updateZhihuRelations, type ZhihuViewingData, type ZhihuLocalSendInput } from '../utils/zhihuArchive';

interface Props {
  data: ZhihuViewingData; sourceUnits: UnitSelection[]; targetUnits: UnitSelection[]; draftUnits: UnitSelection[];
  onSave: (next: ZhihuViewingData) => Promise<void>; onToggleReply?: (relationId: string) => void; onSent?: () => void;
  relationType: LocalRelationType | null; renderSendControls: (controls: LocalSendControls) => ReactNode;
  onBusyChange?: (busy: boolean) => void; currentClassificationId?: string | null; organizationError?: string | null;
  onSelectCorrection?: (messageId: string) => void;
  correctionMode?: 'text-correction' | 'width-adjustment';
  onCorrectionModeChange?: (mode: 'text-correction' | 'width-adjustment') => void;
  correctionWidth?: number;
  onCorrectionWidthChange?: (width: number) => void;
  nativeDocument?: boolean;
  buildRelation?: (input: ZhihuLocalSendInput) => ZhihuViewingData | Promise<ZhihuViewingData>;
}
const MISSING_PAGE_SIZE = 50;

/** A complete body part is an editable field; a text range or member address is not. */
function correctionSelection(data: ZhihuViewingData, unit: UnitSelection): boolean {
  if (zhihuWholeMessageUnit(data, unit)) return true;
  const message = data.messages.find(candidate => candidate.id === unit.messageId), reference = unit.reference;
  return Boolean(message && reference && reference.messageId === unit.messageId
    && (reference.revision === undefined || reference.revision === (message.revision ?? 1))
    && !reference.range && !reference.memberId && reference.partId === 'body'
    && (!reference.path?.length || reference.path.length === 1 && reference.path[0] === 'body')
    && unit.selection.kind === 'edge' && message.parts?.some(part => part.id === 'body' && part.type === 'text'));
}

/** Shares the native composer controls while writing only this local document. */
export default function ZhihuReplyEditor({ data, sourceUnits, targetUnits, draftUnits, onSave, onSent,
  relationType: selectedType, renderSendControls, onBusyChange, currentClassificationId, organizationError, onSelectCorrection,
  correctionMode: controlledCorrectionMode, onCorrectionModeChange, correctionWidth: controlledWidth, onCorrectionWidthChange, nativeDocument = false, buildRelation }: Props) {
  const [busy, setBusy] = useState(false), saving = useRef(false);
  const sendingProgress = useWorkbenchSendingProgress(busy, 'local');
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [missingOpen, setMissingOpen] = useState(false), [missingPage, setMissingPage] = useState(0);
  const [content, setContent] = useState(''), [direction, setDirection] = useState<'vertical' | 'horizontal'>('vertical');
  const [fallbackCorrectionMode, setFallbackCorrectionMode] = useState<'text-correction' | 'width-adjustment'>('text-correction');
  const [fallbackWidth, setFallbackWidth] = useState(CARD_W);
  const correctionMode = controlledCorrectionMode ?? fallbackCorrectionMode;
  const correctionWidth = controlledWidth ?? fallbackWidth;
  const changeCorrectionMode = (mode: 'text-correction' | 'width-adjustment') => { setFallbackCorrectionMode(mode); onCorrectionModeChange?.(mode); };
  const changeCorrectionWidth = (width: number) => { setFallbackWidth(width); onCorrectionWidthChange?.(width); };
  const [correctionChoice, setCorrectionChoice] = useState<{ messageId: string; field: 'body' | 'title' } | null>(null);
  const loadedCorrection = useRef('');
  const relationType = selectedType?.toUpperCase() as 'REPLY' | 'AGREE' | 'DISAGREE' | 'CLASSIFY' | 'SUMMARY' | 'MERGE' | 'ARRANGE' | 'CORRECT' | undefined;
  const isStance = relationType === 'AGREE' || relationType === 'DISAGREE';
  const isCorrection = relationType === 'CORRECT';
  const isWidthCorrection = isCorrection && correctionMode === 'width-adjustment';
  const isOrganization = ['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(relationType ?? '');
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const items = useMemo(() => Object.entries(data.zhihu.byMessageId).filter(([, meta]) => meta.kind === 'item'), [data.zhihu.byMessageId]);
  const [selectedThread, setSelectedThread] = useState(items[0]?.[1].threadId ?? '');
  // The native composer uses the current canvas selection as targets until targets are explicitly committed.
  const effectiveTargets = draftUnits.length ? draftUnits : targetUnits;
  const sourceIds = [...new Set(sourceUnits.map(unit => unit.messageId))], targetIds = [...new Set(effectiveTargets.map(unit => unit.messageId))];
  const correctionTarget = targetIds.length === 1 ? targetIds[0] : null;
  const correctableFields = correctionTarget && !isWidthCorrection ? getZhihuCorrectableFields(data, correctionTarget) : [];
  const correctionField = correctableFields.find(field => field.field === (correctionChoice?.messageId === correctionTarget ? correctionChoice.field : 'body')) ?? correctableFields[0];
  const correctionKey = isCorrection && correctionTarget && correctionField ? `${correctionTarget}:${correctionField.field}` : '';
  useEffect(() => {
    if (correctionKey !== loadedCorrection.current) {
      loadedCorrection.current = correctionKey;
      if (correctionKey) setContent(correctionField?.value ?? '');
    }
  }, [correctionKey, correctionField?.value]);
  const missingContent = useMemo(() => nativeDocument ? [] : getZhihuMissingContent(data), [data, nativeDocument]);
  const missingPages = Math.max(1, Math.ceil(missingContent.length / MISSING_PAGE_SIZE));
  const currentMissingPage = Math.min(missingPage, missingPages - 1);
  const visibleMissing = missingOpen ? missingContent.slice(currentMissingPage * MISSING_PAGE_SIZE, (currentMissingPage + 1) * MISSING_PAGE_SIZE) : [];
  useEffect(() => { setMissingPage(0); setMissingOpen(false); }, [data.zhihu.archiveId]);
  const selectedIds = [...new Set([...draftUnits, ...sourceUnits].map(unit => unit.messageId))];
  const messageById = useMemo(() => new Map(data.messages.map(message => [message.id, message])), [data.messages]);
  const inactive = useMemo(() => getZhihuInactiveRelationIds(data), [data]);
  const sourceReferences = isStance ? sourceUnits.map(unit => zhihuStanceReference(data, unit, messageById)) : [];
  const targetReferences = isStance ? effectiveTargets.map(unit => zhihuStanceReference(data, unit, messageById)) : [];
  const sourceValid = sourceIds.every(id => messageById.has(id) && (isStance || !inactive.has(id)));
  const targetValid = targetIds.every(id => messageById.has(id) && (isStance || !inactive.has(id)));
  const append = isOrganization && sourceIds.length === 1 && messageById.get(sourceIds[0])?.relationType === relationType;
  const organizationSourcesValid = !isOrganization || sourceIds.length === 0 || append;
  const conflictingTargets = draftUnits.length > 0 && targetUnits.length > 0;
  const overlappingRoles = sourceIds.some(id => targetIds.includes(id));
  const wholeSelections = isStance ? [...sourceReferences, ...targetReferences].every(reference => reference !== null)
    : [...sourceUnits, ...effectiveTargets].every(unit => isCorrection && !isWidthCorrection ? correctionSelection(data, unit) : zhihuWholeMessageUnit(data, unit) !== null);
  const needsTitle = !append && (relationType === 'CLASSIFY' || relationType === 'SUMMARY');
  const targetsReady = targetIds.length > 0 || (!append && relationType === 'CLASSIFY') || (!append && relationType === 'ARRANGE' && content.trim().length > 0);
  const valid = Boolean(relationType) && !conflictingTargets && !overlappingRoles && wholeSelections && sourceValid && targetValid && organizationSourcesValid
    && (!isOrganization || !organizationError) && targetsReady && (!needsTitle || content.trim().length > 0)
    && (!isCorrection || sourceIds.length === 0 && targetIds.length === 1 && (isWidthCorrection ? isCardWidth(correctionWidth) : Boolean(correctionField) && content.trim().length > 0 && content !== correctionField?.value))
    && (relationType !== 'REPLY' || sourceIds.length > 0);
  const canSend = !busy && valid;
  const selectionHint = !relationType ? '请选择回复、赞同、反对、更正或一种组织关系。'
    : conflictingTargets ? '选择暂存区和目标集合同时有内容，请合并到目标集合或清空其中一方。'
      : overlappingRoles ? '同一条消息不能同时作为来源和目标。'
        : !wholeSelections ? isStance ? '请选择此文档中的有效消息、片段或关系；过期地址不能发送。' : '请选择完整消息或当前关系类型；正文片段和历史版本不会被当作整条关系。'
      : !sourceValid || !targetValid ? '请选择此文档中仍可见的消息。'
        : isCorrection ? sourceIds.length ? '更正时来源集合留空，只选择一个要更正的消息。'
          : isWidthCorrection ? targetIds.length !== 1 ? '请选择一条完整消息进行宽度更正。'
            : !isCardWidth(correctionWidth) ? '消息卡宽度须为 320 至 2400 像素的整数。'
              : '调整这条消息的显示宽度，原文不变；发送后保存到当前浏览器。'
          : !correctionField || targetIds.length !== 1 ? '请选择一个可更正正文的消息；问题可分别更正标题与描述。'
            : !content.trim() ? `请输入更正后的${correctionField.label}。`
              : content === correctionField.value ? `尚未修改${correctionField.label}，修改后可发送更正。`
                : `更正${correctionField.label}：显示为本地补充，原始记录和完整性状态保留；反对此更正可撤回。`
        : !organizationSourcesValid ? '新建组织时来源集合留空；追加成员时，来源只放一个同类型容器。'
          : isOrganization && organizationError ? organizationError
            : relationType === 'REPLY' ? !sourceIds.length ? '请将要发出回复的消息加入来源集合。'
              : !targetIds.length ? '请选择被回复的消息，或将其加入目标集合。'
                : `每条来源消息回复全部目标；每次发送新增独立回复，已有回复继续保留。本次 ${sourceIds.length} 条回复、${sourceIds.length * targetIds.length} 个连接。`
              : isStance ? targetIds.length
                ? relationType === 'AGREE' ? '赞同所选消息、片段或关系；来源集合表示依据，操作仅保存在本地。'
                  : '反对所选目标；整条回复、组织或更正关系被反对后隐藏其效果，正文与片段只记录表态。'
                : `请在画布中选中要${relationType === 'AGREE' ? '赞同' : '反对'}的消息、片段或关系；来源集合表示依据，不会被当作表态对象。`
                : append ? `向来源容器追加 ${targetIds.length} 个目标成员，原有成员保留。`
                  : relationType === 'CLASSIFY' ? '目标成为新分类的成员；填写分类名称，也可以先创建空分类。'
                    : relationType === 'SUMMARY' ? '目标成为总结成员；输入总结正文。'
                      : relationType === 'MERGE' ? '将目标归并到同一容器，不合并或改写原文。'
                        : '按目标集合中的顺序排列；移除后重新加入可调整顺序。可附加一条本地文本。';
  const commentNumbers = useMemo(() => {
    const numbers = new Map<string, number>(), threadCounts = new Map<string, number>();
    for (const comment of data.zhihu.archive.comments) {
      const number = (threadCounts.get(comment.threadId) ?? 0) + 1; threadCounts.set(comment.threadId, number);
      numbers.set(JSON.stringify([comment.threadId, comment.sourceId || comment.id]), number);
    }
    return numbers;
  }, [data.zhihu.archive.comments]);
  const describe = (id: string) => {
    const meta = data.zhihu.byMessageId[id], message = messageById.get(id);
    const text = (getRelationTitle(message?.relationPayload as RelationPayload | undefined) || message?.content)?.replace(/\s+/g, ' ').slice(0, 48) || '无文字正文';
    const number = meta?.kind === 'comment' ? commentNumbers.get(JSON.stringify([meta.threadId, meta.sourceId])) : undefined;
    const itemType = meta?.threadId.startsWith('answer:') ? '回答' : meta?.threadId.startsWith('article:') ? '文章' : meta?.threadId.startsWith('pin:') ? '想法' : '作品';
    const isOriginal = meta && ['item', 'comment', 'question'].includes(meta.kind);
    return `${meta?.kind === 'item' ? itemType : meta?.kind === 'question' ? '问题' : number ? `第${number}条评论` : '消息'} · ${meta?.authorName || (isOriginal ? '作者未记录' : '本地整理')} · ${text}`;
  };
  const labels = { REPLY: '回复', AGREE: '赞同', DISAGREE: '反对', CLASSIFY: '分类', SUMMARY: '总结', MERGE: '归并', ARRANGE: '排列', CORRECT: '更正' };
  async function apply(change: () => ZhihuViewingData | Promise<ZhihuViewingData>, message: string, clearSelection = false) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await sendingProgress.prepare();
      const next = await change();
      // Local operations leave the source archive intact. Compare only the
      // editing records instead of materializing and serializing it twice.
      const changed = JSON.stringify([next.zhihu.overrides, next.zhihu.localOperations])
        !== JSON.stringify([data.zhihu.overrides, data.zhihu.localOperations]);
      await onSave(next); setNotice(changed ? message : '阅览设置已保存；关系没有变化。');
      if (clearSelection) { setContent(''); onSent?.(); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，请重试。'); }
    finally { saving.current = false; setBusy(false); sendingProgress.finish(); }
  }

  return <section aria-label="知乎本地回复关系" style={{ display: 'contents' }}>
    {renderSendControls({ enabled: canSend, hint: '只保存在本机，不会发布到公论。',
      feedback: <>
        <p role="note" style={{ margin: 0, fontSize: 12, color: valid ? 'var(--ink-94a3b8)' : 'var(--ink-fbbf24)' }}>{selectionHint}</p>
        {busy && <div role="status">正在保存…</div>}
        {notice && <div role="status">{notice}</div>}
        {error && <div role="alert">{error}</div>}
      </>,
      ...(isOrganization || isCorrection ? { composer: {
        content: append || relationType === 'MERGE' ? '' : content, onContentChange: setContent, disabled: busy,
        readOnly: append || relationType === 'MERGE',
        placeholder: isCorrection ? `输入更正后的${correctionField?.label ?? '内容'}（保留原文）` : append ? '加入已有容器消息，此处不可输入' : relationType === 'CLASSIFY' ? '输入分类名称（不能为空）'
          : relationType === 'SUMMARY' ? '输入总结内容（不能为空）' : relationType === 'MERGE' ? '归并目标消息，此处无需输入正文' : '可选：输入文本消息加入排列框架',
        ...(!append && relationType === 'ARRANGE' ? { direction, onDirectionChange: setDirection } : {}),
        ...(isCorrection ? { secondaryChoices: {
          options: ['text-correction', 'width-adjustment'], value: correctionMode,
          onChange: (mode: string) => { if (mode === 'text-correction' || mode === 'width-adjustment') changeCorrectionMode(mode); },
          label: secondaryRelationLabel,
        } } : {}),
        ...(isWidthCorrection ? { widthAdjustment: { width: correctionWidth, onChange: changeCorrectionWidth } } : {}),
        ...(isCorrection && correctionField ? { settings: <div style={{ display: 'grid', gap: 5 }}>
          {correctableFields.length > 1 ? <label>更正字段 <select aria-label="更正字段" value={correctionField.field} disabled={busy}
            onChange={event => setCorrectionChoice({ messageId: correctionTarget!, field: event.target.value as 'body' | 'title' })}>
            {correctableFields.map(field => <option key={field.field} value={field.field}>{field.label}</option>)}
          </select></label> : <span>更正字段：{correctionField.label}</span>}
          <span style={{ opacity: 0.75 }}>原始字段：{correctionField.originalStatus === 'complete' ? '已完整取得' : correctionField.originalStatus === 'partial' ? '仅取得部分' : '完整性未确认'}{correctionField.localCorrectionId ? ' · 当前显示已有本地补充' : ''}</span>
        </div> } : {}),
      } } : {}),
      onSend: () => {
        if (!canSend || !relationType) return;
        void apply(() => (buildRelation ?? ((input: ZhihuLocalSendInput) => sendZhihuLocalRelation(data, input)))({
          relationType, sourceMessageIds: isStance ? sourceUnits.map(unit => unit.messageId) : sourceIds,
          targetMessageIds: isStance ? effectiveTargets.map(unit => unit.messageId) : targetIds, currentClassificationId,
          ...(isStance ? { sourceReferences: sourceReferences.filter(reference => reference !== null), targetReferences: targetReferences.filter(reference => reference !== null) } : {}),
          ...(!append && relationType === 'CLASSIFY' ? { title: content.trim() } : {}),
          ...(!append && ['SUMMARY', 'ARRANGE'].includes(relationType) ? { content: content.trim() } : {}),
          ...(isWidthCorrection ? { correctionKind: 'WIDTH' as const, correctionWidth } : isCorrection && correctionField ? { content, correctionField: correctionField.field } : {}),
          ...(!append && relationType === 'ARRANGE' ? { targetLayout: direction === 'horizontal' ? 'single-row' : 'single-column' } : {}),
        }), `${labels[relationType]}已发送，只保存在本机。`, true);
      },
    })}
    <section className="workbench-record-section" aria-label="知乎资料整理" style={{ border: '1px solid var(--line-444)', borderRadius: 6, padding: 8, display: 'grid', gap: 8, fontSize: 12 }}>
    <div style={{ fontWeight: 600 }}>知乎资料整理</div>
    <p style={{ margin: 0, opacity: 0.8 }}>在图形或列表中选择消息和关系，可直接作为目标，也可加入来源／目标集合。操作只保存到本机阅览文档，无需登录。</p>
    {!nativeDocument && <details open={missingOpen} onToggle={event => setMissingOpen(event.currentTarget.open)}><summary>缺失或待确认的内容（{missingContent.length}）</summary>
      {missingOpen && <>
      <p style={{ margin: '6px 0', opacity: 0.7 }}>按原文件的缺失、部分内容或完整性提示列出；不推测缺了哪些字。点击会清空当前来源／目标选择，定位该消息并准备更正。</p>
      {missingContent.length > MISSING_PAGE_SIZE && <nav aria-label="缺失内容分页" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <button type="button" disabled={currentMissingPage === 0} onClick={() => setMissingPage(currentMissingPage - 1)}>上一页</button>
        <span>第 {currentMissingPage + 1} / {missingPages} 页 · 每页 {MISSING_PAGE_SIZE} 条</span>
        <button type="button" disabled={currentMissingPage + 1 >= missingPages} onClick={() => setMissingPage(currentMissingPage + 1)}>下一页</button>
      </nav>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
        {visibleMissing.map(entry => <li key={`${entry.messageId}:${entry.field}`} data-missing-message={entry.messageId} data-missing-field={entry.field}>
          <button type="button" disabled={busy || !onSelectCorrection} onClick={() => {
            changeCorrectionMode('text-correction');
            setCorrectionChoice({ messageId: entry.messageId, field: entry.field });
            onSelectCorrection?.(entry.messageId);
          }} style={{ width: '100%', textAlign: 'left', padding: '6px 8px', border: '1px solid var(--line-444)', borderRadius: 4, background: 'var(--surface-222)', color: 'var(--ink-eee)' }}>
            <span>{entry.label}{entry.localCorrectionId ? ' · 已本地补充' : ''}</span>
            <span style={{ display: 'block', marginTop: 3, overflowWrap: 'anywhere' }}>{describe(entry.messageId)}</span>
            <span style={{ display: 'block', marginTop: 3, opacity: 0.75 }}>{entry.issue}</span>
          </button>
        </li>)}
        {!missingContent.length && <li style={{ opacity: 0.7 }}>原文件没有标记需要补充或确认的内容。</li>}
      </ul>
      </>}
    </details>}
    <details><summary>{nativeDocument ? '阅览设置' : '顺序整理与阅览设置'}</summary>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 6 }}>
        {!nativeDocument && <><label>整理的作品 <select aria-label="顺序整理的作品" value={selectedThread} onChange={event => setSelectedThread(event.target.value)} style={{ maxWidth: '100%' }}>
          {items.map(([id, meta], index) => <option key={id} value={meta.threadId}>{messageById.get(id)?.content?.slice(0, 45) || `作品 ${index + 1}`}</option>)}
        </select></label>
        <button type="button" disabled={!selectedThread} onClick={() => void apply(() => updateZhihuRelations(data, { mode: 'sequence', threadId: selectedThread }), '未知回复已按原文件顺序补齐，并保存。')}>按顺序补齐未知回复</button></>}
        <button type="button" onClick={() => void apply(() => data, '阅览设置已保存。')}>保存阅览设置</button>
      </fieldset>
      {!nativeDocument && <p style={{ margin: '6px 0', opacity: 0.7 }}>顺序整理只补未知关系，按原文件排列，已有回复保留。</p>}
    </details>
    {!!selectedIds.length && <details open><summary>选中消息的原始信息</summary>
      <ul style={{ margin: '6px 0', paddingLeft: 20 }}>{selectedIds.map(id => {
        const meta = data.zhihu.byMessageId[id]; if (!meta) return null;
        const correctedFields = getZhihuCorrectableFields(data, id).filter(field => field.localCorrectionId);
        return <li key={id} style={{ marginBottom: 6 }}>{meta.authorName || '作者未记录'} · {meta.createdAtText || meta.createdAt || '时间未记录'}
          {!!correctedFields.length && <span> · 本地补充：{correctedFields.map(field => field.label).join('、')}（原始记录保留）</span>}
          {meta.sourceLabels.length > 0 && <span> · 原站标签：{meta.sourceLabels.join('、')}</span>}
          {meta.sourceUrl && <> · <a href={meta.sourceUrl} target="_blank" rel="noreferrer">查看知乎原文</a></>}
        </li>;
      })}</ul>
    </details>}
    {data.zhihu.warnings.length > 0 && <details><summary>原文件提示（{data.zhihu.warnings.length}）</summary><ul>{data.zhihu.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <p style={{ margin: 0, opacity: 0.75 }}>{notice ? '已保存到当前浏览器。' : '本地操作保存到当前浏览器。'}要保存 JSON 文件，请使用“下载阅览文件”{nativeDocument ? '，可下载新文件或选择已有阅览文件更新。' : '；不会覆盖打开的原文件。'}</p>
    </section>
  </section>;
}
