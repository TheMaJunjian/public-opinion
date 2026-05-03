/**
 * DraftPanel.tsx — Right-side control panel
 *
 * Sections:
 *   1. Draft (候选区)        — items selected from the view, grouped by messageId
 *   2. Sources (来源集合)    — text messages only
 *   3. Targets (目标集合)    — any kind of item
 *   4. Action buttons        — four send/relate actions (A/B/C/D)
 *   5. Focus controls        — set/exit focus, hop count, current focus display
 *   6. Export / Import       — JSON export/import
 *   7. Recent messages       — recently sent text/relation messages
 *
 * Draft is grouped by message (or relation):
 *   - Shows message ID (short), author, whole-message flag, fragment count
 *   - Delete-whole and delete-fragment buttons
 *
 * Four action buttons:
 *   A. 仅发送消息
 *   B. 发送消息并建立关系（用候选作目标）
 *   C. 发送新消息并建立关系（Targets集合）
 *   D. 仅用已有消息建立关系（Sources/Targets集合）
 */

import { useState } from 'react';
import type { Message, Relation, TargetRef, DraftItem } from '../types';
import { getPresentationSpec, PRESENTATION_SPECS } from '../types';

export type { DraftItem };

/** A group of draft items belonging to the same message */
interface DraftMessageGroup {
  /** The message ID */
  messageId: string;
  /** Whether the whole message is in draft */
  hasWhole: boolean;
  /** Index of the whole-message item in the draft array, if present */
  wholeIndex: number | null;
  /** Fragment items with their draft array indices */
  fragments: Array<{ index: number; text: string; hash: string }>;
}

