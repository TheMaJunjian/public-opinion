import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Part, Reference } from '@gonglun/core';
import type { Message, Relation } from '../types';
import MessageTextPart from '../components/MessageTextPart';
import MessageCard from '../components/MessageCard';
import { PART_SELECTION_EVENT, isWholeMessageSelection, type PartSelectionDetail } from '../utils/messageElementSelection';
import { capturePartSelection } from '../utils/partSelection';
import { preparePartCorrection } from '../utils/partCorrection';
import { calculateSendCost } from '../hooks/useStakeCalculation';
import {
  computeCorrectedEdgeMap, computeCorrectionVersions, computeTransitiveVoteStats, computeEffectiveSuppressedRelIds,
  convertMessagesToDemoModel, referenceToUnit, targetRefToUnit, unitSelectionToReference,
  unitSelectionToTargetRef, type DemoMessage, type DemoEdge,
} from '../utils/modelBridge';

const body: Part = { id: 'body', type: 'text', text: '重复 / 重复' };
const message = (parts: Part[] = [body]): DemoMessage => ({ id: 'm', revision: 3, author: '甲', createdAt: '2026-01-01T00:00:00Z', content: '重复 / 重复', kind: 'normal', parts });
const user = { id: 'u', username: '甲', createdAt: '' };
const makeEdge = (id: string, to: Reference, relationType: 'agree' | 'disagree' = 'disagree'): DemoEdge => ({
  id, relationMessageId: id, relationType, relationLabel: relationType,
  from: { messageId: `anon:${id}`, selection: { kind: 'whole' } }, to: referenceToUnit(to),
});

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

