import { useRef } from 'react';
import { computeCorrectionVersions, resolveCorrectionContent, type DemoEdge, type DemoMessage, type RelationType } from '../utils/modelBridge';
import { relationTypeName } from './GraphView';
import { computeCharDiff, renderDiffParts, type DiffPart } from './CharDiffText';
import PopupOverlay from './PopupOverlay';

type ComparisonPopupState = {
  relMsgId: string;
  x: number;
  y: number;
};

type Props = {
  popup: ComparisonPopupState;
  messages: DemoMessage[];
  edges: DemoEdge[];
  invalidCorrectionIds?: Set<string>;
  onClose: () => void;
  isSending?: boolean;
  reversePreview?: {
    before: string;
    after: string;
    onConfirm: () => void | Promise<void>;
  };
};

export default function CorrectionComparisonPopup({ popup, messages, edges, invalidCorrectionIds = new Set(), onClose, isSending = false, reversePreview }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const msgMap = new Map(messages.map(m => [m.id, m]));
  const relEdges = edges.filter(e => e.relationMessageId === popup.relMsgId);
  const sourceMsg = relEdges[0] && !relEdges[0].from.messageId.startsWith('anon:')
    ? msgMap.get(relEdges[0].from.messageId) : null;
  const targetMids = Array.from(new Set(relEdges.map(e => e.to.messageId)));
  const targetMsgs = targetMids.map(id => msgMap.get(id)).filter((m): m is DemoMessage => m != null);
  const relType = relEdges[0]?.relationType ?? '';

  if (reversePreview) {
    const { origParts, nextParts } = computeCharDiff(reversePreview.before, reversePreview.after);
    const previewMessage = messages[0] ?? {
      id: 'correction-preview', content: '', kind: 'normal', author: '', createdAt: '',
    } as DemoMessage;
    return (
      <PopupOverlay contentRef={contentRef} zIndex={200} background="rgba(0,0,0,0.6)" onClick={onClose}>
        <div ref={contentRef} style={{ background: '#1e1e1e',
          border: '1px solid #555', borderRadius: 8, padding: 16, width: 'min(700px, calc(100vw - 32px))', maxHeight: '80vh',
          overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.8)', color: '#eee',
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
          onClick={e => e.stopPropagation()}>
          <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 14 }}>✏ 反向更正预览</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <MessageDiffColumn title="发送前最新内容" message={{ ...previewMessage, content: reversePreview.before }} border="#554" background="#211e14">
              {renderDiffParts(origParts, 'orig')}
            </MessageDiffColumn>
            <MessageDiffColumn title="发送后显示内容" message={{ ...previewMessage, content: reversePreview.after }} border="#255" background="#14201e">
              {renderDiffParts(nextParts, 'next')}
            </MessageDiffColumn>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button onClick={onClose} style={buttonStyle}>取消</button>
            <button
              onClick={() => void reversePreview.onConfirm()}
              disabled={isSending}
              style={{ ...buttonStyle, background: '#245b4a', color: '#fff', opacity: isSending ? 0.6 : 1, cursor: isSending ? 'wait' : 'pointer' }}
            >{isSending ? '发送中...' : '确认发送更正'}</button>
          </div>
        </div>
      </PopupOverlay>
    );
  }

  if (relType === 'correct' && targetMsgs.length > 0) {
    const origMsg = targetMsgs[0];
    const selectedVersion = computeCorrectionVersions(messages, edges, invalidCorrectionIds)
      .get(origMsg.id)?.versions.find(version => version.correctionId === popup.relMsgId);
    const beforeContent = origMsg.content;

    if (selectedVersion) {
      const versionState = computeCorrectionVersions(messages, edges, invalidCorrectionIds).get(origMsg.id);
      const effectiveVersions = new Map<string, typeof selectedVersion>();
      for (const version of versionState?.versions ?? []) {
        if (version.valid || version.correctionId === selectedVersion.correctionId) {
          const fieldKey = version.selection?.kind === 'text'
            ? `text:${version.selection.start}:${version.selection.len}`
            : `whole:${beforeContent.length}`;
          effectiveVersions.set(fieldKey, version);
        }
      }
      effectiveVersions.set(
        selectedVersion.selection?.kind === 'text'
          ? `text:${selectedVersion.selection.start}:${selectedVersion.selection.len}`
          : `whole:${beforeContent.length}`,
        selectedVersion,
      );
      const changes = Array.from(effectiveVersions.values()).map(version => {
        const selection = version.selection;
        if (selection?.kind !== 'text') {
          return { version, start: 0, end: beforeContent.length, replacement: version.content };
        }
        const start = Math.max(0, Math.min(selection.start, beforeContent.length));
        const end = Math.max(start, Math.min(start + selection.len, beforeContent.length));
        const suffix = beforeContent.slice(end);
        const prefix = beforeContent.slice(0, start);
        const replacement = version.content.startsWith(prefix) && version.content.endsWith(suffix)
          ? version.content.slice(start, version.content.length - suffix.length || undefined)
          : version.content.slice(start, start + selection.len);
        return { version, start, end, replacement };
      }).sort((left, right) => left.start - right.start);
      let offset = 0;
      const positionedChanges = changes.map(change => {
        const positioned = { ...change, afterStart: change.start + offset };
        offset += change.replacement.length - (change.end - change.start);
        return positioned;
      });
      let afterContent = beforeContent;
      for (const change of [...positionedChanges].sort((left, right) => right.start - left.start)) {
        afterContent = afterContent.slice(0, change.start) + change.replacement + afterContent.slice(change.end);
      }
      const renderHighlightedContent = (content: string, side: 'before' | 'after') => {
        const parts: Array<{ text: string; color?: string }> = [];
        let cursor = 0;
        for (const change of positionedChanges) {
          const isCurrent = change.version.correctionId === selectedVersion.correctionId;
          const color = isCurrent
            ? side === 'before' ? '#ff6b6b' : '#4ade80'
            : '#fbbf24';
          const text = side === 'before'
            ? beforeContent.slice(change.start, change.end)
            : change.replacement;
          const position = side === 'before' ? change.start : change.afterStart;
          if (position > cursor) parts.push({ text: content.slice(cursor, position) });
          if (text) parts.push({ text, color });
          cursor = side === 'before' ? change.end : position + text.length;
        }
        if (cursor < content.length) parts.push({ text: content.slice(cursor) });
        return parts.map((part, index) => (
          <span key={index} style={part.color ? {
            background: part.color === '#fbbf24' ? 'rgba(245,158,11,0.38)' : `${part.color}55`,
            color: part.color,
            borderRadius: 2,
            outline: `1px solid ${part.color}99`,
          } : undefined}>{part.text}</span>
        ));
      };
      return (
        <PopupOverlay contentRef={contentRef} zIndex={200} background="rgba(0,0,0,0.6)" onClick={onClose}>
          <div ref={contentRef} style={{ background: '#1e1e1e',
            border: '1px solid #555', borderRadius: 8, padding: 16, width: 'min(700px, calc(100vw - 32px))', maxHeight: '80vh',
            overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.8)', color: '#eee',
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 14 }}>✏ 更正对比</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <MessageDiffColumn title="原文" message={{ ...origMsg, content: beforeContent }} isCorrected={false} border="#554" background="#211e14">
                {renderHighlightedContent(beforeContent, 'before')}
              </MessageDiffColumn>
              <MessageDiffColumn title="本次更正有效后的最新内容" message={{ ...origMsg, content: afterContent }} border="#255" background="#14201e">
                {renderHighlightedContent(afterContent, 'after')}
              </MessageDiffColumn>
            </div>
            <CloseRow onClose={onClose} />
          </div>
        </PopupOverlay>
      );
    }

    if (origMsg.kind === 'relation') {
      const oldRelEdges = edges.filter(e => e.relationMessageId === origMsg.id);
      const newRelEdges = sourceMsg
        ? edges.filter(e => e.relationMessageId === sourceMsg.id && e.relationType !== 'correct')
        : [];
      const oldType = oldRelEdges[0]?.relationType ?? '';
      const newType = newRelEdges[0]?.relationType ?? '';
      const oldTypeName = relationTypeName(oldType as RelationType);
      const newTypeName = newType ? relationTypeName(newType as RelationType) : '';
      const oldSrcRaw = oldRelEdges[0]?.from.messageId ?? '';
      const newSrcRaw = newRelEdges[0]?.from.messageId ?? '';
      const oldSrc = oldSrcRaw.startsWith('anon:') ? null : oldSrcRaw;
      const newSrc = newSrcRaw.startsWith('anon:') ? null : newSrcRaw;
      const oldTargetIds = Array.from(new Set(oldRelEdges.map(e => e.to.messageId)));
      const newTargetIds = Array.from(new Set(newRelEdges.map(e => e.to.messageId)));
      const oldTargetIdSet = new Set(oldTargetIds);
      const newTargetIdSet = new Set(newTargetIds);
      const removedTargetIds = oldTargetIds.filter(id => !newTargetIdSet.has(id));
      const addedTargetIds = newTargetIds.filter(id => !oldTargetIdSet.has(id));
      const messageValue = (id: string) => msgMap.get(id)?.content || id;
      const oldChanges = [
        oldType !== newType ? oldTypeName : '',
        oldSrc !== newSrc ? (oldSrc ? messageValue(oldSrc) : '无来源') : '',
        ...removedTargetIds.map(messageValue),
      ].filter(Boolean);
      const newChanges = [
        oldType !== newType ? newTypeName : '',
        oldSrc !== newSrc ? (newSrc ? messageValue(newSrc) : '无来源') : '',
        ...addedTargetIds.map(messageValue),
      ].filter(Boolean);
      return (
        <PopupOverlay contentRef={contentRef} zIndex={200} background="rgba(0,0,0,0.6)" onClick={onClose}>
          <div ref={contentRef} style={{ background: '#1e1e1e',
            border: '1px solid #555', borderRadius: 8, padding: 16, width: 'min(700px, calc(100vw - 32px))', maxHeight: '80vh',
            overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.8)', color: '#eee',
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 14 }}>✏ 更正对比（关系消息）</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0, borderRadius: 6, border: '1px solid #554', background: '#211e14', padding: 10 }}>
                <div style={{ fontSize: 11, marginBottom: 6 }}>
                  <span style={{ fontWeight: 600 }}>被替换内容</span>
                  <span style={{ opacity: 0.45, marginLeft: 6, fontSize: 10 }}>{origMsg.id}</span>
                </div>
                <div style={{ fontSize: 13, fontFamily: 'monospace', lineHeight: 1.8 }}>
                  <span style={{ color: '#ff9944', fontWeight: 700 }}>{oldChanges.join('\n') || '无可见变化'}</span>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0, borderRadius: 6, border: '1px solid #255', background: '#14201e', padding: 10 }}>
                <div style={{ fontSize: 11, marginBottom: 6 }}>
                  <span style={{ fontWeight: 600 }}>替换内容</span>
                  {sourceMsg && <span style={{ opacity: 0.45, marginLeft: 6, fontSize: 10 }}>{sourceMsg.id}</span>}
                </div>
                {sourceMsg && (
                  <div style={{ fontSize: 13, fontFamily: 'monospace', lineHeight: 1.8 }}>
                    <span style={{ color: '#44ddaa', fontWeight: 700 }}>{newChanges.join('\n') || '无可见变化'}</span>
                  </div>
                )}
              </div>
            </div>
            <CloseRow onClose={onClose} />
          </div>
        </PopupOverlay>
      );
    }

    if (sourceMsg) {
      let origParts: DiffPart[];
      let nextParts: DiffPart[];
      const textEdge = relEdges.find(e => e.to.selection.kind === 'text');
      const textEdges = relEdges.filter(e => e.to.selection.kind === 'text');
      const hasWholeEdge = relEdges.some(e => e.to.selection.kind === 'whole');
      if (textEdge && textEdges.length === 1) {
        const sel = textEdge.to.selection as { kind: 'text'; start: number; len: number; text: string };
        const s = sel.start;
        const l = sel.len;
        const origLen = origMsg.content.length;
        const nextLen = sourceMsg.content.length;
        const insertedLen = nextLen - origLen + l;
        const prefixOk = s >= 0 && l >= 0 && insertedLen >= 0 && s + l <= origLen && s + insertedLen <= nextLen;
        const contentOk = prefixOk &&
          origMsg.content.slice(0, s) === sourceMsg.content.slice(0, s) &&
          origMsg.content.slice(s + l) === sourceMsg.content.slice(s + insertedLen);
        if (contentOk) {
          origParts = [];
          if (s > 0) origParts.push({ type: 'keep', text: origMsg.content.slice(0, s) });
          if (l > 0) origParts.push({ type: 'del', text: origMsg.content.slice(s, s + l) });
          if (s + l < origLen) origParts.push({ type: 'keep', text: origMsg.content.slice(s + l) });
          nextParts = [];
          if (s > 0) nextParts.push({ type: 'keep', text: sourceMsg.content.slice(0, s) });
          if (insertedLen > 0) nextParts.push({ type: 'ins', text: sourceMsg.content.slice(s, s + insertedLen) });
          if (s + insertedLen < nextLen) nextParts.push({ type: 'keep', text: sourceMsg.content.slice(s + insertedLen) });
        } else {
          ({ origParts, nextParts } = computeCharDiff(origMsg.content, sourceMsg.content));
        }
      } else if (hasWholeEdge && origMsg.content !== sourceMsg.content) {
        ({ origParts, nextParts } = computeCharDiff(origMsg.content, sourceMsg.content));
      } else {
        ({ origParts, nextParts } = computeCharDiff(origMsg.content, sourceMsg.content));
      }
      return (
        <PopupOverlay contentRef={contentRef} zIndex={200} background="rgba(0,0,0,0.6)" onClick={onClose}>
          <div ref={contentRef} style={{ background: '#1e1e1e',
            border: '1px solid #555', borderRadius: 8, padding: 16, width: 'min(700px, calc(100vw - 32px))', maxHeight: '80vh',
            overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.8)', color: '#eee',
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 14 }}>✏ 更正对比</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <MessageDiffColumn title="原文" message={origMsg} border="#554" background="#211e14">
                {renderDiffParts(origParts, 'orig')}
              </MessageDiffColumn>
              <MessageDiffColumn title="更正后" message={sourceMsg} border="#255" background="#14201e">
                {renderDiffParts(nextParts, 'next')}
              </MessageDiffColumn>
            </div>
            <CloseRow onClose={onClose} />
          </div>
        </PopupOverlay>
      );
    }
  }

  return (
    <PopupOverlay contentRef={contentRef} zIndex={200} background="rgba(0,0,0,0.6)" onClick={onClose}>
      <div ref={contentRef} style={{ background: '#1e1e1e',
        border: '1px solid #555', borderRadius: 8, padding: 16, width: 'min(600px, calc(100vw - 32px))', maxHeight: '80vh',
        overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.8)', color: '#eee',
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 14 }}>
          {relationTypeName(relType)}对比：{popup.relMsgId}
        </div>
        <div style={{ display: 'flex', gap: 12, flexDirection: 'column' }}>
          {targetMsgs.map(tm => (
            <PlainMessageCard key={tm.id} title="原文" message={tm} border="#554" background="#232018" />
          ))}
          {sourceMsg && <PlainMessageCard title="更新" message={sourceMsg} border="#255" background="#182028" />}
        </div>
        <CloseRow onClose={onClose} />
      </div>
    </PopupOverlay>
  );
}

