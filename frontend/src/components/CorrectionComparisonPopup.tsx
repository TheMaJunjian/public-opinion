import { useRef } from 'react';
import { computeCorrectionVersions, type DemoEdge, type DemoMessage, type RelationType } from '../utils/modelBridge';
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
  onClose: () => void;
};

export default function CorrectionComparisonPopup({ popup, messages, edges, onClose }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const msgMap = new Map(messages.map(m => [m.id, m]));
  const relEdges = edges.filter(e => e.relationMessageId === popup.relMsgId);
  const sourceMsg = relEdges[0] && !relEdges[0].from.messageId.startsWith('anon:')
    ? msgMap.get(relEdges[0].from.messageId) : null;
  const targetMids = Array.from(new Set(relEdges.map(e => e.to.messageId)));
  const targetMsgs = targetMids.map(id => msgMap.get(id)).filter((m): m is DemoMessage => m != null);
  const relType = relEdges[0]?.relationType ?? '';

  if (relType === 'correct' && targetMsgs.length > 0) {
    const origMsg = targetMsgs[0];
    const correctionVersions = computeCorrectionVersions(messages, edges);
    const correctionVersion = correctionVersions.get(origMsg.id)?.versions.find(version => version.correctionId === popup.relMsgId);
    const baseContent = correctionVersion?.baseContent ?? origMsg.content;
    const correctionContent = relEdges[0] && msgMap.get(popup.relMsgId)?.relationPayload?.correctionContent;

    if (correctionContent !== undefined) {
      const { origParts, nextParts } = computeReplacementDiff(
        baseContent,
        correctionContent,
        relEdges[0]?.to.selection,
      );
      return (
        <PopupOverlay contentRef={contentRef} zIndex={200} background="rgba(0,0,0,0.6)" onClick={onClose}>
          <div ref={contentRef} style={{ background: '#1e1e1e',
            border: '1px solid #555', borderRadius: 8, padding: 16, width: 'min(700px, calc(100vw - 32px))', maxHeight: '80vh',
            overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.8)', color: '#eee',
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 14 }}>✏ 更正对比</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <MessageDiffColumn title="更正前" message={{ ...origMsg, content: baseContent }} border="#554" background="#211e14">
                {renderDiffParts(origParts, 'orig')}
              </MessageDiffColumn>
              <MessageDiffColumn title="更正后" message={msgMap.get(popup.relMsgId) ?? origMsg} border="#255" background="#14201e">
                {renderDiffParts(nextParts, 'next')}
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

function MessageDiffColumn(props: { title: string; message: DemoMessage; border: string; background: string; children: React.ReactNode }) {
  const { title, message, border, background, children } = props;
  return (
    <div style={{ flex: 1, minWidth: 0, borderRadius: 6, border: `1px solid ${border}`, background, padding: 10 }}>
      <MessageMeta title={title} message={message} />
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

function MessageMeta({ title, message }: { title: string; message: DemoMessage }) {
  return (
    <div style={{ fontSize: 11, marginBottom: 6 }}>
      <span style={{ fontWeight: 600 }}>{title}</span>
      <span style={{ marginLeft: 6 }}>{message.author}</span>
      <span style={{ opacity: 0.6, marginLeft: 6 }}>{new Date(message.createdAt).toLocaleString()}</span>
      <span style={{ opacity: 0.45, marginLeft: 6, fontSize: 10 }}>{message.id}</span>
    </div>
  );
}

export function computeReplacementDiff(
  original: string,
  corrected: string,
  selection: DemoEdge['to']['selection'] | undefined,
): { origParts: DiffPart[]; nextParts: DiffPart[] } {
  if (selection?.kind !== 'text') {
    return {
      origParts: original ? [{ type: 'del', text: original }] : [],
      nextParts: corrected ? [{ type: 'ins', text: corrected }] : [],
    };
  }

  const prefixEnd = Math.max(0, Math.min(selection.start, original.length));
  const suffixStartOriginal = Math.max(prefixEnd, Math.min(selection.start + selection.len, original.length));
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
