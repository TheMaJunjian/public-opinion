/**
 * DraftPanel.tsx — Candidate/Draft area + Sources/Targets management + relation creation form
 *
 * Implements the "draft → sources / targets → create relation" workflow described in the design:
 *   1. Items arrive in the "Draft" (候选区) when the user clicks messages/relations in the graph.
 *   2. Draft items can be promoted to Sources (来源集合) or Targets (目标集合).
 *   3. Constraints:
 *      - Sources: only whole text messages.
 *      - Targets: text messages, text fragments, OR relation messages / relation parts.
 *   4. User picks an operation mode and submits.
 *
 * Operation modes (matching demo):
 *   1. 仅发送消息                      — creates a new message only
 *   2. 发送消息并建立关系（用候选作目标）— creates message + relation using draft items as targets
 *   3. 发送新消息并建立关系（Targets集合）— creates message as source + uses Targets collection
 *   4. 仅用已有消息建立关系（Sources/Targets集合）— uses Sources + Targets to create relation
 *
 * Additional features:
 *   - Import / Export buttons (JSON format using the app's data model).
 *   - Visual display of each draft item with remove button.
 *   - Text-fragment items in draft (from double-click text selection in GraphView).
 */

import { useState } from 'react';
import type { Message, Relation, TargetRef } from '../types';
import { PRESENTATION_SPECS, getPresentationSpec } from '../types';
import RelationBadge from './RelationBadge';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A selectable unit in the draft/sources/targets system */
export interface DraftItem {
  /** 'message' = whole text message; 'text-fragment' = selected fragment of text message; 'relation' = relation message part */
  type: 'message' | 'text-fragment' | 'relation';
  /** messageId for 'message'/'text-fragment'; relationId for 'relation' */
  id: string;
  /** Only for 'relation' items: which selectable part is chosen */
  part?: 'label' | 'decoration' | 'frame' | 'whole';
  /** Only for 'text-fragment' items: the selected text */
  fragmentText?: string;
  /** Only for 'text-fragment' items: deterministic hash of the text */
  fragmentHash?: string;
}

/** The four distinct operation modes available in the panel */
type OperationMode =
  | 'message-only'          // 仅发送消息
  | 'message-with-draft'    // 发送消息并建立关系（用候选作目标）
  | 'message-with-targets'  // 发送新消息并建立关系（Targets集合）
  | 'relation-only';        // 仅用已有消息建立关系（Sources/Targets集合）

const OPERATION_MODES: { key: OperationMode; label: string; title: string }[] = [
  {
    key: 'message-only',
    label: '①发消息',
    title: '仅发送消息',
  },
  {
    key: 'message-with-draft',
    label: '②发消息+候选',
    title: '发送消息并建立关系（用候选作目标）',
  },
  {
    key: 'message-with-targets',
    label: '③发消息+Targets',
    title: '发送新消息并建立关系（Targets集合）',
  },
  {
    key: 'relation-only',
    label: '④仅建关系',
    title: '仅用已有消息建立关系（Sources/Targets集合）',
  },
];

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
  onSourcesRemove: (idx: number) => void;
  onTargetsRemove: (idx: number) => void;
  onClearAll: () => void;
  /** Mode 1: send a new message with no relation */
  onSendMessage: (content: string) => Promise<void>;
  /** Modes 2–4: create a relation (optionally also creating a new source message) */
  onCreateRelation: (data: {
    relationType: string;
    sourceMessageId: string;
    targetRefs: TargetRef[];
    newMessageContent?: string;
  }) => Promise<void>;
  onImport: (json: string) => void;
  onExport: () => string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function itemLabel(item: DraftItem, messages: Message[], relations: Relation[]): string {
  if (item.type === 'message') {
    const msg = messages.find(m => m.id === item.id);
    if (!msg) return `消息 ${item.id.slice(0, 8)}…`;
    return `[${msg.createdBy.username}] ${msg.content.slice(0, 30)}${msg.content.length > 30 ? '…' : ''}`;
  }
  if (item.type === 'text-fragment') {
    const msg = messages.find(m => m.id === item.id);
    const author = msg ? `[${msg.createdBy.username}]` : '[?]';
    const text = item.fragmentText ?? '';
    return `${author} 片段: "${text.slice(0, 25)}${text.length > 25 ? '…' : ''}"`;
  }
  const rel = relations.find(r => r.id === item.id);
  if (!rel) return `关系 ${item.id.slice(0, 8)}…`;
  const spec = getPresentationSpec(rel.relationType);
  const src = messages.find(m => m.id === rel.sourceMessageId);
  const partSuffix = item.part && item.part !== 'whole' ? `.${item.part}` : '';
  return `[${src?.createdBy.username ?? '?'}的${spec.label}关系${partSuffix}]`;
}

