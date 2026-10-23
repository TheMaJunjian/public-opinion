import React from "react";
import { buildAnnoTree, extractTextTargetsForMessage, renderAnnoNodes } from '../../../utils/graphTextSelection';
import { getPresentationSpec } from '../../../types';
import { getMessageTypeLabel } from '../../../utils/messageDisplay';
import { getRelationRecordContentLabel } from '../../../utils/attachedRelationLabels';
import {
  isCardMessage,
  targetRefsSummary,
  type DemoEdge,
  type DemoMessage
} from "../../../utils/modelBridge";

interface RenderAlertMessageDependencies {
  handleNavigateToMessage: (messageId: string) => void;
}

export function renderAlertMessage(dependencies: RenderAlertMessageDependencies, message: string): React.ReactNode {
  const { handleNavigateToMessage } = dependencies;
  const parts: React.ReactNode[] = [];
  const messageIdPattern = /消息(?:「[^」]*」)?\(([^)]+)\)|消息\s+([A-Za-z0-9_-]+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = messageIdPattern.exec(message)) !== null) {
    if (match.index > cursor) parts.push(message.slice(cursor, match.index));
    const messageId = match[1] ?? match[2];
    parts.push(
      <button
        key={`${messageId}-${match.index}`}
        type="button"
        title={`跳转到消息 ${messageId}`}
        onClick={() => {
          handleNavigateToMessage(messageId);
        }}
        style={{
          display: 'inline-block',
          margin: '0 3px',
          padding: '1px 6px',
          border: '1px solid #60a5fa',
          borderRadius: 4,
          background: '#1e3a5f',
          color: '#bfdbfe',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        {messageId}
      </button>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < message.length) parts.push(message.slice(cursor));
  return parts.length > 0 ? parts : message;
}

interface RenderMessageContentWithAnchorsForListDependencies {
  edges: DemoEdge[];
  isFragmentSelected: (messageId: string, start: number, len: number, text: string) => boolean;
  handleFragmentAnchorClick: (messageId: string, start: number, len: number, text: string) => void;
}

function readableParts(message: DemoMessage) {
  return message.parts?.filter(part => part.type === 'text' || part.type === 'code' || part.type === 'web') ?? [];
}

function partText(part: ReturnType<typeof readableParts>[number]): string {
  return part.type === 'text' ? part.text : part.type === 'code' ? part.source : part.excerpt || part.url;
}

export function renderMessageContentWithAnchorsForList(dependencies: RenderMessageContentWithAnchorsForListDependencies, message: DemoMessage): React.JSX.Element {
  const { edges, isFragmentSelected, handleFragmentAnchorClick } = dependencies;
  const targets = extractTextTargetsForMessage(message.id, edges);
  const parts = readableParts(message);
  const text = parts.length ? parts.map(partText).join('\n') : message.content;
  if (targets.length === 0) return <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{text}</pre>;
  const validItems = targets
    .filter(t => t.start >= 0 && t.start + t.len <= text.length && t.len > 0)
    .map(t => ({ start: t.start, end: t.start + t.len, relationType: t.relationType, edgeId: t.edgeId }));
  const tree = buildAnnoTree(validItems);
  const nodes = renderAnnoNodes(text, tree, 0, text.length, 0, message.id, isFragmentSelected, handleFragmentAnchorClick);
  return <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{nodes}</pre>;
}

interface RenderRelationContentWithTargetsDependencies {
  handleNavigateToMessage: (messageId: string) => void;
}

export function renderSettlementContentWithTarget({ handleNavigateToMessage }: RenderRelationContentWithTargetsDependencies, message: DemoMessage): React.JSX.Element {
  const targetId = message.settlementTargetId;
  const parts = readableParts(message);
  const content = parts.length ? parts.map(partText).join('\n') : message.content;
  // These headings and target previews are generated; the type and target chips replace them.
  let details = content;
  if (targetId) {
    details = details.replace(/^(?:发起(?:真假|价值)仲裁|(?:真假|价值)仲裁完成)：目标消息(?:「[^\n]*」|[^；\n]*)(?:；|$)/u, '');
    if (/^发起结算：/u.test(details) && details.includes('。发起人：')) details = details.slice(details.lastIndexOf('。发起人：') + 1);
    else if (/^(?:请求)?发起结算：「[^\n]*」$/u.test(details)) details = '';
  }
  details = details.replace(/^(?:发起(?:真假|价值)仲裁|(?:真假|价值)仲裁完成)：/u, '');
  return <div style={{ display: 'contents' }}>
    {targetId ? <div style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: '100%', order: 1, fontSize: 11 }}>
      <span>目标</span>
      <button type="button" title={`跳转到目标消息 ${targetId}`}
        onClick={event => { event.stopPropagation(); handleNavigateToMessage(targetId); }}
        style={{ padding: '1px 5px', border: '1px solid #374151', borderRadius: 3, background: 'rgba(148,163,184,0.05)', color: '#93c5fd', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>{targetId}</button>
    </div> : <span title="这条结算记录没有保存目标消息引用" style={{ order: 1, fontSize: 11, color: '#9ca3af' }}>目标未记录</span>}
    {details.trim() && <div style={{ order: 1, minWidth: 0, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{details.trim()}</div>}
  </div>;
}

export function renderRelationContentWithTargets(dependencies: RenderRelationContentWithTargetsDependencies, message: DemoMessage): React.JSX.Element {
  const { handleNavigateToMessage } = dependencies;
  const targetRefs = message.targetRefs ?? [];
  if (isCardMessage(message)) {
    const parts = readableParts(message);
    const nativeContent = parts.length ? <div>{parts.map(part => <pre key={part.id}
      data-message-part-id={part.id} data-message-revision={message.revision ?? 1}
      style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>
      {partText(part)}
    </pre>)}</div> : undefined;
    if (targetRefs.length === 0) {
      return nativeContent ?? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{message.content}</pre>;
    }
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {nativeContent}
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {!nativeContent && message.content.split(/目标：/u)[0]}
        <span>目标：</span>
        {targetRefs.map((target, index) => {
          const targetId = target.kind === 'relation' ? target.relationId : target.messageId;
          return <React.Fragment key={`${target.kind}:${targetId}:${index}`}>
            {index > 0 && ', '}
            <button type="button" onClick={event => { event.stopPropagation(); handleNavigateToMessage(targetId); }}
              style={{ padding: 0, border: 0, background: 'transparent', color: '#93c5fd', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, textDecoration: 'underline', textUnderlineOffset: 2 }}
              title={`跳转到目标消息 ${targetId}`}>{targetId}</button>
          </React.Fragment>;
        })}
      </div>
    </div>;
  }
  const targetIds = [...new Set(targetRefs.map(target => target.kind === 'relation' ? target.relationId : target.messageId))];
  const sourceIds = [...new Set([...(message.sourceRefs ?? []).map(ref => ref.messageId), ...(message.sourceMessageId ? [message.sourceMessageId] : [])])];
  const normalize = (text: string) => text.replace(/\s+/gu, '');
  const metadata = new Set<string>();
  const addMetadata = (text: string) => metadata.add(normalize(text));
  const type = getPresentationSpec(message.relationType ?? 'relation').label;
  addMetadata(`建立关系：${message.relationType?.toUpperCase()}`);
  const targetSummaries = [targetRefsSummary(targetRefs), targetRefs.map(target => target.kind === 'relation' ? target.relationId
    : `${target.messageId}${target.kind === 'text-fragment' ? ' 的片段' : ''}`).join(', '), targetIds.join(', '), targetIds.join('、')];
  // Older stored descriptions used the last eight characters of each target ID.
  const shortTargetIds = targetIds.map(id => id.slice(-8));
  targetSummaries.push(shortTargetIds.join(', '), shortTargetIds.join('、'));
  for (const summary of targetSummaries) if (summary) {
    addMetadata(`目标：${summary}`);
    addMetadata(`目标 ID：${summary}`);
    addMetadata(`建立关系：${message.relationType?.toUpperCase()}；目标：${summary}`);
    if (sourceIds.length) addMetadata(`${type} ${sourceIds.join(', ')} → ${summary}`);
    if (message.sourceMessageId) addMetadata(`${type} ${message.sourceMessageId} → ${summary}`);
  }
  if (message.relationType === 'tag' && message.relationPayload?.label) {
    addMetadata(message.relationPayload.label);
    addMetadata(`标签「${message.relationPayload.label}」`);
  }
  const contentLabel = getRelationRecordContentLabel(message);
  if (contentLabel) addMetadata(contentLabel);
  const readable = readableParts(message);
  // Hide only complete generated descriptions; never truncate an authored part at “目标：”.
  const parts = readable.filter(part => part.type !== 'text' || !part.text.split('\n').every(line => !normalize(line) || metadata.has(normalize(line))));
  const legacyContent = readable.length ? '' : message.content.split('\n')
    .filter(line => !metadata.has(normalize(line)) && normalize(line) !== normalize(getMessageTypeLabel(message)))
    .join('\n').trim();
  const nativeContent = parts.length ? <div style={{ flexBasis: '100%', minWidth: 0, order: 3 }}>{parts.map(part => <pre key={part.id}
    data-message-part-id={part.id} data-message-revision={message.revision ?? 1}
    style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>
    {partText(part)}
  </pre>)}</div> : undefined;
  const renderReferences = (ids: string[], label: string) => ids.length > 0 && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 11, maxWidth: '100%', order: 1 }}>
      <span>{label}</span>
      {ids.map(id => <button key={id} type="button"
        onClick={event => { event.stopPropagation(); handleNavigateToMessage(id); }}
        style={{ padding: '1px 5px', border: '1px solid #374151', borderRadius: 3, background: 'rgba(148,163,184,0.05)', color: '#93c5fd', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, maxWidth: '100%', overflowWrap: 'anywhere' }}
        title={`跳转到${label}消息 ${id}`}>{id}</button>)}
    </div>
  );
  return (
    <div style={{ display: 'contents' }}>
      {contentLabel && <div style={{ flexBasis: '100%', minWidth: 0, order: 3, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{contentLabel}</div>}
      {nativeContent}
      {legacyContent && <div style={{ flexBasis: '100%', minWidth: 0, order: 3, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{legacyContent}</div>}
      {renderReferences(sourceIds, '来源')}
      {renderReferences(targetIds, '目标')}
    </div>
  );
}