const buttonStyle: React.CSSProperties = {
  border: '1px solid #555', borderRadius: 4, padding: '5px 10px',
  background: '#333', color: '#ddd', cursor: 'pointer', fontSize: 12,
};

export function getCorrectionBaseContent(
  target: DemoMessage,
  correctionId: string,
  messages: DemoMessage[],
  edges: DemoEdge[],
): string {
  const correctionVersions = computeCorrectionVersions(messages, edges);
  return correctionVersions.get(target.id)?.versions.find(version => version.correctionId === correctionId)?.baseContent
    ?? target.content;
}

export function rebuildCorrectionContent(
  originalContent: string,
  baseContent: string,
  rawCorrectionContent: string,
  selection: DemoEdge['to']['selection'] | undefined,
): string {
  return resolveCorrectionContent(originalContent, baseContent, rawCorrectionContent, selection);
}

function MessageDiffColumn(props: { title: string; message: DemoMessage; isCorrected?: boolean; border: string; background: string; children: React.ReactNode }) {
  const { title, message, isCorrected, border, background, children } = props;
  return (
    <div style={{ flex: 1, minWidth: 0, borderRadius: 6, border: `1px solid ${border}`, background, padding: 10 }}>
      <MessageMeta title={title} message={message} isCorrected={isCorrected} />
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: '#ddd', fontFamily: 'monospace', lineHeight: 1.6 }}>
        {children}
      </pre>
    </div>
  );
}