/** Returns true if this draft item can be placed in the Sources collection (whole text messages only) */
function isValidForSources(item: DraftItem): boolean {
  return item.type === 'message';
}

/** Build TargetRefs from a collection of draft items */
function buildTargetRefs(items: DraftItem[]): TargetRef[] {
  return items.map(item => {
    if (item.type === 'message') {
      return { kind: 'message', messageId: item.id } as TargetRef;
    }
    if (item.type === 'text-fragment') {
      return {
        kind: 'text-fragment',
        messageId: item.id,
        text: item.fragmentText ?? '',
        hash: item.fragmentHash ?? '',
      } as TargetRef;
    }
    return {
      kind: 'relation',
      relationId: item.id,
      part: item.part && item.part !== 'whole' ? item.part : undefined,
    } as TargetRef;
  });
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
  onSourcesRemove,
  onTargetsRemove,
  onClearAll,
  onSendMessage,
  onCreateRelation,
  onImport,
  onExport,
}: Props) {
  const [operationMode, setOperationMode] = useState<OperationMode>('relation-only');
  const [relationType, setRelationType] = useState('REPLY');
  const [newMsgContent, setNewMsgContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  const spec = getPresentationSpec(relationType);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (operationMode === 'message-only') {
      // ── Mode 1: just send a message ───────────────────────────────────
      if (!newMsgContent.trim()) { setError('消息内容不能为空'); return; }
      setSubmitting(true);
      try {
        await onSendMessage(newMsgContent.trim());
        setNewMsgContent('');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '发送失败');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (operationMode === 'message-with-draft') {
      // ── Mode 2: send message + create relation (draft items = targets) ──
      if (!newMsgContent.trim()) { setError('消息内容不能为空'); return; }
      if (draft.length === 0) { setError('候选区为空，请先在图中点击消息或关系标签'); return; }
      const targetRefs = buildTargetRefs(draft);
      setSubmitting(true);
      try {
        await onCreateRelation({
          relationType,
          sourceMessageId: '',
          targetRefs,
          newMessageContent: newMsgContent.trim(),
        });
        onClearAll();
        setNewMsgContent('');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '操作失败');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (operationMode === 'message-with-targets') {
      // ── Mode 3: new message as source + Targets collection ─────────────
      if (!newMsgContent.trim()) { setError('消息内容不能为空'); return; }
      if (targets.length === 0) { setError('目标集合为空，请先将项目移入目标集合'); return; }
      const targetRefs = buildTargetRefs(targets);
      setSubmitting(true);
      try {
        await onCreateRelation({
          relationType,
          sourceMessageId: '',
          targetRefs,
          newMessageContent: newMsgContent.trim(),
        });
        onClearAll();
        setNewMsgContent('');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '操作失败');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (operationMode === 'relation-only') {
      // ── Mode 4: use existing Sources + Targets ─────────────────────────
      if (sources.length === 0) {
        setError('来源集合为空，请先将文本消息移入来源集合');
        return;
      }
      if (targets.length === 0) {
        setError('目标集合为空，请先将项目移入目标集合');
        return;
      }
      const sourceId = sources[0].id;
      const targetRefs = buildTargetRefs(targets);
      setSubmitting(true);
      try {
        await onCreateRelation({
          relationType,
          sourceMessageId: sourceId,
          targetRefs,
        });
        onClearAll();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '建立关系失败');
      } finally {
        setSubmitting(false);
      }
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

  /** Badge color + label for a draft item */
  function itemBadge(item: DraftItem) {
    if (item.type === 'message') return { bg: 'bg-blue-100 text-blue-700', label: '消' };
    if (item.type === 'text-fragment') return { bg: 'bg-amber-100 text-amber-700', label: '片' };
    return { bg: 'bg-purple-100 text-purple-700', label: '关' };
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      {/* ── Import / Export ─────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <button
          onClick={() => setShowImport(v => !v)}
          className="flex-1 py-1.5 border border-gray-300 rounded text-gray-600 hover:bg-gray-50 text-xs font-medium"
        >
          导入
        </button>
        <button
          onClick={handleExportClick}
          className="flex-1 py-1.5 border border-gray-300 rounded text-gray-600 hover:bg-gray-50 text-xs font-medium"
        >
          导出
        </button>
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
            >
              确认导入
            </button>
            <button
              onClick={() => setShowImport(false)}
              className="flex-1 border border-gray-300 rounded py-1 text-xs text-gray-500 hover:bg-gray-50"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* ── Draft (候选区) ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wide">
            候选区 ({draft.length})
          </h4>
          {draft.length > 0 && (
            <button
              onClick={onClearAll}
              className="text-xs text-red-400 hover:text-red-600"
            >
              清空
            </button>
          )}
        </div>
        {draft.length === 0 ? (
          <p className="text-xs text-gray-400 py-2 text-center border border-dashed border-gray-200 rounded">
            单击消息或关系标签加入候选；双击消息进入文本选取模式
          </p>
        ) : (
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {draft.map((item, idx) => {
              const badge = itemBadge(item);
              return (
                <div
                  key={`${item.type}-${item.id}-${idx}`}
                  className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded px-1.5 py-1 text-xs"
                >
                  <span className={`shrink-0 px-1 py-0.5 rounded text-xs font-medium ${badge.bg}`}>
                    {badge.label}
                  </span>
                  <span className="flex-1 truncate text-gray-700">
                    {itemLabel(item, messages, relations)}
                  </span>
                  <div className="flex gap-0.5 shrink-0">
                    {isValidForSources(item) && (
                      <button
                        onClick={() => onDraftToSources(idx)}
                        className="px-1 py-0.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded text-xs font-medium"
                        title="加入来源集合"
                      >
                        →来源
                      </button>
                    )}
                    <button
                      onClick={() => onDraftToTargets(idx)}
                      className="px-1 py-0.5 bg-green-50 text-green-600 hover:bg-green-100 rounded text-xs font-medium"
                      title="加入目标集合"
                    >
                      →目标
                    </button>
                    <button
                      onClick={() => onDraftRemove(idx)}
                      className="px-1 py-0.5 text-gray-400 hover:text-red-500 rounded"
                      title="移除"
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Sources (来源集合) ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="font-semibold text-blue-700 text-xs uppercase tracking-wide">
            来源集合 <span className="text-gray-400 font-normal normal-case">(仅文本消息)</span>
          </h4>
        </div>
        {sources.length === 0 ? (
          <p className="text-xs text-gray-400 py-2 text-center border border-dashed border-blue-200 rounded">
            从候选区移入文本消息
          </p>
        ) : (
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {sources.map((item, idx) => (
              <div
                key={`src-${item.id}-${idx}`}
                className="flex items-center gap-1 bg-blue-50 border border-blue-200 rounded px-1.5 py-1 text-xs"
              >
                <span className="flex-1 truncate text-blue-800">
                  {itemLabel(item, messages, relations)}
                </span>
                <button
                  onClick={() => onSourcesRemove(idx)}
                  className="text-blue-400 hover:text-red-500 px-0.5"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Targets (目标集合) ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="font-semibold text-green-700 text-xs uppercase tracking-wide">
            目标集合 <span className="text-gray-400 font-normal normal-case">(消息、片段或关系)</span>
          </h4>
        </div>
        {targets.length === 0 ? (
          <p className="text-xs text-gray-400 py-2 text-center border border-dashed border-green-200 rounded">
            从候选区移入消息、片段或关系
          </p>
        ) : (
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {targets.map((item, idx) => {
              const badge = itemBadge(item);
              return (
                <div
                  key={`tgt-${item.id}-${idx}`}
                  className="flex items-center gap-1 bg-green-50 border border-green-200 rounded px-1.5 py-1 text-xs"
                >
                  <span className={`shrink-0 px-1 py-0.5 rounded text-xs font-medium ${badge.bg}`}>
                    {badge.label}
                  </span>
                  <span className="flex-1 truncate text-green-800">
                    {itemLabel(item, messages, relations)}
                  </span>
                  <button
                    onClick={() => onTargetsRemove(idx)}
                    className="text-green-400 hover:text-red-500 px-0.5"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Operation Modes ──────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} className="space-y-3 border-t border-gray-200 pt-3">

        {/* Mode selector */}
        <div>
          <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wide mb-1.5">
            操作模式
          </h4>
          <div className="grid grid-cols-2 gap-1">
            {OPERATION_MODES.map(({ key, label, title }) => (
              <button
                key={key}
                type="button"
                onClick={() => { setOperationMode(key); setError(''); }}
                title={title}
                className={`text-xs px-1.5 py-1.5 rounded border font-medium transition-all leading-tight ${
                  operationMode === key
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'border-gray-200 text-gray-600 hover:border-gray-400 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            {OPERATION_MODES.find(m => m.key === operationMode)?.title}
          </p>
        </div>

        {error && (
          <p className="text-red-500 text-xs bg-red-50 border border-red-200 rounded px-2 py-1">
            {error}
          </p>
        )}

        {/* ── Mode 1: just send a message ─────────────────────────────── */}
        {operationMode === 'message-only' && (
          <div className="space-y-2">
            <textarea
              value={newMsgContent}
              onChange={e => setNewMsgContent(e.target.value)}
              placeholder="输入消息内容…"
              rows={3}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <button
              type="submit"
              disabled={submitting || !newMsgContent.trim()}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded py-2 text-sm font-medium transition-colors"
            >
              {submitting ? '发送中…' : '仅发送消息'}
            </button>
          </div>
        )}

        {/* ── Mode 2: send message + relation using draft as targets ──── */}
        {operationMode === 'message-with-draft' && (
          <div className="space-y-2">
            <textarea
              value={newMsgContent}
              onChange={e => setNewMsgContent(e.target.value)}
              placeholder="输入新消息内容…"
              rows={3}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <RelationTypeSelector relationType={relationType} onSelect={setRelationType} spec={spec} />
            {draft.length === 0 ? (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                候选区为空，请先单击图中的消息或关系标签
              </p>
            ) : (
              <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded px-2 py-1">
                将以候选区 {draft.length} 项作为目标建立关系
              </p>
            )}
            <button
              type="submit"
              disabled={submitting || !newMsgContent.trim() || draft.length === 0}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded py-2 text-sm font-medium transition-colors"
            >
              {submitting ? '操作中…' : '发送并建立关系（用候选作目标）'}
            </button>
          </div>
        )}

        {/* ── Mode 3: new message as source + Targets collection ───────── */}
        {operationMode === 'message-with-targets' && (
          <div className="space-y-2">
            <textarea
              value={newMsgContent}
              onChange={e => setNewMsgContent(e.target.value)}
              placeholder="输入新消息内容（将作为来源）…"
              rows={3}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <RelationTypeSelector relationType={relationType} onSelect={setRelationType} spec={spec} />
            {targets.length === 0 && (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                目标集合为空，请先将项目从候选区移入目标集合
              </p>
            )}
            {(newMsgContent.trim() || targets.length > 0) && (
              <div className="text-xs text-gray-500 space-y-0.5">
                {newMsgContent.trim() && (
                  <p>
                    <span className="font-medium text-blue-600">来源：</span>
                    新消息「{newMsgContent.slice(0, 20)}{newMsgContent.length > 20 ? '…' : ''}」
                  </p>
                )}
                {targets.length > 0 && (
                  <p>
                    <span className="font-medium text-green-600">目标：</span>
                    {targets.map((t, i) => (
                      <span key={i}>{i > 0 ? '、' : ''}{itemLabel(t, messages, relations)}</span>
                    ))}
                  </p>
                )}
                <p><span className="font-medium">关系：</span><RelationBadge type={relationType} /></p>
              </div>
            )}
            <button
              type="submit"
              disabled={submitting || !newMsgContent.trim() || targets.length === 0}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded py-2 text-sm font-medium transition-colors"
            >
              {submitting ? '操作中…' : '发送新消息并建立关系（Targets集合）'}
            </button>
          </div>
        )}

        {/* ── Mode 4: use existing Sources + Targets ───────────────────── */}
        {operationMode === 'relation-only' && (
          <div className="space-y-2">
            <RelationTypeSelector relationType={relationType} onSelect={setRelationType} spec={spec} />
            {sources.length === 0 && (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                来源集合为空，请先将文本消息移入来源集合
              </p>
            )}
            {targets.length === 0 && (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                目标集合为空，请先将项目移入目标集合
              </p>
            )}
            {sources.length > 0 && targets.length > 0 && (
              <div className="text-xs text-gray-500 space-y-0.5">
                <p>
                  <span className="font-medium text-blue-600">来源：</span>
                  {itemLabel(sources[0], messages, relations)}
                </p>
                <p>
                  <span className="font-medium text-green-600">目标：</span>
                  {targets.map((t, i) => (
                    <span key={i}>{i > 0 ? '、' : ''}{itemLabel(t, messages, relations)}</span>
                  ))}
                </p>
                <p><span className="font-medium">关系：</span><RelationBadge type={relationType} /></p>
              </div>
            )}
            <button
              type="submit"
              disabled={submitting || sources.length === 0 || targets.length === 0}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded py-2 text-sm font-medium transition-colors"
            >
              {submitting ? '建立中…' : '仅用已有消息建立关系'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

// ─── RelationTypeSelector sub-component ─────────────────────────────────────

function RelationTypeSelector({
  relationType,
  onSelect,
  spec,
}: {
  relationType: string;
  onSelect: (type: string) => void;
  spec: ReturnType<typeof getPresentationSpec>;
}) {
  return (
    <div>
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
              onClick={() => onSelect(key)}
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
      <p className="text-xs text-gray-400 mt-1">
        形式：{spec.kind === 'edge-label' ? '连接线+标签' :
          spec.kind === 'edge-decoration' ? '连接线+装饰' :
          spec.kind === 'decoration' ? '消息装饰' : spec.kind}
        {spec.stanceEffect ? ` · ${spec.stanceEffect === 'support' ? '✓支持' : '✗反对'}` : ''}
      </p>
    </div>
  );
}