/** A draft item representing a relation message */
interface DraftRelationItem {
  index: number;
  relationId: string;
  part?: string;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  messages: Message[];
  relations: Relation[];
  draft: DraftItem[];
  sources: DraftItem[];
  targets: DraftItem[];
  onDraftRemove: (idx: number) => void;
  onDraftRemoveBatch: (indices: number[]) => void;
  onDraftToSources: (idx: number) => void;
  onDraftToSourcesBatch: (indices: number[]) => void;
  onDraftToTargets: (idx: number) => void;
  onDraftToTargetsBatch: (indices: number[]) => void;
  onDraftToTargetsAll: () => void;
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
  /** Relation type selected in the top toolbar (lifted state) */
  relationType: string;
  onRelationTypeChange: (type: string) => void;
  /** Focus mode state (lifted to top, displayed here) */
  focusMode: boolean;
  focusMessageId: string;
  focusHops: number;
  onFocusToggle: () => void;
  onFocusMessageChange: (id: string) => void;
  onFocusHopsChange: (hops: number) => void;
  onFocusExit: () => void;
  onFocusExitAll: () => void;
  /** Recent messages for the quick reference section */
  recentTextMessages: Message[];
  recentRelations: Relation[];
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

/**
 * Group draft items by their associated messageId.
 * Returns message groups (text msgs + fragments) and relation items separately.
 */
function groupDraftByMessage(draft: DraftItem[]): {
  groups: DraftMessageGroup[];
  relationItems: DraftRelationItem[];
} {
  const groupMap = new Map<string, DraftMessageGroup>();
  const relationItems: DraftRelationItem[] = [];

  draft.forEach((item, index) => {
    if (item.type === 'message') {
      const g = groupMap.get(item.id) ?? { messageId: item.id, hasWhole: false, wholeIndex: null, fragments: [] };
      g.hasWhole = true;
      g.wholeIndex = index;
      groupMap.set(item.id, g);
    } else if (item.type === 'text-fragment') {
      const g = groupMap.get(item.messageId) ?? { messageId: item.messageId, hasWhole: false, wholeIndex: null, fragments: [] };
      g.fragments.push({ index, text: item.text, hash: item.hash });
      groupMap.set(item.messageId, g);
    } else {
      relationItems.push({ index, relationId: item.id, part: item.part });
    }
  });

  return { groups: Array.from(groupMap.values()), relationItems };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function DraftPanel({
  messages,
  relations,
  draft,
  sources,
  targets,
  onDraftRemove,
  onDraftRemoveBatch,
  onDraftToSources: _onDraftToSources,        // kept in API; batch buttons are primary flow
  onDraftToSourcesBatch,
  onDraftToTargets: _onDraftToTargets,        // kept in API; batch buttons are primary flow
  onDraftToTargetsBatch: _onDraftToTargetsBatch, // kept in API; onDraftToTargetsAll is used instead
  onDraftToTargetsAll,
  onSourcesRemove,
  onTargetsRemove,
  onClearAll,
  onSendMessage,
  onSendAndRelate,
  onRelateOnly,
  onImport,
  onExport,
  relationType,
  onRelationTypeChange,
  focusMode,
  focusMessageId,
  focusHops,
  onFocusToggle,
  onFocusMessageChange,
  onFocusHopsChange,
  onFocusExit,
  onFocusExitAll,
  recentTextMessages,
  recentRelations,
}: Props) {
  const [newMsgContent, setNewMsgContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [showFocus, setShowFocus] = useState(false);
  const [showExportSection, setShowExportSection] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);

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

  function handleExportCopy() {
    const json = onExport();
    navigator.clipboard.writeText(json).then(() => {
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 2000);
    });
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

  // ── Compute draft groups ─────────────────────────────────────────────────
  const { groups: draftGroups, relationItems: draftRelItems } = groupDraftByMessage(draft);

  // ── Helpers: delete all fragments of a group ─────────────────────────────
  function handleDeleteGroupFragments(group: DraftMessageGroup) {
    onDraftRemoveBatch(group.fragments.map(f => f.index));
  }

  function handleDeleteWholeGroup(group: DraftMessageGroup) {
    if (group.wholeIndex !== null) {
      onDraftRemove(group.wholeIndex);
    }
  }

  // ── Focus controls current message label ────────────────────────────────
  const focusMsg = messages.find(m => m.id === focusMessageId);

  return (
    <div className="flex flex-col gap-3 text-sm">

      {/* ── Draft (候选区) ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="font-semibold text-gray-700 text-xs uppercase tracking-wide">
            候选区 ({draft.length})
          </h4>
          <div className="flex gap-1 items-center">
            {draft.length > 0 && (
              <>
                <button
                  onClick={onDraftToTargetsAll}
                  className="text-xs text-green-600 hover:text-green-800 font-medium border border-green-200 rounded px-1.5 py-0.5 hover:bg-green-50"
                  title="全部加入目标集合"
                >全部→目标</button>
                <button
                  onClick={onClearAll}
                  className="text-xs text-red-400 hover:text-red-600 border border-red-200 rounded px-1.5 py-0.5 hover:bg-red-50"
                >清空</button>
              </>
            )}
          </div>
        </div>

        {draft.length === 0 ? (
          <div className="text-xs text-gray-400 py-3 text-center border-2 border-dashed border-gray-200 rounded-lg">
            <p>单击消息卡片或关系标签加入候选区</p>
            <p className="text-gray-300 mt-0.5">双击消息卡片进入文本选择模式</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {/* Message groups */}
            {draftGroups.map(group => {
              const msg = messages.find(m => m.id === group.messageId);
              return (
                <div
                  key={`group-${group.messageId}`}
                  className="bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs"
                >
                  {/* Group header — delete button only; batch flow via bottom buttons */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="shrink-0 px-1 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">消</span>
                      <span className="text-[10px] text-gray-400 font-mono shrink-0">{group.messageId.slice(0, 8)}</span>
                      <span className="text-gray-600 truncate font-medium">
                        {msg ? `[${msg.createdBy.username}]` : '未知'}
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        const indices: number[] = [];
                        if (group.hasWhole && group.wholeIndex !== null) indices.push(group.wholeIndex);
                        group.fragments.forEach(f => indices.push(f.index));
                        onDraftRemoveBatch(indices);
                      }}
                      className="text-[10px] text-gray-400 hover:text-red-500 px-0.5 shrink-0"
                      title="移除整组"
                    >×</button>
                  </div>

                  {/* Whole-message indicator */}
                  <div className="flex items-center gap-1 mb-1">
                    <span className={`text-[10px] px-1 rounded ${group.hasWhole ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-400'}`}>
                      整条：{group.hasWhole ? '是' : '否'}
                    </span>
                    {group.hasWhole && group.wholeIndex !== null && (
                      <button
                        onClick={() => handleDeleteWholeGroup(group)}
                        className="text-[10px] text-red-400 hover:text-red-600 ml-auto"
                        title="删除整条"
                      >删除整条</button>
                    )}
                  </div>

                  {/* Fragment rows */}
                  {group.fragments.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] text-gray-500">片段 ({group.fragments.length})</span>
                        <button
                          onClick={() => handleDeleteGroupFragments(group)}
                          className="text-[10px] text-red-400 hover:text-red-600"
                          title="删除所有片段"
                        >删除所有片段</button>
                      </div>
                      {group.fragments.map(frag => (
                        <div key={frag.hash} className="flex items-center gap-1 pl-2 py-0.5">
                          <span className="text-yellow-400 shrink-0">·</span>
                          <span className="flex-1 truncate text-gray-600 italic">
                            "{frag.text.slice(0, 25)}{frag.text.length > 25 ? '…' : ''}"
                          </span>
                          <button
                            onClick={() => onDraftRemove(frag.index)}
                            className="shrink-0 text-gray-400 hover:text-red-500 px-0.5"
                            title="删除此片段"
                          >×</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Content preview */}
                  {msg && (
                    <p className="mt-1 text-[10px] text-gray-400 truncate border-t border-gray-100 pt-1">
                      {msg.content.slice(0, 60)}{msg.content.length > 60 ? '…' : ''}
                    </p>
                  )}
                </div>
              );
            })}

            {/* Relation items */}
            {draftRelItems.map(relItem => {
              const rel = relations.find(r => r.id === relItem.relationId);
              const spec2 = rel ? getPresentationSpec(rel.relationType) : null;
              const srcMsg = rel ? messages.find(m => m.id === rel.sourceMessageId) : null;
              return (
                <div
                  key={`rel-${relItem.index}`}
                  className="bg-purple-50 border border-purple-200 rounded-lg p-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="shrink-0 px-1 py-0.5 bg-purple-100 text-purple-700 rounded font-medium">关</span>
                      <span className="text-[10px] text-gray-400 font-mono shrink-0">{relItem.relationId.slice(0, 8)}</span>
                      {spec2 && (
                        <span className="text-purple-700 font-medium">{spec2.label}</span>
                      )}
                      {srcMsg && (
                        <span className="text-gray-500 truncate">by {srcMsg.createdBy.username}</span>
                      )}
                    </div>
                    <button
                      onClick={() => onDraftRemove(relItem.index)}
                      className="text-gray-400 hover:text-red-500 px-0.5 shrink-0"
                      title="移除"
                    >×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Batch action buttons below draft — PRIMARY interaction for moving to collections */}
        {draft.length > 0 && (
          <div className="flex gap-2 mt-2 border-t border-gray-100 pt-2">
            <button
              onClick={() => {
                const indices = draftGroups
                  .filter(g => g.hasWhole && g.wholeIndex !== null)
                  .map(g => g.wholeIndex as number);
                onDraftToSourcesBatch(indices);
              }}
              className="flex-1 py-2 bg-blue-600 text-white border border-blue-600 rounded text-xs font-semibold hover:bg-blue-700 transition-colors"
              title="将候选区中的整条文本消息批量加入来源集合"
            >
              加入来源集合
            </button>
            <button
              onClick={onDraftToTargetsAll}
              className="flex-1 py-2 bg-green-600 text-white border border-green-600 rounded text-xs font-semibold hover:bg-green-700 transition-colors"
              title="将候选区全部内容批量加入目标集合"
            >
              加入目标集合
            </button>
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
                <button onClick={() => onSourcesRemove(idx)} className="text-blue-400 hover:text-red-500 px-0.5 shrink-0">×</button>
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
                <button onClick={() => onTargetsRemove(idx)} className="text-green-400 hover:text-red-500 px-0.5 shrink-0">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Error display ─────────────────────────────────────────────────── */}
      {error && (
        <p className="text-red-500 text-xs bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}

      {/* ── Message input + Relation type + Action buttons ─────────── */}
      <div className="border-t border-gray-200 pt-3 space-y-2">
        <label className="block text-xs font-medium text-gray-600 mb-1">
          消息内容 <span className="text-gray-400 font-normal">(操作 A/B/C 需要)</span>
        </label>
        <textarea
          value={newMsgContent}
          onChange={e => setNewMsgContent(e.target.value)}
          placeholder="输入消息内容…"
          rows={3}
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />

        {/* Relation type selector (inline, for B/C/D operations) */}
        <div className="flex items-start gap-2">
          <span className="text-xs font-medium text-gray-500 shrink-0 pt-1">关系类型</span>
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
                  onClick={() => onRelationTypeChange(key)}
                  title={`${s.label} · ${s.kind}`}
                  className={`text-xs px-2 py-0.5 rounded border font-medium transition-all ${
                    relationType === key
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600'
                  }`}
                >
                  {s.label}
                </button>
              ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-1.5">
          {/* Action A: Send message only */}
          <button
            onClick={handleSendOnly}
            disabled={submitting || !newMsgContent.trim()}
            className="w-full bg-gray-50 hover:bg-gray-100 disabled:opacity-40 text-gray-700 rounded py-2 text-xs font-medium transition-colors border border-gray-300 text-left px-3"
          >
            <span className="text-gray-400 mr-1.5 font-mono">A</span>
            仅发送消息
          </button>

          {/* Action B: Send + use draft as targets */}
          <button
            onClick={handleSendWithDraft}
            disabled={submitting || !newMsgContent.trim() || draft.length === 0}
            className="w-full bg-indigo-50 hover:bg-indigo-100 disabled:opacity-40 text-indigo-700 rounded py-2 text-xs font-medium transition-colors border border-indigo-200 text-left px-3"
          >
            <span className="text-indigo-300 mr-1.5 font-mono">B</span>
            发送并建立关系（用候选作目标）
            {draft.length > 0 && <span className="ml-1 text-indigo-400 text-[10px]">·候选{draft.length}项</span>}
          </button>

          {/* Action C: Send + use targets collection */}
          <button
            onClick={handleSendWithTargets}
            disabled={submitting || !newMsgContent.trim() || targets.length === 0}
            className="w-full bg-blue-50 hover:bg-blue-100 disabled:opacity-40 text-blue-700 rounded py-2 text-xs font-medium transition-colors border border-blue-200 text-left px-3"
          >
            <span className="text-blue-300 mr-1.5 font-mono">C</span>
            发送并建立关系（Targets集合）
            {targets.length > 0 && <span className="ml-1 text-blue-400 text-[10px]">·目标{targets.length}项</span>}
          </button>

          {/* Action D: Relate only with sources/targets */}
          <button
            onClick={handleRelateOnly}
            disabled={submitting || sources.length === 0 || targets.length === 0}
            className="w-full bg-green-50 hover:bg-green-100 disabled:opacity-40 text-green-700 rounded py-2 text-xs font-medium transition-colors border border-green-200 text-left px-3"
          >
            <span className="text-green-300 mr-1.5 font-mono">D</span>
            仅用已有消息建立关系（Sources/Targets）
            {(sources.length > 0 || targets.length > 0) && (
              <span className="ml-1 text-green-400 text-[10px]">·来源{sources.length}·目标{targets.length}</span>
            )}
          </button>
        </div>
      </div>

      {/* ── Focus Controls（折叠）─────────────────────────────────────────── */}
      <div className="border-t border-gray-200 pt-2">
        <button
          onClick={() => setShowFocus(v => !v)}
          className={`w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wide mb-1 ${focusMode ? 'text-amber-700' : 'text-gray-600'}`}
        >
          <span>{focusMode ? '◎ 焦点模式（开启）' : '○ 焦点模式'}</span>
          <span className="font-normal normal-case text-gray-400">{showFocus ? '▲ 收起' : '▼ 展开'}</span>
        </button>

        {showFocus && (
          <div className={`rounded-lg border p-3 ${focusMode ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium ${focusMode ? 'text-amber-800' : 'text-gray-600'}`}>
                {focusMode ? '已开启' : '未开启'}
              </span>
              <button
                onClick={onFocusToggle}
                className={`text-xs px-2 py-0.5 rounded border font-medium transition-colors ${
                  focusMode
                    ? 'bg-amber-200 text-amber-800 border-amber-300 hover:bg-amber-300'
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
                }`}
              >
                {focusMode ? '关闭' : '开启'}
              </button>
            </div>

            {/* Hint: show when not in focus mode and draft has whole-message candidates */}
            {!focusMode && draft.some(d => d.type === 'message') && (
              <p className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
                💡 候选区有消息，点击"开启"将自动以候选消息为焦点
              </p>
            )}

            {focusMode && (
              <div className="space-y-2">
                {/* Current focus display */}
                {focusMessageId && focusMsg ? (
                  <div className="bg-amber-100 border border-amber-300 rounded px-2 py-1.5">
                    <p className="text-xs font-medium text-amber-800 mb-0.5">当前焦点</p>
                    <p className="text-xs text-amber-700 truncate">
                      [{focusMsg.createdBy.username}] {focusMsg.content.slice(0, 40)}{focusMsg.content.length > 40 ? '…' : ''}
                    </p>
                    <p className="text-[10px] text-amber-500 font-mono mt-0.5">{focusMessageId.slice(0, 8)}…</p>
                  </div>
                ) : (
                  <p className="text-xs text-amber-600 italic">未设置焦点消息</p>
                )}

                {/* Focus message selector */}
                <select
                  value={focusMessageId}
                  onChange={e => onFocusMessageChange(e.target.value)}
                  className="w-full border border-amber-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                >
                  <option value="">选择焦点消息…</option>
                  {messages.map(m => (
                    <option key={m.id} value={m.id}>
                      [{m.createdBy.username}] {m.content.slice(0, 35)}{m.content.length > 35 ? '…' : ''}
                    </option>
                  ))}
                </select>

                {/* Hop count */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-700 font-medium shrink-0">跳数</span>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map(n => (
                      <button
                        key={n}
                        onClick={() => onFocusHopsChange(n)}
                        className={`w-7 h-7 text-xs rounded border font-medium transition-colors ${
                          focusHops === n
                            ? 'bg-amber-500 text-white border-amber-500'
                            : 'bg-white text-amber-700 border-amber-300 hover:bg-amber-100'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Exit buttons */}
                <div className="flex gap-1.5">
                  <button
                    onClick={onFocusExit}
                    className="flex-1 text-xs py-1 border border-amber-300 rounded text-amber-700 hover:bg-amber-100"
                  >退出焦点</button>
                  <button
                    onClick={onFocusExitAll}
                    className="flex-1 text-xs py-1 border border-red-300 rounded text-red-600 hover:bg-red-50"
                  >退出全部</button>
                </div>

                <p className="text-[10px] text-amber-500">
                  hop = 文本消息之间经过的关系数；显示 {focusHops} 跳以内的消息与关系。
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Export / Import（折叠）──────────────────────────────────────── */}
      <div className="border-t border-gray-200 pt-2">
        <button
          onClick={() => setShowExportSection(v => !v)}
          className="w-full flex items-center justify-between text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1"
        >
          <span>导出 / 导入</span>
          <span className="text-gray-400 font-normal normal-case">{showExportSection ? '▲ 收起' : '▼ 展开'}</span>
        </button>

        {showExportSection && (
          <div className="space-y-2">
            <div className="flex gap-1.5">
              <button
                onClick={handleExportClick}
                className="flex-1 py-1.5 border border-gray-300 rounded text-gray-600 hover:bg-gray-50 text-xs font-medium"
              >↓ 下载 JSON</button>
              <button
                onClick={handleExportCopy}
                className={`flex-1 py-1.5 border rounded text-xs font-medium transition-colors ${
                  exportCopied
                    ? 'bg-green-50 border-green-300 text-green-700'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
              >{exportCopied ? '✓ 已复制' : '复制 JSON'}</button>
              <button
                onClick={() => setShowImport(v => !v)}
                className="flex-1 py-1.5 border border-gray-300 rounded text-gray-600 hover:bg-gray-50 text-xs font-medium"
              >↑ 导入</button>
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

            {/* Recent messages */}
            <div className="border-t border-gray-100 pt-2">
              <button
                onClick={() => setShowRecent(v => !v)}
                className="w-full flex items-center justify-between text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1"
              >
                <span>最近消息</span>
                <span className="text-gray-400 font-normal normal-case">{showRecent ? '▲ 收起' : '▼ 展开'}</span>
              </button>

              {showRecent && (
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 mb-1">最近普通消息</p>
                    {recentTextMessages.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-1">暂无</p>
                    ) : (
                      <div className="space-y-1">
                        {recentTextMessages.map(msg => (
                          <div key={msg.id} className="text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1">
                            <span className="font-medium text-gray-600">{msg.createdBy.username}</span>
                            <span className="text-gray-400 mx-1">·</span>
                            <span className="text-gray-700 truncate">{msg.content.slice(0, 40)}{msg.content.length > 40 ? '…' : ''}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-[10px] font-medium text-gray-500 mb-1">最近关系消息</p>
                    {recentRelations.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-1">暂无</p>
                    ) : (
                      <div className="space-y-1">
                        {recentRelations.map(rel => {
                          const rSpec = getPresentationSpec(rel.relationType);
                          const rSrc = messages.find(m => m.id === rel.sourceMessageId);
                          return (
                            <div key={rel.id} className="text-xs bg-purple-50 border border-purple-100 rounded px-2 py-1 flex items-center gap-1.5">
                              <span className="font-medium text-purple-700">{rSpec.label}</span>
                              <span className="text-gray-400">by</span>
                              <span className="text-gray-600">{rSrc?.createdBy.username ?? '?'}</span>
                              <span className="text-gray-300 mx-0.5">→</span>
                              <span className="text-gray-500 truncate">{rel.targetRefs.length}个目标</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