describe('versioned part selection through the original composer', () => {
  it('keeps the second occurrence and its exact range through the API projection', () => {
    const m = message();
    const { container } = render(<MessageTextPart message={m} />);
    const text = container.querySelector('[data-message-part-id]')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 5); range.setEnd(text, 7);
    const selection = window.getSelection()!; selection.addRange(range);
    const unit = capturePartSelection(container, m, selection)!;
    expect(unit.reference).toEqual({ messageId: 'm', revision: 3, partId: 'body', range: { start: 5, end: 7 } });
    const target = unitSelectionToTargetRef(unit, new Map([[m.id, m]]));
    expect(targetRefToUnit(target).reference).toEqual(unit.reference);
    expect(targetRefToUnit(target).selection).toEqual({ kind: 'text', start: 5, len: 2, text: '重复' });
  });

  it('does not invent a cross-part text address', () => {
    const m = message([body, { id: 'extra', type: 'text', text: '另一部件' }]);
    const { container } = render(<><MessageTextPart message={m} partId="body" /><MessageTextPart message={m} partId="extra" /></>);
    const nodes = container.querySelectorAll('[data-message-part-id]');
    const range = document.createRange(); range.setStart(nodes[0].firstChild!, 1); range.setEnd(nodes[1].firstChild!, 2);
    window.getSelection()!.addRange(range);
    expect(capturePartSelection(container, m)).toBeNull();
  });

  it.each(['classify', 'summary'] as const)('keeps %s title draggable while ordinary double-click reaches container navigation', relationType => {
    const m = { ...message(), kind: 'relation' as const, relationType };
    const navigate = vi.fn();
    const { container } = render(<MessageCard msg={m} ctx={{ isOrganizationMessage: true, isClassification: relationType === 'classify', isSummary: relationType === 'summary', organizationTitle: body.text }} onDoubleClick={navigate} />);
    const textPart = container.querySelector('[data-message-part-id="body"]')!;
    expect(textPart.textContent).toBe(body.text);
    expect(textPart).toHaveStyle({ userSelect: 'text' });
    fireEvent.doubleClick(textPart); expect(navigate).toHaveBeenCalledOnce();
    fireEvent.doubleClick(container.querySelector('[data-msgid]')!); expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('selects ordinary text cards on a single click and lets double-click activate text selection', () => {
    const click = vi.fn(), doubleClick = vi.fn(), mouseUp = vi.fn();
    const props = { msg: message(), onClick: click, onDoubleClick: doubleClick, onContentMouseUp: mouseUp };
    const { container, rerender } = render(<MessageCard {...props} ctx={{}} />);
    const textPart = container.querySelector('[data-message-part-id="body"]')!;
    expect(textPart).toHaveStyle({ userSelect: 'none' });
    fireEvent.click(textPart); expect(click).toHaveBeenCalledWith(expect.anything(), 'm');
    fireEvent.mouseUp(textPart); expect(mouseUp).not.toHaveBeenCalled();
    fireEvent.doubleClick(textPart); expect(doubleClick).toHaveBeenCalledWith(expect.anything(), 'm');
    rerender(<MessageCard {...props} ctx={{ isActiveText: true }} />);
    expect(textPart).toHaveStyle({ userSelect: 'text' });
    fireEvent.mouseUp(textPart, { detail: 1 }); expect(mouseUp).toHaveBeenCalledOnce();
    fireEvent.mouseUp(textPart, { detail: 2 }); expect(mouseUp).toHaveBeenCalledOnce();
  });

  it('does not let generated fallback labels claim to be actual content', () => {
    const m = message([{ id: 'relation', type: 'relation', relation: 'classify', roles: {} }]);
    const { container } = render(<MessageTextPart message={m}>分类（3）</MessageTextPart>);
    expect(container.textContent).toBe('分类（3）');
    expect(container.querySelector('[data-message-part-id]')).toBeNull();
  });

  it('selects the visible relationship badge and membership count directly without an inspector', () => {
    const m = { ...message([body, { id: 'relation', type: 'relation', relation: 'classify', roles: { members: [{ id: 'member-1', reference: { messageId: 'other' } }] } }]), kind: 'relation' as const, relationType: 'classify' as const };
    const select = vi.fn((event: Event) => (event as CustomEvent<PartSelectionDetail>).detail), click = vi.fn();
    window.addEventListener(PART_SELECTION_EVENT, select);
    const badge = { messageId: 'm', revision: 3, partId: 'relation' };
    const selected = referenceToUnit(badge);
    const { getByRole, container } = render(<MessageCard msg={m} selectedUnits={[selected]} ctx={{ isOrganizationMessage: true, isClassification: true, memberCount: 1 }} onClick={click} />);
    expect(container.querySelector('details')).toBeNull();
    fireEvent.click(getByRole('button', { name: '选择分类' }));
    expect(select.mock.results[0].value.reference).toEqual(badge);
    expect(getByRole('button', { name: '选择分类' })).toHaveAttribute('aria-pressed', 'true');
    expect(isWholeMessageSelection(selected, 'm')).toBe(false);
    fireEvent.click(getByRole('button', { name: '选择所含消息' }));
    expect(select.mock.results[1].value.reference).toEqual({ ...badge, path: ['roles', 'members'] });
    expect(click).not.toHaveBeenCalled();
    window.removeEventListener(PART_SELECTION_EVENT, select);
    expect(unitSelectionToReference({ messageId: 'm', selection: { kind: 'whole' } }, new Map([[m.id, m]]))).toEqual({ messageId: 'm' });
  });

  it('sends the replacement of the selected range instead of expanding it to the whole body', () => {
    const target = referenceToUnit({ messageId: 'm', revision: 3, partId: 'body', range: { start: 5, end: 7 } });
    const correction = preparePartCorrection(message(), target, '修改');
    expect(correction.value).toBe('修改');
    expect(correction.before).toBe('重复');
    expect(correction.target.reference).toEqual(target.reference);
    expect(() => preparePartCorrection(message(), referenceToUnit({ messageId: 'm', revision: 2, partId: 'body' }), '错误')).toThrow('版本已变化');
  });

  it('keeps JSON values as JSON when editing data or a binding', () => {
    const m = message([{ id: 'data', type: 'data', value: { recipients: ['u'] } }]);
    const target = referenceToUnit({ messageId: 'm', revision: 3, partId: 'data', path: ['value', 'recipients'] });
    expect(preparePartCorrection(m, target, '["v","w"]').value).toEqual(['v', 'w']);
    expect(() => preparePartCorrection(m, target, '不是 JSON')).toThrow('有效的 JSON');
  });
});

describe('core message identity and execution state', () => {
  it('merges self-agreement into the original message while retaining its relation edge and state', () => {
    const parts: Part[] = [body, { id: 'relation', type: 'relation', relation: 'agree', roles: { target: [{ id: 'target-0', reference: { messageId: 'm', partId: 'body' } }] } }];
    const state = { messageId: 'm', revision: 3, suppressed: false, supportCount: 0, oppositionCount: 0, recommendationTotal: 4 };
    const spending = { protocol: 1, recommendation: 4, wager: 100 };
    const backend: Message = { ...message(parts), state, spending, kind: 'TEXT', contentType: 'TEXT', createdBy: user };
    const relation: Relation = { ...backend, relationType: 'AGREE', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'm', reference: { messageId: 'm', partId: 'body' } }] };
    const result = convertMessagesToDemoModel([backend], [relation]);
    expect(result.messages).toHaveLength(1); expect(result.edges).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: 'm', parts, state, spending });
  });

  it('preserves an amendment proposal without applying or hiding the target before authorization', () => {
    const m = message();
    const relation: Relation = { id: 'amend', revision: 1, relationType: 'CORRECT', sourceMessageId: 'replacement',
      targetRefs: [{ kind: 'message', messageId: m.id, reference: { messageId: m.id, revision: 3, partId: 'body' } }],
      parts: [{ id: 'relation', type: 'relation', relation: 'amend', roles: { target: [{ id: 'target-0', reference: { messageId: m.id, partId: 'body' } }] } }],
      payload: { correctionContent: '待批准' }, createdBy: user, createdAt: '2026-01-02T00:00:00Z' };
    const converted = convertMessagesToDemoModel([], [relation]);
    const versions = computeCorrectionVersions([m, ...converted.messages], converted.edges).get(m.id)!;
    expect(versions.current).toBeUndefined(); expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0].valid).toBe(false); expect(computeCorrectedEdgeMap(converted.edges).size).toBe(0);
  });

  it('reverses an opposition to the stance part but does not reverse an opposition to the reason', () => {
    const original = { ...message(), id: 'original' };
    const opposed: DemoMessage = { ...message(), id: 'opposed', kind: 'relation', relationType: 'disagree', parts: [body,
      { id: 'stance', type: 'relation', relation: 'disagree', roles: { target: [{ id: 'target-0', reference: { messageId: original.id } }] } }] };
    const stanceEdge = makeEdge('anti-stance', { messageId: opposed.id, partId: 'stance' });
    const reasonEdge = makeEdge('anti-reason', { messageId: opposed.id, partId: 'body' });
    const stats = computeTransitiveVoteStats([stanceEdge, reasonEdge], [original, opposed]);
    expect(stats.original).toMatchObject({ agreeCount: 1, disagreeCount: 0 });
    expect(stats.opposed).toBeUndefined();
    expect(Object.values(stats).reduce((sum, item) => sum + item.disagreeCount, 0)).toBe(1);
  });

  it('uses recorded execution after the target is edited, and keeps historical whole-message votes separate', () => {
    const original = { ...message(), id: 'original' };
    const target = { ...message(), id: 'changed' };
    const execution: DemoMessage = { ...message(), id: 'vote', executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: original.id }, side: 'pro' } };
    const stats = computeTransitiveVoteStats([makeEdge('vote', { messageId: target.id, partId: 'stance' }), makeEdge('old', { messageId: original.id, revision: 1 })], [original, target, execution]);
    expect(stats.original).toMatchObject({ agreeCount: 1, disagreeCount: 0 });
    expect(Object.keys(stats).some(key => key.startsWith('reference:'))).toBe(true);
  });

  it('uses the rule execution state for current display rather than replaying a local vote majority', () => {
    const summary: DemoMessage = { ...message(), kind: 'relation', relationType: 'summary', state: { messageId: 'm', revision: 3, suppressed: true, supportCount: 5, oppositionCount: 1, recommendationTotal: 0 } };
    const supporter = { ...message(), id: 'supporter' };
    expect(computeEffectiveSuppressedRelIds([makeEdge('supporter', { messageId: 'm' }, 'agree')], [summary, supporter], '甲').has('m')).toBe(true);
  });
});

