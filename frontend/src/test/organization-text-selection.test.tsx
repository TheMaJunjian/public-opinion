import { useState, type MouseEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { replaceReference, resolveReference, type Message as CoreMessage } from '@gonglun/core';
import ClassificationCard from '../components/graph/ClassificationCard';
import OrganizationFrameHeader from '../components/graph/OrganizationFrameHeader';
import MessageCard from '../components/MessageCard';
import { capturePartSelection } from '../utils/partSelection';
import { preparePartCorrection } from '../utils/partCorrection';
import { prepareAddressedCorrection } from '../pages/workbench/actions/sendCorrectionDraft';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';

const title = '图书馆开放时间';
const description = '建立关系：CLASSIFY；目标：member';
const category: DemoMessage = {
  id: 'classification', revision: 2, kind: 'relation', relationType: 'classify', author: '甲', createdAt: '',
  content: description, relationPayload: { title },
  parts: [{ id: 'body', type: 'text', text: description },
    { id: 'relation', type: 'relation', relation: 'classify', roles: { members: [{ id: 'member', reference: { messageId: 'member' } }] } },
    { id: 'metadata', type: 'data', value: { title, kind: 'RELATION', legacyTopicId: 'old-topic' } }],
};
type Surface = 'graph' | 'list' | 'frame';

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

function Organization({ surface, message = category, onSelect = vi.fn() }: {
  surface: Surface; message?: DemoMessage; onSelect?: (selection: UnitSelection | null) => void;
}) {
  const [activeText, setActiveText] = useState(false);
  const activate = () => setActiveText(value => !value);
  const onTextMouseUp = (event: MouseEvent) => onSelect(capturePartSelection(event.currentTarget as HTMLElement, message));
  if (surface === 'graph') return <ClassificationCard msg={message} selectedUnits={[]} box={{ x: 0, y: 0, width: 340 }}
    targetCount={1} title={title} activeText={activeText} isWhole={false} isActive={false} isStanceTarget={false}
    homeLabel={null} relatedJoinRelations={[]} outgoingJoinRelations={[]} isJoinEffective={() => false}
    cardRef={null} headerRef={null} contentRef={null} onMessageClick={vi.fn()} onMessageDoubleClick={activate} onTextMouseUp={onTextMouseUp} />;
  if (surface === 'list') return <MessageCard msg={message}
    ctx={{ isOrganizationMessage: true, isClassification: message.relationType === 'classify', isSummary: message.relationType === 'summary',
      isActiveText: activeText, organizationTitle: title }} onDoubleClick={activate} onContentMouseUp={onTextMouseUp} />;
  return <div onDoubleClick={activate}><OrganizationFrameHeader message={message} messageId={message.id}
    kind={message.relationType as 'classify' | 'summary'} memberCount={1} selectedUnits={[]} activeText={activeText} onTextMouseUp={onTextMouseUp} /></div>;
}

describe('organization correction text', () => {
  it.each(['graph', 'list', 'frame'] as const)('keeps the migrated classification name and its exact field address on the %s surface', surface => {
    const select = vi.fn();
    const view = render(<Organization surface={surface} onSelect={select} />);
    const body = view.getByText(title);
    fireEvent.doubleClick(body);
    expect(view.getByText('拖选文字即可选择片段，或点击已有高亮片段')).toBeInTheDocument();
    expect(body.textContent).toBe(title);
    expect(view.container).not.toHaveTextContent('建立关系');
    expect(body).toHaveAttribute('data-message-part-id', 'metadata');
    const range = document.createRange(); range.setStart(body.firstChild!, 3); range.setEnd(body.firstChild!, 5);
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(body, { detail: 1 });
    const selection = select.mock.calls[0][0] as UnitSelection;
    expect(selection.reference).toEqual({ messageId: category.id, revision: 2, partId: 'metadata', path: ['value', 'title'], range: { start: 3, end: 5 } });
    expect(selection.selection).toEqual({ kind: 'text', start: 3, len: 2, text: '开放' });
    expect(window.getSelection()!.toString()).toBe('开放');
    const prepared = preparePartCorrection(category, selection, '闭馆');
    expect(prepared).toMatchObject({ before: title, after: '图书馆闭馆时间', value: '闭馆' });
    const original = category as unknown as CoreMessage;
    const changed = { ...original, parts: replaceReference(original, selection.reference!, prepared.value) };
    expect(resolveReference({ ...selection.reference!, range: undefined }, () => changed)).toBe('图书馆闭馆时间');
    expect(changed.parts[0]).toEqual(original.parts[0]);
    window.getSelection()!.removeAllRanges();
    fireEvent.doubleClick(body);
    expect(view.queryByText('拖选文字即可选择片段，或点击已有高亮片段')).toBeNull();
    expect(body.textContent).toBe(title);
  });

  it.each(['list', 'frame'] as const)('keeps migrated summary text stable on the %s surface too', surface => {
    const message: DemoMessage = { ...category, relationType: 'summary' };
    const view = render(<Organization surface={surface} message={message} />);
    const body = view.getByText(title);
    fireEvent.doubleClick(body);
    expect(body).toHaveTextContent(title);
    expect(body).toHaveAttribute('data-message-part-id', 'metadata');
    expect(view.container).not.toHaveTextContent('建立关系');
  });

  it('retains the existing body address for a native classification', () => {
    const message: DemoMessage = { ...category, content: title, parts: [{ id: 'body', type: 'text', text: title }, ...category.parts!.slice(1)] };
    const view = render(<Organization surface="graph" message={message} />);
    const body = view.getByText(title);
    fireEvent.doubleClick(body);
    expect(body).toHaveAttribute('data-message-part-id', 'body');
    expect(body).not.toHaveAttribute('data-message-part-path');
    expect(body).toHaveTextContent(title);
  });

  it('never assigns a projected label to an unrelated generated body', () => {
    const message: DemoMessage = { ...category, parts: category.parts!.slice(0, 2) };
    const select = vi.fn(), view = render(<Organization surface="graph" message={message} onSelect={select} />);
    const body = view.getByText(title);
    fireEvent.doubleClick(body);
    expect(body).not.toHaveAttribute('data-message-part-id');
    const range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.addRange(range);
    fireEvent.mouseUp(body, { detail: 1 });
    expect(select).toHaveBeenCalledWith(null);
    expect(window.getSelection()!.toString()).toBe(title);
  });

  it.each(['whole', 'fragment'] as const)('prepares a %s correction against the saved name, leaving generated description intact', async mode => {
    const setComparisonPopup = vi.fn(), setSendError = vi.fn();
    const target: UnitSelection = mode === 'whole' ? { messageId: category.id, selection: { kind: 'whole' } }
      : { messageId: category.id, selection: { kind: 'text', start: 3, len: 2, text: '开放' },
        reference: { messageId: category.id, revision: 2, partId: 'metadata', path: ['value', 'title'], range: { start: 3, end: 5 } } };
    await prepareAddressedCorrection({ msgMap: new Map([[category.id, category]]), correctionVersions: new Map(),
      newMessageContent: mode === 'whole' ? '图书馆闭馆时间' : '闭馆', secondaryRelationType: 'text-correction', setComparisonPopup, setSendError }, { effectiveTargets: [target] });
    expect(setSendError).not.toHaveBeenCalled();
    expect(setComparisonPopup).toHaveBeenCalledWith(expect.objectContaining({ reversePreview: expect.objectContaining({
      before: title, after: '图书馆闭馆时间', target: expect.objectContaining({ reference: expect.objectContaining({ partId: 'metadata', path: ['value', 'title'] }) }),
    }) }));
    expect(category.parts![0]).toEqual({ id: 'body', type: 'text', text: description });
  });
});
