import React from "react";
import { buildAnnoTree, extractTextTargetsForMessage, renderAnnoNodes } from '../../../utils/graphTextSelection';
import type {
  DemoEdge,
  DemoMessage
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

export function renderRelationContentWithTargets(dependencies: RenderRelationContentWithTargetsDependencies, message: DemoMessage): React.JSX.Element {
  const { handleNavigateToMessage } = dependencies;
  const targetRefs = message.targetRefs ?? [];
  const parts = readableParts(message);
  const nativeContent = parts.length ? <div>{parts.map(part => <pre key={part.id}
    data-message-part-id={part.id} data-message-revision={message.revision ?? 1}
    style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>
    {partText(part)}
  </pre>)}</div> : undefined;
  if (targetRefs.length === 0) {
    return nativeContent ?? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{message.content}</pre>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {nativeContent}
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {!nativeContent && message.content.split(/目标：/u)[0]}
        <span>目标：</span>
        {targetRefs.map((target, index) => {
          const targetId = target.kind === 'relation' ? target.relationId : target.messageId;
          return (
            <React.Fragment key={`${target.kind}:${targetId}:${index}`}>
              {index > 0 && ', '}
              <button
                type="button"
                onClick={event => { event.stopPropagation(); handleNavigateToMessage(targetId); }}
                style={{ padding: 0, border: 0, background: 'transparent', color: '#93c5fd', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, textDecoration: 'underline', textUnderlineOffset: 2 }}
                title={`跳转到目标消息 ${targetId}`}
              >
                {targetId}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
