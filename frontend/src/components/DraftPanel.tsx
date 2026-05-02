/**
 * DraftPanel.tsx — Candidate/Draft area + Sources/Targets management + relation creation form
 *
 * Implements the "draft → sources / targets → create relation" workflow described in the design:
 *   1. Items arrive in the "Draft" (候选区) when the user clicks messages/relations in the graph.
 *   2. Draft items can be promoted to Sources (来源集合) or Targets (目标集合).
 *   3. Constraints:
 *      - Sources: only text messages (never relation messages or fragments of relations).
 *      - Targets: text messages, text fragments, OR relation messages / relation parts.
 *   4. User picks a relation type and submits to create the relation.
 *
 * Additional features:
 *   - "New message + immediate relation" flow: input new message content alongside sources/targets.
 *   - Import / Export buttons (JSON format using the app's data model).
 *   - Visual display of each draft item with remove button.
 */

import { useState } from 'react';
import type { Message, Relation, TargetRef } from '../types';
import { PRESENTATION_SPECS, getPresentationSpec } from '../types';
import RelationBadge from './RelationBadge';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A selectable unit in the draft/sources/targets system */
export interface DraftItem {
  type: 'message' | 'relation';
  id: string;
  /** Only for relation items: which part of the relation is selected */
  part?: 'label' | 'decoration' | 'frame' | 'whole';
}

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
  const rel = relations.find(r => r.id === item.id);
  if (!rel) return `关系 ${item.id.slice(0, 8)}…`;
  const spec = getPresentationSpec(rel.relationType);
  const src = messages.find(m => m.id === rel.sourceMessageId);
  const partSuffix = item.part && item.part !== 'whole' ? `.${item.part}` : '';
  return `[${src?.createdBy.username ?? '?'}的${spec.label}关系${partSuffix}]`;
}

function isTextMessage(item: DraftItem): boolean {
  return item.type === 'message';
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
  onCreateRelation,
  onImport,
  onExport,
}: Props) {
  const [relationType, setRelationType] = useState('REPLY');
  const [newMsgContent, setNewMsgContent] = useState('');
  const [useNewMsg, setUseNewMsg] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  const spec = getPresentationSpec(relationType);

  /** Build TargetRefs from the targets collection */
  function buildTargetRefs(): TargetRef[] {
    return targets.map(item => {
      if (item.type === 'message') {
        return { kind: 'message', messageId: item.id } as TargetRef;
      }
      return {
        kind: 'relation',
        relationId: item.id,
        part: item.part && item.part !== 'whole' ? item.part : undefined,
      } as TargetRef;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // Validate sources
    if (sources.length === 0 && !useNewMsg) {
      setError('请先选择来源消息（在图中点击文本消息，再点击"→来源"）');
      return;
    }
    if (targets.length === 0) {
      setError('请先选择目标（在图中点击消息或关系标签，再点击"→目标"）');
      return;
    }

    const sourceId = useNewMsg ? '' : sources[0]?.id;
    if (!useNewMsg && !sourceId) {
      setError('来源集合为空');
      return;
    }
    if (useNewMsg && !newMsgContent.trim()) {
      setError('新消息内容不能为空');
      return;
    }

    const targetRefs = buildTargetRefs();
    if (targetRefs.length === 0) {
      setError('目标集合为空');
      return;
    }

    setSubmitting(true);
    try {
      await onCreateRelation({
        relationType,
        sourceMessageId: sourceId,
        targetRefs,
        newMessageContent: useNewMsg ? newMsgContent.trim() : undefined,
      });
      // Clear after success
      onClearAll();
      setNewMsgContent('');
      setUseNewMsg(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建关系失败');
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
            在图中点击消息或关系标签，将其加入候选区
          </p>
        ) : (
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {draft.map((item, idx) => (
              <div
                key={`${item.type}-${item.id}-${idx}`}
                className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded px-1.5 py-1 text-xs"
              >
                <span
                  className={`shrink-0 px-1 py-0.5 rounded text-xs font-medium ${
                    item.type === 'message'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-purple-100 text-purple-700'
                  }`}
                >
                  {item.type === 'message' ? '消' : '关'}
                </span>
                <span className="flex-1 truncate text-gray-700">
                  {itemLabel(item, messages, relations)}
                </span>
                <div className="flex gap-0.5 shrink-0">
                  {isTextMessage(item) && (
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
            ))}
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
            目标集合 <span className="text-gray-400 font-normal normal-case">(消息或关系)</span>
          </h4>
        </div>
        {targets.length === 0 ? (
          <p className="text-xs text-gray-400 py-2 text-center border border-dashed border-green-200 rounded">
            从候选区移入消息或关系
          </p>
        ) : (
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {targets.map((item, idx) => (
              <div
                key={`tgt-${item.id}-${idx}`}
                className="flex items-center gap-1 bg-green-50 border border-green-200 rounded px-1.5 py-1 text-xs"
              >
                <span
                  className={`shrink-0 px-1 py-0.5 rounded text-xs font-medium ${
                    item.type === 'message'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-purple-100 text-purple-700'
                  }`}
                >
                  {item.type === 'message' ? '消' : '关'}
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
            ))}
          </div>
        )}
      </div>

      {/* ── Create Relation form ──────────────────────────────────────────── */}
      <form onSubmit={handleCreate} className="space-y-3 border-t border-gray-200 pt-3">
        <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wide">建立关系</h4>

        {error && (
          <p className="text-red-500 text-xs bg-red-50 border border-red-200 rounded px-2 py-1">
            {error}
          </p>
        )}

        {/* Relation type */}
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
          <p className="text-xs text-gray-400 mt-1">
            形式：{spec.kind === 'edge-label' ? '连接线+标签' :
              spec.kind === 'edge-decoration' ? '连接线+装饰' :
              spec.kind === 'decoration' ? '消息装饰' : spec.kind}
            {spec.stanceEffect ? ` · ${spec.stanceEffect === 'support' ? '✓支持' : '✗反对'}` : ''}
          </p>
        </div>

        {/* New message option */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={useNewMsg}
            onChange={e => setUseNewMsg(e.target.checked)}
            className="rounded"
          />
          <span className="text-xs text-gray-600">新建消息作为来源</span>
        </label>

        {useNewMsg ? (
          <textarea
            value={newMsgContent}
            onChange={e => setNewMsgContent(e.target.value)}
            placeholder="输入新消息内容…"
            rows={3}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        ) : (
          sources.length === 0 && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              请先在来源集合中添加一条文本消息
            </p>
          )
        )}

        {/* Summary */}
        {(sources.length > 0 || useNewMsg) && targets.length > 0 && (
          <div className="text-xs text-gray-500 space-y-0.5">
            <p>
              <span className="font-medium text-blue-600">来源：</span>
              {useNewMsg
                ? `新消息「${newMsgContent.slice(0, 20)}…」`
                : itemLabel(sources[0], messages, relations)}
            </p>
            <p>
              <span className="font-medium text-green-600">目标：</span>
              {targets.map((t, i) => (
                <span key={i}>{i > 0 ? '、' : ''}{itemLabel(t, messages, relations)}</span>
              ))}
            </p>
            <p>
              <span className="font-medium">关系：</span>
              <RelationBadge type={relationType} />
            </p>
          </div>
        )}

        <button
          type="submit"
          disabled={
            submitting ||
            targets.length === 0 ||
            (!useNewMsg && sources.length === 0) ||
            (useNewMsg && !newMsgContent.trim())
          }
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded py-2 text-sm font-medium transition-colors"
        >
          {submitting ? '建立中…' : '建立关系'}
        </button>
      </form>
    </div>
  );
}
