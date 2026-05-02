/**
 * DraftPanel.tsx — Candidate/Draft area + Sources/Targets management + relation creation form
 *
 * Implements the "draft → sources / targets → create relation" workflow described in the design:
 *   1. Items arrive in the "Draft" (候选区) when the user clicks messages/relations in the graph.
 *   2. Draft items can be promoted to Sources (来源集合) or Targets (目标集合).
 *   3. Constraints:
 *      - Sources: only text messages (never relation messages or fragments of relations).
 *      - Targets: text messages, text fragments, OR relation messages / relation parts.
 *   4. User picks a relation type and one of 4 action buttons.
 *
 * Four action buttons:
 *   A. 仅发送消息                       — send new message only (no relation)
 *   B. 发送消息并建立关系（用候选作目标）— send new message, use Draft as relation targets
 *   C. 发送新消息并建立关系（Targets集合）— send new message, use committed Targets as relation targets
 *   D. 仅用已有消息建立关系（Sources/Targets集合）— create relation using existing Sources/Targets only
 */

import { useState, useCallback } from 'react';
import type { Message, Relation, TargetRef } from '../types';
import { PRESENTATION_SPECS, getPresentationSpec } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A selectable unit in the draft/sources/targets system.
 * Discriminated union to support text messages, text fragments, and relation messages.
 */
export type DraftItem =
  | { type: 'message'; id: string }
  | { type: 'text-fragment'; messageId: string; text: string; hash: string }
  | { type: 'relation'; id: string; part?: 'label' | 'decoration' | 'frame' | 'whole' };

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  messages: Message[];
  relations: Relation[];
  draft: DraftItem[];
  sources: DraftItem[];
  targets: DraftItem[];
  onDraftRemove: (idx: number) => void;
  onDraftToSources: (idx: number) => void;
  onDraftToTargets: (idx: number) => void;
  onDraftToTargetsAll: () => void;
  /** Move all text-message items from draft to sources (all at once) */
  onDraftToSourcesAll: () => void;
  onSourcesRemove: (idx: number) => void;
  onTargetsRemove: (idx: number) => void;
  onClearAll: () => void;
  /** Send new message only (action A) */
  onSendMessage: (content: string) => Promise<void>;
  /** Send new message + create relation (action B: draft as targets, action C: targets collection) */
  onSendAndRelate: (data: {
    relationType: string;
    newMessageContent: string;
    targetRefs: TargetRef[];
  }) => Promise<void>;
  /** Create relation with existing sources and targets (action D) */
  onRelateOnly: (data: {
    relationType: string;
    sourceMessageId: string;
    targetRefs: TargetRef[];
  }) => Promise<void>;
  onImport: (json: string) => void;
  onExport: () => string;
}

// ─── Draft grouping ───────────────────────────────────────────────────────────

/**
 * A draft group represents all draft entries belonging to one text message:
 * - optionally a whole-message selection (wholeIdx !== null)
 * - zero or more text-fragment selections
 */
interface MessageDraftGroup {
  messageId: string;
  /** Index in the draft array for the whole-message item, or null if not present */
  wholeIdx: number | null;
  /** Fragments belonging to this message */
  fragments: Array<{ idx: number; text: string; hash: string }>;
}

interface RelationDraftItem {
  idx: number;
  item: Extract<DraftItem, { type: 'relation' }>;
}