describe('independent protocol, recommendation and wager spending', () => {
  const deps = { relationType: null, draftUnits: [], targetUnits: [], newMessageContent: '新发言', stakeAmount: 0, relStakeAmount: 0, recommendationAmount: 0 };
  it('charges only the protocol fee for a default message', () => {
    expect(calculateSendCost(deps, 1)).toMatchObject({ stakeTotal: 0, recommendationTotal: 0, protocolFeeTotal: 1, total: 1 });
  });
  it('keeps recommendation independent from the optional self-agreement wager', () => {
    expect(calculateSendCost({ ...deps, stakeAmount: 9, recommendationAmount: 5 }, 2)).toMatchObject({ stakeTotal: 9, recommendationTotal: 5, protocolFeeTotal: 2, total: 16 });
  });
  it('charges a single organization declaration without phantom JOIN or self-agreement fees', () => {
    expect(calculateSendCost({ ...deps, relationType: 'classify', targetUnits: [{ messageId: 'a' }, { messageId: 'b' }] }, 1)).toMatchObject({ relCount: 1, joinCount: 0, stakeTotal: 0, total: 1 });
  });
  it('counts a new reason plus its reply, or a relation for each selected source and target', () => {
    expect(calculateSendCost({ ...deps, relationType: 'reply', targetUnits: [{ messageId: 'a' }] }, 1)).toMatchObject({ hasText: true, protocolFeeTotal: 2, total: 2 });
    expect(calculateSendCost({ ...deps, relationType: 'reply', sourceUnits: [{ messageId: 's1' }, { messageId: 's2' }], targetUnits: [{ messageId: 'a' }, { messageId: 'b' }] }, 1)).toMatchObject({ hasText: false, relCount: 4, protocolFeeTotal: 4, total: 4 });
  });
});
