import { describe, expect, it } from 'vitest';
import { getMessageCardContent, getMessageProminence, getMessageTypeLabel, getSummaryCoveredIds, hasActiveDisplayEffect, needsSeparateStanceCard } from '../utils/messageDisplay';
import { applyGroupingColumnOverride } from '../utils/graphColumnRules';
import { buildFrameBlocks } from '../utils/graphOrganizations';
import { projectStanceLayoutEdges } from '../utils/stanceLayout';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const message = (id: string): DemoMessage => ({ id, kind: 'normal', author: 'a', createdAt: '', content: id });
const summary: DemoMessage = {
  ...message('summary'), kind: 'relation', relationType: 'summary',
  parts: [{ id: 'body', type: 'text', text: 'conclusion' }],
  state: { messageId: 'summary', revision: 1, suppressed: false, supportCount: 0, oppositionCount: 0, recommendationTotal: 0 },
};
const summaryEdge: DemoEdge = { id: 'cover', relationMessageId: 'summary', relationType: 'summary', relationLabel: '总结', from: { messageId: 'anon:summary', selection: { kind: 'whole' } }, to: { messageId: 'original', selection: { kind: 'whole' }, reference: { messageId: 'original' } } };

describe('message display effects', () => {
  it('labels distribution records as settlements', () => {
    expect(getMessageTypeLabel({ ...message('settlement'), relationType: 'distribution' })).toBe('结算');
  });

  it('uses the same proposal name for governance and native relations while retaining operation names', () => {
    const proposals: DemoMessage[] = [
      { ...message('governance'), kind: 'governance', backendKind: 'GOVERNANCE' },
      { ...message('native-proposal'), kind: 'relation', relationType: 'proposal' },
    ];
    for (const proposal of proposals) {
      expect(getMessageTypeLabel(proposal)).toBe('提案');
      expect(getMessageTypeLabel({ ...proposal, relationPayload: { operationType: 'DISTRIBUTE_REVENUE' } })).toBe('分配收入');
      expect(getMessageTypeLabel({ ...proposal, relationPayload: { operationType: 'TERMINATE_SETTLEMENT' } })).toBe('终止结算');
    }
  });

  it('uses the settlement target identity in summaries while preserving results and leaving stored content intact',()=>{
    const content='真假仲裁完成：目标消息「第一段\n引用「第二段」；仍是目标正文」；结果：赞成胜出';
    const record:DemoMessage={...message('round'),kind:'round_result',content,settlementTargetId:'target-id',parts:[{id:'body',type:'text',text:content}]};
    expect(getMessageCardContent(record)).toBe('目标：target-id\n结果：赞成胜出');
    expect(record.content).toBe(content);
  });

  it('shows correction before/after text in shared message summaries',()=>{
    const record:DemoMessage={...message('correction'),kind:'relation',relationType:'correct',content:'甲新乙',parts:[
      {id:'corrected-body',type:'text',text:'甲新乙'},
      {id:'relation',type:'relation',relation:'correct',roles:{target:[{id:'target',reference:{messageId:'original',partId:'body',revision:1,range:{start:1,end:2}}}]}},
      {id:'data',type:'data',value:{value:'新',correctionBeforeContent:'甲旧乙'}},
    ]};
    expect(getMessageCardContent(record)).toBe('将「旧」修改为「新」');
    expect(record.content).toBe('甲新乙');
  });

  it('restores the covered original when server suppresses a summary, retaining the declaration for inspection', () => {
    const original = message('original');
    const byId = new Map([[summary.id, summary], [original.id, original]]);
    expect(getSummaryCoveredIds(byId, [summaryEdge]).has('original')).toBe(true);
    const rejected = { ...summary, state: { ...summary.state!, suppressed: true } };
    byId.set(summary.id, rejected);
    expect(getSummaryCoveredIds(byId, [summaryEdge]).size).toBe(0);
    expect(buildFrameBlocks({ edges: [summaryEdge], msgMap: byId, visibleCardIds: new Set(byId.keys()) })).toEqual([]);
    expect(buildFrameBlocks({ edges: [summaryEdge], msgMap: byId, visibleCardIds: new Set(byId.keys()), traceMode: true })).toHaveLength(1);
    expect(byId.get('summary')).toBe(rejected);
  });

  it('does not cover a whole current card merely because a summary refers to its historical part', () => {
    const historical = { ...summaryEdge, to: { ...summaryEdge.to, reference: { messageId: 'original', revision: 1, partId: 'body' } } };
    expect(getSummaryCoveredIds(new Map([[summary.id, summary]]), [historical]).size).toBe(0);
  });

  it('keeps an amendment proposal from moving the target before authorization', () => {
    const proposed: DemoEdge = { ...summaryEdge, relationType: 'correct', proposalOnly: true, from: { messageId: 'proposal', selection: { kind: 'whole' } } };
    const originals = [message('original'), message('proposal')];
    expect(hasActiveDisplayEffect(proposed, new Map())).toBe(false);
    const columns = { original: 0, proposal: 2 };
    expect(applyGroupingColumnOverride({ normals: originals, edges: [proposed], col: columns, maxCol: 2 }).col).toEqual(columns);
  });

  it('promotes recommendation investment equally regardless of wager and respects an authoritative zero', () => {
    const base = { protocol: 1, recommendation: 100, wager: 0 };
    const recommended = getMessageProminence({ spending: base });
    expect(getMessageProminence({ spending: { ...base, wager: 1_000_000 } })).toEqual(recommended);
    expect(recommended.fontSize).toBeGreaterThan(getMessageProminence({ spending: { ...base, recommendation: 0, wager: 1_000_000 } }).fontSize);
    expect(getMessageProminence({ spending: base, state: summary.state }).recommendation).toBe(0);
    expect(getMessageProminence({ spending: { ...base, recommendation: Infinity } }).level).toBe(0);
    expect(getMessageProminence({ spending: { ...base, recommendation: 1e12 } }).fontSize).toBeLessThanOrEqual(18);
  });

  it('keeps a pure vote on a historical part visible and uses its actual side for positioning', () => {
    const original = { ...message('original'), revision: 2 };
    const vote: DemoMessage = { ...message('vote'), kind: 'relation', relationType: 'disagree', parts: [],
      executedStance: { sourceRevision: 1, partId: 'stance', side: 'con', target: { messageId: 'original', revision: 1, partId: 'reason' } } };
    const messages = [original, vote], byId = new Map(messages.map(item => [item.id, item]));
    const declaration: DemoEdge = { ...summaryEdge, relationType: 'disagree', relationMessageId: 'vote', from: { messageId: 'anon:vote', selection: { kind: 'whole' } } };
    expect(needsSeparateStanceCard(vote, byId)).toBe(true);
    expect(projectStanceLayoutEdges(messages, [declaration])[0]).toMatchObject({ from: { messageId: 'vote' }, to: { messageId: 'original', reference: vote.executedStance!.target } });
    const currentWhole = { ...vote, executedStance: { ...vote.executedStance!, target: { messageId: 'original', revision: 2 } } };
    expect(needsSeparateStanceCard(currentWhole, byId)).toBe(false);
    expect(needsSeparateStanceCard({ ...currentWhole, executedStance: { ...currentWhole.executedStance, target: { messageId: 'original', revision: 1 } } }, byId)).toBe(true);
  });
});
