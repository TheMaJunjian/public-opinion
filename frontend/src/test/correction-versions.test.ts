import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds, correctionSelectionIsStale, hasActiveCorrectionForSelection, withCorrectionContent, type DemoEdge, type DemoMessage } from '../utils/modelBridge';
import { formatCorrectionRange, generateCorrectionContent, isCorrectableCorrectionTarget } from '../pages/workbench/model/correction';
import CorrectionComparisonPopup, { computeReplacementDiff, getCorrectionBaseContent, rebuildCorrectionContent } from '../components/CorrectionComparisonPopup';

function message(id: string, createdAt: string, content: string, kind: DemoMessage['kind']): DemoMessage {
  return { id, author: 'tester', createdAt, content, kind };
}

function correctionEdge(id: string, correctionId: string): DemoEdge {
  return {
    id,
    relationMessageId: correctionId,
    relationType: 'correct',
    from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
    to: { messageId: 'original', selection: { kind: 'whole' } },
    relationLabel: 'correct',
  };
}

describe('correction versions', () => {
  it('combines independent part fields and only resolves competing corrections within the same original field', () => {
    const target: DemoMessage = { ...message('original','2026-01-01','旧标题\n旧正文','normal'), revision:1,
      parts:[{id:'title',type:'text',text:'旧标题'},{id:'body',type:'text',text:'旧正文'}] };
    const correction = (id: string, content: string, day: number): DemoMessage => ({...message(id,`2026-01-0${day}`,content,'relation'),relationType:'correct',
      relationPayload:{correctionBeforeContent:target.content,correctionAfterContent:content}});
    const title=correction('title','新标题\n旧正文',2),body=correction('body','旧标题\n新正文',3),otherTitle=correction('other-title','另一标题\n旧正文',4);
    const field = (id: string,partId: string): DemoEdge => ({...correctionEdge(`edge-${id}`,id),to:{messageId:target.id,selection:{kind:'whole'},
      reference:{messageId:target.id,revision:1,partId,path:['text']}}});
    const votes = [['body',5],['other-title',6],['title',7]].map(([targetId,day]) => {
      const id=`vote-${targetId}`,record={...message(id,`2026-01-0${day}`,'','relation'),relationType:'agree' as const,author:'alice'};
      const edge: DemoEdge={id,relationMessageId:id,relationType:'agree',relationLabel:'赞同',from:{messageId:`anon:${id}`,selection:{kind:'whole'}},
        to:{messageId:String(targetId),selection:{kind:'whole'}}};
      return {record,edge};
    });
    const records=[target,title,body,otherTitle,...votes.map(v=>v.record)],edges=[field(title.id,'title'),field(body.id,'body'),field(otherTitle.id,'title'),...votes.map(v=>v.edge)];
    const current=computeCorrectionVersions(records,edges,new Set(),'alice').get(target.id)?.current;
    expect(current?.content).toBe('新标题\n新正文');
    expect(current?.appliedCorrectionIds?.sort()).toEqual(['body','title']);
    const rendered=withCorrectionContent(target,current!.content,current!.changes);
    expect(rendered.parts).toEqual([{id:'title',type:'text',text:'新标题'},{id:'body',type:'text',text:'新正文'}]);
    expect(withCorrectionContent(rendered,current!.content,current!.changes)).toBe(rendered);
    expect(target.parts?.[0]).toMatchObject({text:'旧标题'});
    const preview=computeCorrectionVersions(records,edges,new Set([otherTitle.id]),'alice',{previewCorrectionId:otherTitle.id}).get(target.id)?.current;
    expect(preview?.content).toBe('另一标题\n新正文');
    const previewMessage=withCorrectionContent(target,preview!.content,preview!.changes);
    expect(withCorrectionContent(previewMessage,preview!.content,preview!.changes).parts).toEqual([
      {id:'title',type:'text',text:'另一标题'},{id:'body',type:'text',text:'新正文'},
    ]);
  });

  it('reports a public tie while choosing the newer correction deterministically', () => {
    const original=message('original','2026-01-01','原文','normal');
    const corrections=['older','newer'].map((id,index)=>({...message(id,`2026-01-0${index+2}`,id,'relation'),relationType:'correct' as const}));
    const edges=corrections.map(item=>correctionEdge(`edge-${item.id}`,item.id));
    const current=computeCorrectionVersions([original,...corrections],edges).get(original.id)?.current;
    expect(current).toMatchObject({correctionId:'newer',recommendationTied:true,content:'newer'});
    expect(computeCorrectionVersions([original,...corrections].reverse(),[...edges].reverse()).get(original.id)?.current).toEqual(current);
  });

  it('uses public statistics by default and prioritizes a viewer’s explicit correction choice', () => {
    const original = message('original', '2026-01-01', '原文', 'normal');
    const correction = (id: string, date: string, pro: number, con: number): DemoMessage => ({
      ...message(id, date, id, 'relation'), relationType: 'correct', revision: 1,
      parts: [{ id: 'corrected-body', type: 'text', text: id }, { id: 'relation', type: 'relation', relation: 'correct', roles: {} }],
      relationPayload: { correctionBeforeContent: '原文', correctionAfterContent: id },
      state: { messageId: id, revision: 1, suppressed: false, supportCount: pro, oppositionCount: con, recommendationTotal: 0 },
    });
    const older = correction('older', '2026-01-02', 1, 0), newer = correction('newer', '2026-01-03', 5, 0);
    const vote: DemoMessage = { ...message('choice', '2026-01-04', '', 'relation'), author: 'alice', relationType: 'agree' };
    const voteEdge: DemoEdge = { id: 'choice-edge', relationMessageId: vote.id, relationType: 'agree', relationLabel: '赞同',
      from: { messageId: 'anon:choice', selection: { kind: 'whole' } },
      to: { messageId: older.id, reference: { messageId: older.id, revision: 1, partId: 'relation' }, selection: { kind: 'whole' } } };
    const records = [original, older, newer, vote], links = [correctionEdge('a', older.id), correctionEdge('b', newer.id), voteEdge];
    const current = (user: string | null, data = records, edges = links) => computeCorrectionVersions(data, edges,
      computeEffectiveSuppressedRelIds(edges, data, user), user).get(original.id)?.current;
    expect(current('bob')?.correctionId).toBe(newer.id);
    expect(current('alice')?.correctionId).toBe(older.id);
    const rejected = { ...newer, state: { ...newer.state!, oppositionCount: 6 } };
    expect(current('bob', [original, older, rejected, vote])?.correctionId).toBe(older.id);
    const chooseRejected = { ...voteEdge, to: { ...voteEdge.to, messageId: newer.id,
      reference: { messageId: newer.id, revision: 1, partId: 'relation' } } };
    expect(current('alice', [original, older, rejected, vote], [links[0], links[1], chooseRejected])?.correctionId).toBe(newer.id);
    const empty = [original, correction('older', '2026-01-02', 0, 0), correction('newer', '2026-01-03', 0, 0)];
    expect(current('bob', empty, links.slice(0, 2))?.correctionId).toBe(newer.id);
  });

  it('tracks a native correction’s personal validity without rewriting the original body or title', () => {
    const original: DemoMessage = { ...message('original', '2026-01-01', '正文开头，旧内容，结尾', 'relation'), relationType: 'summary', revision: 1,
      parts: [{ id: 'body', type: 'text', text: '正文开头，旧内容，结尾' }], relationPayload: { title: '正文开头，旧内容，结尾' } };
    const after = original.content.replace('旧内容', '新内容');
    const correction: DemoMessage = { ...message('correction', '2026-01-02', after, 'relation'), relationType: 'correct', revision: 1,
      parts: [{ id: 'relation', type: 'relation', relation: 'correct', roles: {} }],
      relationPayload: { correctionContent: after, correctionBeforeContent: original.content, correctionAfterContent: after },
      state: { messageId: 'correction', revision: 1, suppressed: false, supportCount: 0, oppositionCount: 0, recommendationTotal: 0 } };
    const opposition = { ...message('opposition', '2026-01-03', '', 'relation'), relationType: 'disagree' as const, author: 'alice' };
    const edges: DemoEdge[] = [correctionEdge('e', correction.id), { id: 'opp', relationMessageId: opposition.id, relationType: 'disagree',
      from: { messageId: 'anon:opposition', selection: { kind: 'whole' } }, to: { messageId: correction.id, selection: { kind: 'whole' } }, relationLabel: '反对' }];
    const records = [original, correction, opposition];
    for (const username of [null, 'bob', 'alice']) {
      const rejected = computeEffectiveSuppressedRelIds(edges, records, username);
      const current = computeCorrectionVersions(records, edges, rejected).get(original.id)?.current;
      expect(current?.content).toBe(username === 'alice' ? undefined : after);
    }
    const approval = { ...opposition, id: 'approval', relationType: 'agree' as const, createdAt: '2026-01-04' };
    const restoredEdges = [...edges, { ...edges[1], id: 'approve', relationMessageId: approval.id, relationType: 'agree' as const,
      from: { messageId: 'anon:approval', selection: { kind: 'whole' as const } } }];
    const restoredRecords = [...records, approval];
    expect(computeCorrectionVersions(restoredRecords, restoredEdges, computeEffectiveSuppressedRelIds(restoredEdges, restoredRecords, 'alice')).get(original.id)?.current?.content).toBe(after);
    const shown = withCorrectionContent(original, after);
    expect(shown.content).toBe(after);
    expect(shown.relationPayload?.title).toBe(after);
    expect(shown.parts![0]).toMatchObject({ text: after });
    expect(original.content).not.toBe(after);
    expect(original.relationPayload?.title).toBe(original.content);
    expect(original.parts![0]).toMatchObject({ text: original.content });
  });

  it.each([false, true])('shows full before/after bodies for a text correction record (opposed=%s)', opposed => {
    const before = '开头\n' + '完整总结。'.repeat(100) + '\n旧内容\n结尾';
    const after = before.replace('旧内容', '新内容');
    const target: DemoMessage = { ...message('original', '2026-01-01', after, 'relation'), relationType: 'summary' };
    const correction: DemoMessage = { ...message('correction', '2026-01-02', after, 'relation'), relationType: 'correct',
      relationPayload: { correctionBeforeContent: before, correctionAfterContent: after } };
    const view = render(React.createElement(CorrectionComparisonPopup, { popup: { relMsgId: correction.id, x: 0, y: 0 },
      messages: [target, correction], edges: [correctionEdge('e', correction.id)], invalidCorrectionIds: new Set(opposed ? [correction.id] : []), onClose: vi.fn() }));
    expect(screen.getByRole('region', { name: '修改前全文' }).querySelector('pre')?.textContent).toBe(before);
    expect(screen.getByRole('region', { name: '修改后全文' }).querySelector('pre')?.textContent).toBe(after);
    expect(screen.getByText(opposed ? /当前对你无效/ : /当前对你有效/)).toBeInTheDocument();
    view.unmount();
  });
  const messages = [
    message('original', '2026-01-01T00:00:00.000Z', '原文', 'normal'),
    { ...message('correction-1', '2026-01-01T00:01:00.000Z', '第一次', 'relation'), relationPayload: { correctionContent: '第一次' } },
    { ...message('correction-2', '2026-01-01T00:02:00.000Z', '第二次', 'relation'), relationPayload: { correctionContent: '第二次' } },
  ];
  const edges = [correctionEdge('edge-1', 'correction-1'), correctionEdge('edge-2', 'correction-2')];

  it('keeps every correction based on the original content', () => {
    const versions = computeCorrectionVersions(messages, edges).get('original');

    expect(versions?.versions.map(version => version.baseContent)).toEqual(['原文', '原文']);
    expect(versions?.versions.every(version => !version.conflicted)).toBe(true);
    expect(versions?.current?.content).toBe('第二次');
  });

  it('uses the original content as the base for every correction comparison', () => {
    expect(getCorrectionBaseContent(messages[0], 'correction-2', messages, edges)).toBe('原文');
  });

  it('rebuilds the second right side from the first corrected content', () => {
    const original = '仲裁有真假仲裁（消息是不是真的、非虚构的），真假仲裁投票对应赞同、反对；价值仲裁投票对应推进、冷藏；';
    const first = '仲裁有真假仲裁（消息是不是真的、非虚构的），真假仲裁投票对应赞同、反对；价值仲裁投票对应推荐、冷藏；';
    const rawSecond = '仲裁有真假仲裁（消息是不是真的、对的、非虚构的），真假仲裁投票对应赞同、反对；价值仲裁投票对应推进、冷藏；';

    expect(rebuildCorrectionContent(original, first, rawSecond, {
      kind: 'text', start: 13, len: 2, text: '真的',
    })).toBe('仲裁有真假仲裁（消息是不是真的、对的、非虚构的），真假仲裁投票对应赞同、反对；价值仲裁投票对应推荐、冷藏；');
  });

  it('keeps a changed trailing character outside the replacement range', () => {
    expect(rebuildCorrectionContent('111', '111', '122', {
      kind: 'text', start: 0, len: 2, text: '11',
    })).toBe('121');
  });

  it('generates the second correction from the first correction content', () => {
    const target = message('target', '2026-01-01T00:00:00.000Z', '原文真的', 'normal');
    const first = { ...message('first', '2026-01-01T00:01:00.000Z', '第一次', 'relation'), relationPayload: { correctionContent: '原文真的' } };
    const result = generateCorrectionContent([
      { messageId: target.id, selection: { kind: 'text', start: 2, len: 2, text: '真的' } },
    ], '真的、也对', new Map([[target.id, target]]), first.relationPayload.correctionContent);

    expect(result).toBe('原文真的、也对');
  });

  it('allows an empty replacement to delete a selected fragment', () => {
    const target = message('delete-target', '2026-01-01T00:00:00.000Z', '原文片段', 'normal');

    expect(generateCorrectionContent([
      { messageId: target.id, selection: { kind: 'text', start: 2, len: 2, text: '片段' } },
    ], '', new Map([[target.id, target]]))).toBe('原文');
  });

  it('accepts readable relation messages as correction text targets', () => {
    expect(isCorrectableCorrectionTarget({
      ...message('summary-target', '2026-01-01T00:00:00.000Z', '总结内容', 'relation'),
      relationType: 'summary',
    })).toBe(true);
  });

  it('does not advance the base when an earlier correction is invalid', () => {
    const versions = computeCorrectionVersions(messages, edges, new Set(['correction-1'])).get('original');

    expect(versions?.versions.map(version => version.baseContent)).toEqual(['原文', '原文']);
    expect(versions?.current?.content).toBe('第二次');
  });

  it('does not auto-invalidate a later correction on the same original field', () => {
    const target = message('conflict-target', '2026-01-01T00:00:00.000Z', '111', 'normal');
    const first = { ...message('conflict-1', '2026-01-01T00:01:00.000Z', '121', 'relation'), relationPayload: { correctionContent: '121' } };
    const second = { ...message('conflict-2', '2026-01-01T00:02:00.000Z', '131', 'relation'), relationPayload: { correctionContent: '131' } };
    const textEdge = (id: string, correctionId: string): DemoEdge => ({
      id,
      relationMessageId: correctionId,
      relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 0, len: 2, text: '11' } },
      relationLabel: 'correct',
    });

    const state = computeCorrectionVersions(
      [target, first, second],
      [textEdge('e1', first.id), textEdge('e2', second.id)],
    ).get(target.id);

    expect(state?.versions[1].conflicted).toBe(false);
    expect(state?.current?.content).toBe('131');
  });

  it('prevents agreeing with another correction on an already active field', () => {
    const target = message('exclusive-target', '2026-01-01T00:00:00.000Z', 'abc', 'normal');
    const first = { ...message('exclusive-1', '2026-01-01T00:01:00.000Z', 'Abc', 'relation'), relationPayload: { correctionContent: 'Abc' } };
    const second = { ...message('exclusive-2', '2026-01-01T00:02:00.000Z', 'Xbc', 'relation'), relationPayload: { correctionContent: 'Xbc' } };
    const edge = (id: string, correctionId: string): DemoEdge => ({
      id, relationMessageId: correctionId, relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 0, len: 1, text: 'a' } },
      relationLabel: 'correct',
    });
    const edges = [edge('e1', first.id), edge('e2', second.id)];
    const corrections = computeCorrectionVersions([target, first, second], edges);
    const selection = { kind: 'text', start: 0, len: 1, text: 'a' } as const;

    expect(hasActiveCorrectionForSelection(target.id, selection, corrections, first.id)).toBe(true);
    expect(hasActiveCorrectionForSelection(target.id, selection, corrections, second.id)).toBe(true);
    const secondRejected = computeCorrectionVersions([target, first, second], edges, new Set([second.id]));
    expect(hasActiveCorrectionForSelection(target.id, selection, secondRejected, first.id)).toBe(false);
  });

  it('does not conflict when overlapping corrections produce the same original field value', () => {
    const target = message('same-target', '2026-01-01T00:00:00.000Z', '111', 'normal');
    const first = { ...message('same-1', '2026-01-01T00:01:00.000Z', '121', 'relation'), relationPayload: { correctionContent: '121' } };
    const second = { ...message('same-2', '2026-01-01T00:02:00.000Z', '121', 'relation'), relationPayload: { correctionContent: '121' } };
    const edge = (id: string, correctionId: string): DemoEdge => ({
      id, relationMessageId: correctionId, relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 0, len: 2, text: '11' } },
      relationLabel: 'correct',
    });

    const state = computeCorrectionVersions([target, first, second], [edge('e1', first.id), edge('e2', second.id)]).get(target.id);

    expect(state?.versions.every(version => !version.conflicted)).toBe(true);
  });

  it('does not conflict when corrections change different original fields', () => {
    const target = message('fields-target', '2026-01-01T00:00:00.000Z', 'abcd', 'normal');
    const first = { ...message('fields-1', '2026-01-01T00:01:00.000Z', 'Abcd', 'relation'), relationPayload: { correctionContent: 'Abcd' } };
    const second = { ...message('fields-2', '2026-01-01T00:02:00.000Z', 'abCd', 'relation'), relationPayload: { correctionContent: 'abCd' } };
    const edge = (id: string, correctionId: string, start: number, text: string): DemoEdge => ({
      id, relationMessageId: correctionId, relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start, len: 1, text } },
      relationLabel: 'correct',
    });

    const state = computeCorrectionVersions(
      [target, first, second],
      [edge('e1', first.id, 0, 'a'), edge('e2', second.id, 2, 'c')],
    ).get(target.id);
    expect(state?.versions.every(version => !version.conflicted)).toBe(true);
  });

  it('does not inherit a correction from another field version', () => {
    const target = message('chain-target', '2026-01-01T00:00:00.000Z', 'ABC', 'normal');
    const first = { ...message('chain-1', '2026-01-01T00:01:00.000Z', 'ADEC', 'relation'), relationPayload: { correctionContent: 'ADEC' } };
    const second = { ...message('chain-2', '2026-01-01T00:02:00.000Z', 'ADNC', 'relation'), relationPayload: { correctionContent: 'ADNC' } };
    const firstEdge: DemoEdge = {
      id: 'chain-edge-1', relationMessageId: first.id, relationType: 'correct',
      from: { messageId: `anon:${first.id}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 1, len: 1, text: 'B' } }, relationLabel: 'correct',
    };
    const secondEdge: DemoEdge = {
      id: 'chain-edge-2', relationMessageId: second.id, relationType: 'correct',
      from: { messageId: `anon:${second.id}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 1, len: 2, text: 'DE' } }, relationLabel: 'correct',
    };

    const active = computeCorrectionVersions([target, first, second], [firstEdge, secondEdge]).get(target.id);
    expect(active?.versions.every(version => !version.conflicted)).toBe(true);
    expect(active?.current?.content).toBe('ADEC');

    const rejected = computeCorrectionVersions([target, first, second], [firstEdge, secondEdge], new Set([first.id])).get(target.id);
    expect(rejected?.versions[1].conflicted).toBe(false);
    expect(rejected?.current).toBeUndefined();
  });

  it('keeps non-overlapping corrections valid when each records the original base', () => {
    const target = message('split-target', '2026-01-01T00:00:00.000Z', 'abcde', 'normal');
    const first = { ...message('split-1', '2026-01-01T00:01:00.000Z', 'Abcde', 'relation'), relationPayload: { correctionContent: 'Abcde' } };
    const second = { ...message('split-2', '2026-01-01T00:02:00.000Z', 'abCde', 'relation'), relationPayload: { correctionContent: 'abCde' } };
    const edge = (id: string, correctionId: string, start: number, text: string): DemoEdge => ({
      id,
      relationMessageId: correctionId,
      relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start, len: 1, text } },
      relationLabel: 'correct',
    });

    const state = computeCorrectionVersions(
      [target, first, second],
      [edge('e1', first.id, 0, 'a'), edge('e2', second.id, 2, 'c')],
    ).get(target.id);
    expect(state?.versions.every(version => !version.conflicted)).toBe(true);
    expect(state?.versions.filter(version => version.valid)).toHaveLength(2);
  });

  it('rebuilds the current content after suppressing any correction', () => {
    const target = message('any-target', '2026-01-01T00:00:00.000Z', 'abcde', 'normal');
    const first = { ...message('any-1', '2026-01-01T00:01:00.000Z', 'Abcde', 'relation'), relationPayload: { correctionContent: 'Abcde' } };
    const second = { ...message('any-2', '2026-01-01T00:02:00.000Z', 'abCde', 'relation'), relationPayload: { correctionContent: 'abCde' } };
    const edge = (id: string, correctionId: string, start: number, text: string): DemoEdge => ({
      id, relationMessageId: correctionId, relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start, len: 1, text } },
      relationLabel: 'correct',
    });
    const edges = [edge('e1', first.id, 0, 'a'), edge('e2', second.id, 2, 'c')];

    expect(computeCorrectionVersions([target, first, second], edges).get(target.id)?.current?.content).toBe('AbCde');
    expect(computeCorrectionVersions([target, first, second], edges, new Set([first.id])).get(target.id)?.current?.content).toBe('abCde');
    expect(computeCorrectionVersions([target, first, second], edges, new Set([second.id])).get(target.id)?.current?.content).toBe('Abcde');
  });

  it('detects a stale selection so the user can create a new correction', () => {
    expect(correctionSelectionIsStale('Abcde', { kind: 'text', start: 0, len: 1, text: 'a' })).toBe(true);
    expect(correctionSelectionIsStale('Abcde', { kind: 'text', start: 2, len: 1, text: 'c' })).toBe(false);
  });

  it('disables the correction confirmation button while sending', async () => {
    let resolveConfirmation!: () => void;
    const confirmation = new Promise<void>(resolve => { resolveConfirmation = resolve; });
    const onConfirm = vi.fn(() => confirmation);
    function PopupHarness() {
      const [isSending, setIsSending] = useState(false);
      const handleConfirm = () => {
        setIsSending(true);
        return onConfirm();
      };
      return React.createElement(CorrectionComparisonPopup, {
        popup: { relMsgId: 'new-correction', x: 0, y: 0 },
        messages: [],
        edges: [],
        onClose: vi.fn(),
        isSending,
        reversePreview: { before: '原文', after: '更正后', onConfirm: handleConfirm },
      });
    }
    render(React.createElement(PopupHarness));

    const confirmButton = screen.getByRole('button', { name: '确认发送更正' });
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(confirmButton).toBeDisabled());
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    resolveConfirmation();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });


  it('formats an unambiguous character range for the linear correction text', () => {
    expect(formatCorrectionRange(2, 1, '3')).toBe('start=2 len=1 "3"');
    expect(formatCorrectionRange(0, 3, '全文')).toBe('start=0 len=3 "全文"');
  });

  it('keeps both complete texts while highlighting only the replacement range', () => {
    const result = computeReplacementDiff('111', '112', {
      kind: 'text', start: 1, len: 2, text: '11',
    });

    expect(result.origParts).toEqual([
      { type: 'keep', text: '1' },
      { type: 'del', text: '11' },
    ]);
    expect(result.nextParts).toEqual([
      { type: 'keep', text: '1' },
      { type: 'ins', text: '12' },
    ]);
  });

  it('reanchors a later correction selection after the base text shifts', () => {
    const result = computeReplacementDiff('abcd真的', 'abcd真的、对的', {
      kind: 'text', start: 3, len: 2, text: '真的',
    });

    expect(result.origParts).toEqual([
      { type: 'keep', text: 'abcd' },
      { type: 'del', text: '真的' },
    ]);
    expect(result.nextParts).toEqual([
      { type: 'keep', text: 'abcd' },
      { type: 'ins', text: '真的、对的' },
    ]);
  });

  it('uses actual content changes when a selection is unavailable', () => {
    const result = computeReplacementDiff('abc', 'abXYc', { kind: 'whole' });

    expect(result.origParts).toEqual([
      { type: 'keep', text: 'abc' },
    ]);
    expect(result.nextParts).toEqual([
      { type: 'keep', text: 'ab' },
      { type: 'ins', text: 'XY' },
      { type: 'keep', text: 'c' },
    ]);
  });

});