function PlainMessageCard(props: { title: string; message: DemoMessage; border: string; background: string }) {
  const { title, message, border, background } = props;
  return (
    <div style={{ borderRadius: 6, border: `1px solid ${border}`, background, padding: 8 }}>
      <MessageMeta title={title} message={message} />
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: '#ddd', fontFamily: 'monospace' }}>{message.content}</pre>
    </div>
  );
}

function MessageMeta({ title, message, isCorrected }: { title: string; message: DemoMessage; isCorrected?: boolean }) {
  return (
    <div style={{ fontSize: 11, marginBottom: 6 }}>
      <span style={{ fontWeight: 600 }}>{title}</span>
      <span style={{ opacity: 0.45, marginLeft: 6, fontSize: 10 }}>{message.id}</span>
      <span style={{ marginLeft: 6 }}>{message.author}</span>
      {isCorrected && <span style={{ color: '#fbbf24', fontWeight: 700, marginLeft: 6 }} title="此内容来自更正版本">已被更正</span>}
      <span style={{ opacity: 0.6, marginLeft: 6 }}>{new Date(message.createdAt).toLocaleString()}</span>
    </div>
  );
}

export function computeReplacementDiff(
  original: string,
  corrected: string,
  selection: DemoEdge['to']['selection'] | undefined,
): { origParts: DiffPart[]; nextParts: DiffPart[] } {
  if (selection?.kind !== 'text') {
    return computeCharDiff(original, corrected);
  }

  const recordedStart = Math.max(0, Math.min(selection.start, original.length));
  const selectionMatches = original.slice(recordedStart, recordedStart + selection.len) === selection.text;
  const resolvedStart = selectionMatches ? recordedStart : original.indexOf(selection.text);
  const prefixEnd = resolvedStart >= 0 ? resolvedStart : recordedStart;
  const suffixStartOriginal = Math.max(prefixEnd, Math.min(prefixEnd + selection.len, original.length));
  const originalSuffix = original.slice(suffixStartOriginal);
  let suffixLength = 0;
  while (
    suffixLength < originalSuffix.length
    && suffixLength < corrected.length - prefixEnd
    && originalSuffix[originalSuffix.length - 1 - suffixLength]
      === corrected[corrected.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }
  const suffixStartCorrected = corrected.length - suffixLength;
  const insertedLength = Math.max(0, suffixStartCorrected - prefixEnd);

  const origParts: DiffPart[] = [];
  const nextParts: DiffPart[] = [];
  if (prefixEnd > 0) {
    origParts.push({ type: 'keep', text: original.slice(0, prefixEnd) });
    nextParts.push({ type: 'keep', text: corrected.slice(0, prefixEnd) });
  }
  if (selection.len > 0) origParts.push({ type: 'del', text: original.slice(prefixEnd, suffixStartOriginal) });
  if (insertedLength > 0) nextParts.push({ type: 'ins', text: corrected.slice(prefixEnd, suffixStartCorrected) });
  if (suffixLength > 0) {
    origParts.push({ type: 'keep', text: original.slice(suffixStartOriginal) });
    nextParts.push({ type: 'keep', text: corrected.slice(suffixStartCorrected) });
  }
  return { origParts, nextParts };
}

function CloseRow({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ marginTop: 12, textAlign: 'right' }}>
      <button onClick={onClose}
        style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #555', background: '#333', color: '#eee', cursor: 'pointer', fontSize: 12 }}>
        关闭
      </button>
    </div>
  );
}