function buildDraftGroups(draft: DraftItem[]): {
  msgGroups: MessageDraftGroup[];
  relItems: RelationDraftItem[];
} {
  const groupMap = new Map<string, MessageDraftGroup>();
  const relItems: RelationDraftItem[] = [];

  draft.forEach((item, idx) => {
    if (item.type === 'message') {
      const g = groupMap.get(item.id) ?? { messageId: item.id, wholeIdx: null, fragments: [] };
      g.wholeIdx = idx;
      groupMap.set(item.id, g);
    } else if (item.type === 'text-fragment') {
      const g = groupMap.get(item.messageId) ?? { messageId: item.messageId, wholeIdx: null, fragments: [] };
      g.fragments.push({ idx, text: item.text, hash: item.hash });
      groupMap.set(item.messageId, g);
    } else if (item.type === 'relation') {
      relItems.push({ idx, item });
    }
  });

  return { msgGroups: Array.from(groupMap.values()), relItems };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function itemLabel(item: DraftItem, messages: Message[], relations: Relation[]): string {
  if (item.type === 'message') {
    const msg = messages.find(m => m.id === item.id);
    if (!msg) return `消息 ${item.id.slice(0, 8)}…`;
    return `[${msg.createdBy.username}] ${msg.content.slice(0, 30)}${msg.content.length > 30 ? '…' : ''}`;
  }
  if (item.type === 'text-fragment') {
    const msg = messages.find(m => m.id === item.messageId);
    return `[${msg?.createdBy.username ?? '?'}的片段] "${item.text.slice(0, 20)}${item.text.length > 20 ? '…' : ''}"`;
  }
  const rel = relations.find(r => r.id === item.id);
  if (!rel) return `关系 ${item.id.slice(0, 8)}…`;
  const spec = getPresentationSpec(rel.relationType);
  const src = messages.find(m => m.id === rel.sourceMessageId);
  const partSuffix = item.part && item.part !== 'whole' ? `.${item.part}` : '';
  return `[${src?.createdBy.username ?? '?'}的${spec.label}关系${partSuffix}]`;
}

function isTextItem(item: DraftItem): boolean {
  return item.type === 'message' || item.type === 'text-fragment';
}

function draftItemToTargetRef(item: DraftItem): TargetRef {
  if (item.type === 'message') {
    return { kind: 'message', messageId: item.id };
  }
  if (item.type === 'text-fragment') {
    return { kind: 'text-fragment', messageId: item.messageId, text: item.text, hash: item.hash };
  }
  return {
    kind: 'relation',
    relationId: item.id,
    part: item.part && item.part !== 'whole' ? item.part : undefined,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function DraftPanel({
  messages,
  relations,
  draft,
  sources,
  targets,
  onDraftRemove,
  onDraftToSources,
  onDraftToTargets,
  onDraftToTargetsAll,
  onSourcesRemove,
  onTargetsRemove,
  onClearAll,
  onSendMessage,
  onSendAndRelate,
  onRelateOnly,
  onImport,
  onExport,
}: Props) {
  const [relationType, setRelationType] = useState('REPLY');
  const [newMsgContent, setNewMsgContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  const spec = getPresentationSpec(relationType);

  function clearError() { setError(''); }

  // ── Action A: 仅发送消息 ────────────────────────────────────────────────
  async function handleSendOnly(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    if (!newMsgContent.trim()) { setError('请输入消息内容'); return; }
    setSubmitting(true);
    try {
      await onSendMessage(newMsgContent.trim());
      setNewMsgContent('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Action B: 发送消息并建立关系（用候选作目标）─────────────────────────
  async function handleSendWithDraft(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    if (!newMsgContent.trim()) { setError('请输入消息内容'); return; }
    if (draft.length === 0) { setError('候选区为空，请先选择目标（单击消息卡片）'); return; }
    setSubmitting(true);
    try {
      await onSendAndRelate({
        relationType,
        newMessageContent: newMsgContent.trim(),
        targetRefs: draft.map(draftItemToTargetRef),
      });
      setNewMsgContent('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Action C: 发送新消息并建立关系（Targets集合）───────────────────────
  async function handleSendWithTargets(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    if (!newMsgContent.trim()) { setError('请输入消息内容'); return; }
    if (targets.length === 0) { setError('目标集合为空，请先将候选区内容移入目标集合'); return; }
    setSubmitting(true);
    try {
      await onSendAndRelate({
        relationType,
        newMessageContent: newMsgContent.trim(),
        targetRefs: targets.map(draftItemToTargetRef),
      });
      setNewMsgContent('');
      onClearAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Action D: 仅用已有消息建立关系（Sources/Targets集合）──────────────
  async function handleRelateOnly(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    if (sources.length === 0) { setError('来源集合为空，请先从候选区移入文本消息'); return; }
    if (targets.length === 0) { setError('目标集合为空，请先从候选区移入消息或关系'); return; }
    const firstSource = sources[0];
    if (firstSource.type !== 'message') { setError('来源必须是文本消息'); return; }
    const sourceId = firstSource.id;
    setSubmitting(true);
    try {
      await onRelateOnly({
        relationType,
        sourceMessageId: sourceId,
        targetRefs: targets.map(draftItemToTargetRef),
      });
      onClearAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  }

  function handleExportClick() {
    const json = onExport();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `public-opinion-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportSubmit() {
    try {
      onImport(importText);
      setImportText('');
      setShowImport(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '导入失败');
    }
  }

  function DraftItemRow({
    item,
    showSources,
    onRemove,
    onToSources,
    onToTargets,
  }: {
    item: DraftItem;
    showSources: boolean;
    onRemove: () => void;
    onToSources?: () => void;
    onToTargets?: () => void;
  }) {
    const isText = isTextItem(item);
    const typeLabel = item.type === 'message' ? '消' : item.type === 'text-fragment' ? '片' : '关';
    const typeBg = item.type === 'message'
      ? 'bg-blue-100 text-blue-700'
      : item.type === 'text-fragment'
        ? 'bg-yellow-100 text-yellow-700'
        : 'bg-purple-100 text-purple-700';
    return (
      <div className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded px-1.5 py-1 text-xs">
        <span className={`shrink-0 px-1 py-0.5 rounded text-xs font-medium ${typeBg}`}>{typeLabel}</span>
        <span className="flex-1 truncate text-gray-700">{itemLabel(item, messages, relations)}</span>
        <div className="flex gap-0.5 shrink-0">
          {showSources && isText && onToSources && (
            <button
              onClick={onToSources}
              className="px-1 py-0.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded text-xs font-medium"
              title="加入来源集合"
            >→来源</button>
          )}
          {onToTargets && (
            <button
              onClick={onToTargets}
              className="px-1 py-0.5 bg-green-50 text-green-600 hover:bg-green-100 rounded text-xs font-medium"
              title="加入目标集合"
            >→目标</button>
          )}
          <button
            onClick={onRemove}
            className="px-1 py-0.5 text-gray-400 hover:text-red-500 rounded"
            title="移除"
          >×</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      {/* ── Import / Export ─────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <button
          onClick={() => setShowImport(v => !v)}
          className="flex-1 py-1.5 border border-gray-300 rounded text-gray-600 hover:bg-gray-50 text-xs font-medium"
        >导入</button>
        <button
          onClick={handleExportClick}
          className="flex-1 py-1.5 border border-gray-300 rounded text-gray-600 hover:bg-gray-50 text-xs font-medium"
        >导出</button>
      </div>

      {showImport && (
        <div className="space-y-1.5">
          <textarea
            value={importText}
            onChange={e => setImportText(e.target.value)}
            placeholder="粘贴 JSON 数据…"
            rows={4}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <div className="flex gap-2">
            <button
              onClick={handleImportSubmit}
              className="flex-1 bg-indigo-600 text-white rounded py-1 text-xs hover:bg-indigo-700"
            >确认导入</button>
            <button
              onClick={() => setShowImport(false)}
              className="flex-1 border border-gray-300 rounded py-1 text-xs text-gray-500 hover:bg-gray-50"
            >取消</button>
          </div>
        </div>
      )}

      {/* ── Draft (候选区) ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wide">
            候选区 ({draft.length})
          </h4>
          <div className="flex gap-1">
            {draft.length > 0 && (
              <>
                <button
                  onClick={onDraftToTargetsAll}
                  className="text-xs text-green-600 hover:text-green-800 font-medium"
                  title="全部加入目标集合"
                >全部→目标</button>
                <span className="text-gray-300">|</span>
                <button
                  onClick={onClearAll}
                  className="text-xs text-red-400 hover:text-red-600"
                >清空</button>
              </>
            )}
          </div>
        </div>
        {draft.length === 0 ? (
          <p className="text-xs text-gray-400 py-2 text-center border border-dashed border-gray-200 rounded">
            单击消息卡片或关系标签加入候选区
            <br />
            <span className="text-gray-300">双击消息卡片进入文本选择模式</span>
          </p>
        ) : (
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {draft.map((item, idx) => (
              <DraftItemRow
                key={`draft-${idx}`}
                item={item}
                showSources
                onRemove={() => onDraftRemove(idx)}
                onToSources={() => onDraftToSources(idx)}
                onToTargets={() => onDraftToTargets(idx)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Sources (来源集合) ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-semibold text-blue-700 text-xs uppercase tracking-wide">
            来源集合 <span className="text-gray-400 font-normal normal-case">(仅文本消息)</span>
          </h4>
        </div>
        {sources.length === 0 ? (
          <p className="text-xs text-gray-400 py-1.5 text-center border border-dashed border-blue-200 rounded">
            从候选区移入文本消息
          </p>
        ) : (
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {sources.map((item, idx) => (
              <div
                key={`src-${idx}`}
                className="flex items-center gap-1 bg-blue-50 border border-blue-200 rounded px-1.5 py-1 text-xs"
              >
                <span className="flex-1 truncate text-blue-800">{itemLabel(item, messages, relations)}</span>
                <button onClick={() => onSourcesRemove(idx)} className="text-blue-400 hover:text-red-500 px-0.5">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Targets (目标集合) ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-semibold text-green-700 text-xs uppercase tracking-wide">
            目标集合 <span className="text-gray-400 font-normal normal-case">(消息或关系)</span>
          </h4>
        </div>
        {targets.length === 0 ? (
          <p className="text-xs text-gray-400 py-1.5 text-center border border-dashed border-green-200 rounded">
            从候选区移入消息或关系
          </p>
        ) : (
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {targets.map((item, idx) => (
              <div
                key={`tgt-${idx}`}
                className="flex items-center gap-1 bg-green-50 border border-green-200 rounded px-1.5 py-1 text-xs"
              >
                <span
                  className={`shrink-0 px-1 py-0.5 rounded text-xs font-medium ${
                    item.type === 'message'
                      ? 'bg-green-100 text-green-700'
                      : item.type === 'text-fragment'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-purple-100 text-purple-700'
                  }`}
                >
                  {item.type === 'message' ? '消' : item.type === 'text-fragment' ? '片' : '关'}
                </span>
                <span className="flex-1 truncate text-green-800">{itemLabel(item, messages, relations)}</span>
                <button onClick={() => onTargetsRemove(idx)} className="text-green-400 hover:text-red-500 px-0.5">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Relation type selector ────────────────────────────────────────── */}
      <div className="border-t border-gray-200 pt-3">
        <label className="block text-xs font-medium text-gray-600 mb-1">关系类型</label>
        <div className="flex flex-wrap gap-1">
          {Object.entries(PRESENTATION_SPECS)
            .filter(([, s]) =>
              s.kind === 'edge-label' ||
              s.kind === 'edge-decoration' ||
              s.kind === 'decoration',
            )
            .map(([key, s]) => (
              <button
                key={key}
                type="button"
                onClick={() => setRelationType(key)}
                className={`text-xs px-2 py-0.5 rounded border font-medium transition-all ${
                  relationType === key
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'border-gray-200 text-gray-600 hover:border-gray-400'
                }`}
              >
                {s.label}
              </button>
            ))}
        </div>
        <p className="text-xs text-gray-400 mt-0.5">
          形式：{spec.kind === 'edge-label' ? '连接线+标签' :
            spec.kind === 'edge-decoration' ? '连接线+装饰' :
            spec.kind === 'decoration' ? '消息装饰' : spec.kind}
          {spec.stanceEffect ? ` · ${spec.stanceEffect === 'support' ? '✓支持' : '✗反对'}` : ''}
        </p>
      </div>

      {/* ── Error display ─────────────────────────────────────────────────── */}
      {error && (
        <p className="text-red-500 text-xs bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}

      {/* ── Message input ─────────────────────────────────────────────────── */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">消息内容（用于操作 A/B/C）</label>
        <textarea
          value={newMsgContent}
          onChange={e => setNewMsgContent(e.target.value)}
          placeholder="输入消息内容…"
          rows={3}
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>

      {/* ── Action buttons ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-2">
        {/* Action A: Send message only */}
        <button
          onClick={handleSendOnly}
          disabled={submitting || !newMsgContent.trim()}
          className="w-full bg-gray-100 hover:bg-gray-200 disabled:opacity-40 text-gray-700 rounded py-2 text-xs font-medium transition-colors border border-gray-300 text-left px-3"
        >
          <span className="text-gray-400 mr-1">A</span>
          仅发送消息
        </button>

        {/* Action B: Send + use draft as targets */}
        <button
          onClick={handleSendWithDraft}
          disabled={submitting || !newMsgContent.trim() || draft.length === 0}
          className="w-full bg-indigo-50 hover:bg-indigo-100 disabled:opacity-40 text-indigo-700 rounded py-2 text-xs font-medium transition-colors border border-indigo-200 text-left px-3"
        >
          <span className="text-indigo-300 mr-1">B</span>
          发送消息并建立关系（用候选作目标）
          {draft.length > 0 && <span className="ml-1 text-indigo-400">·候选{draft.length}项</span>}
        </button>

        {/* Action C: Send + use targets collection */}
        <button
          onClick={handleSendWithTargets}
          disabled={submitting || !newMsgContent.trim() || targets.length === 0}
          className="w-full bg-blue-50 hover:bg-blue-100 disabled:opacity-40 text-blue-700 rounded py-2 text-xs font-medium transition-colors border border-blue-200 text-left px-3"
        >
          <span className="text-blue-300 mr-1">C</span>
          发送新消息并建立关系（Targets集合）
          {targets.length > 0 && <span className="ml-1 text-blue-400">·目标{targets.length}项</span>}
        </button>

        {/* Action D: Relate only with sources/targets */}
        <button
          onClick={handleRelateOnly}
          disabled={submitting || sources.length === 0 || targets.length === 0}
          className="w-full bg-green-50 hover:bg-green-100 disabled:opacity-40 text-green-700 rounded py-2 text-xs font-medium transition-colors border border-green-200 text-left px-3"
        >
          <span className="text-green-300 mr-1">D</span>
          仅用已有消息建立关系（Sources/Targets集合）
          {(sources.length > 0 || targets.length > 0) && (
            <span className="ml-1 text-green-400">·来源{sources.length}·目标{targets.length}</span>
          )}
        </button>
      </div>
    </div>
  );
}
