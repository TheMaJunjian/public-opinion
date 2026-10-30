import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { calculateSendCost } from '../hooks/useStakeCalculation';
import { createJoinRelationsForContainer, handleCreateRelationWithSourcesAndTargets } from '../pages/workbench/actions/sendRelation';
import { handleSendMessageOnly } from '../pages/workbench/actions/sendText';
import { sendSelectedTagDraft } from '../pages/workbench/actions/sendAnnotationDraft';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';
import type { Relation } from '../types';

vi.mock('../api', () => ({ api: {
  createMessage: vi.fn(), getMessageStakes: vi.fn(async () => ({ stakes: [] })), cancelCommandBatch: vi.fn(),
} }));

const author = { id: 'u', username: '甲', createdAt: '' };
const message = (id: string): DemoMessage => ({ id, kind: 'normal', revision: 3, author: author.username, createdAt: '', content: '理由', parts: [{ id: 'body', type: 'text', text: '理由' }] });
const relationResult: Relation = { id: 'relation-result', relationType: 'AGREE', sourceMessageId: null, createdAt: '', createdBy: author, targetRefs: [] };

beforeEach(() => vi.clearAllMocks());

describe('addressed send commands', () => {
  it.each(['recommend','archive'])('sends text with %s and keeps its custom cause separate',async secondaryRelationType=>{
    const target=message('target'),source=message('new-source'),createRel=vi.fn(async()=>relationResult);
    const handleSendMessageOnly=vi.fn(async()=>source),showAlert=vi.fn();
    const deps={secondaryRelationType,msgMap:new Map([[target.id,target]]),subType:'CUSTOM',subTypeCustomLabel:'需要进一步核实',newMessageContent:'正文说明，不是自定义原因',
      sourceUnits:[],handleSendMessageOnly,createRel,scopeMessageId:'root',registerCreatedRelationInCurrentClassify:vi.fn(async()=>null),edgesRef:{current:[]},showAlert,
      setEdges:vi.fn(),sendTagRelation:vi.fn(async()=>null),setDraftUnits:vi.fn(),setSourceUnits:vi.fn(),setTargetUnits:vi.fn(),setActiveTextSelectId:vi.fn(),
      setNewMessageContent:vi.fn(),setSubType:vi.fn(),setRelationType:vi.fn(),setSecondaryRelationType:vi.fn(),subTypeCustomBufferRef:{current:''},setSubTypeCustomLabel:vi.fn()};
    await sendSelectedTagDraft(deps,{effectiveTargets:[{messageId:target.id,selection:{kind:'whole'}}]});
    expect(handleSendMessageOnly).toHaveBeenCalledExactlyOnceWith('正文说明，不是自定义原因');
    expect(createRel).toHaveBeenCalledExactlyOnceWith('root',expect.objectContaining({relationType:secondaryRelationType.toUpperCase(),sourceMessageId:source.id,
      payload:{subType:'CUSTOM',customLabel:'需要进一步核实'}}));
    expect(calculateSendCost({relationType:'tag',secondaryRelationType,draftUnits:[{messageId:target.id}],targetUnits:[],newMessageContent:deps.newMessageContent,
      stakeAmount:1,relStakeAmount:0,recommendationAmount:2},1)).toMatchObject({hasText:true,relCount:1,messageCount:2});
    expect(showAlert).not.toHaveBeenCalled();
  });
  it.each(['read', 'unread'])('rejects the retired %s send path without creating or charging a message', async secondaryRelationType => {
    const target = message('target');
    const createRel = vi.fn(async () => ({ ...relationResult, relationType: secondaryRelationType.toUpperCase() as Relation['relationType'] }));
    const sendTagRelation = vi.fn(async () => null), registerCreatedRelationInCurrentClassify = vi.fn(async () => null);
    const setEdges = vi.fn(),showAlert=vi.fn();
    await sendSelectedTagDraft({
      secondaryRelationType, msgMap: new Map([[target.id, target]]), subType: '', newMessageContent: '', createRel, scopeMessageId: 'root',
      sourceUnits:[],subTypeCustomLabel:'',handleSendMessageOnly:vi.fn(async()=>null),
      registerCreatedRelationInCurrentClassify, edgesRef: { current: [] }, showAlert, setEdges, sendTagRelation,
      setDraftUnits: vi.fn(), setSourceUnits: vi.fn(), setTargetUnits: vi.fn(), setActiveTextSelectId: vi.fn(), setNewMessageContent: vi.fn(),
      setSubType: vi.fn(), setRelationType: vi.fn(), setSecondaryRelationType: vi.fn(), subTypeCustomBufferRef: { current: '' }, setSubTypeCustomLabel: vi.fn(),
    }, { effectiveTargets: [{ messageId: target.id, selection: { kind: 'whole' } }] });
    expect(createRel).not.toHaveBeenCalled();
    expect(registerCreatedRelationInCurrentClassify).not.toHaveBeenCalled();
    expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('个人查看状态'));
    expect(sendTagRelation).not.toHaveBeenCalled();
    expect(api.createMessage).not.toHaveBeenCalled();
    expect(setEdges).not.toHaveBeenCalled();
  });

  it.each([false, true])('sends only the selected JOIN stance, without implicitly approving its container (with reason: %s)', async withReason => {
    const source = message('reason'), target = { ...message('joining'), kind: 'join' as const, joinInfo: { containerId: 'container', containerType: 'JOIN', targetIds: ['member'] } };
    const createRel = vi.fn(async () => relationResult);
    await handleCreateRelationWithSourcesAndTargets({
      requireAuth: () => true, scopeMessageId: 'root', relationType: 'agree', msgMap: new Map([[source.id, source], [target.id, target]]),
      newMessageContent: '', createRel, registerCreatedRelationInCurrentClassify: vi.fn(async () => null), showAlert: vi.fn(),
      secondaryRelationType: 'none', subType: '', sendTagRelation: vi.fn(async () => null), subTypeCustomLabel: '', setEdges: vi.fn(),
    }, { sources: withReason ? [{ messageId: source.id, selection: { kind: 'whole' } }] : [], targets: [{ messageId: target.id, selection: { kind: 'whole' } }], label: '赞同' });
    expect(createRel).toHaveBeenCalledExactlyOnceWith('root', expect.objectContaining({ relationType: 'AGREE', targetRefs: [expect.objectContaining({ messageId: 'joining' })] }));
  });

  it('retains selected reason parts and does not discard an edge merely because another part uses whole visual selection', async () => {
    const source = message('source'), target = { ...message('target'), kind: 'relation' as const, relationType: 'disagree' as const };
    const reasonParts: UnitSelection[] = [
      { messageId: source.id, selection: { kind: 'whole' }, reference: { messageId: source.id, revision: 3, partId: 'body' } },
      { messageId: source.id, selection: { kind: 'whole' }, reference: { messageId: source.id, revision: 3, partId: 'evidence' } },
    ];
    const targets: UnitSelection[] = [
      { messageId: target.id, selection: { kind: 'whole' }, reference: { messageId: target.id, revision: 3, partId: 'body' } },
      { messageId: target.id, selection: { kind: 'edge', edgeId: 'edge' }, reference: { messageId: target.id, revision: 3, partId: 'stance' } },
    ];
    const createRel = vi.fn<(scope: string, data: Parameters<typeof api.createRelation>[1]) => Promise<Relation>>(async () => relationResult);
    await handleCreateRelationWithSourcesAndTargets({
      requireAuth: () => true, scopeMessageId: 'root', relationType: 'agree', msgMap: new Map([[source.id, source], [target.id, target]]),
      newMessageContent: '', createRel, registerCreatedRelationInCurrentClassify: vi.fn(async () => null), showAlert: vi.fn(),
      secondaryRelationType: 'none', subType: '', sendTagRelation: vi.fn(async () => null), subTypeCustomLabel: '', setEdges: vi.fn(),
    }, { sources: reasonParts, targets, label: '赞同' });
    expect(createRel).toHaveBeenCalledTimes(2);
    expect(createRel.mock.calls.map(call => call[1])).toMatchObject(targets.map(targetUnit => ({
      sourceRefs: reasonParts.map(part => part.reference), targetRefs: [{ reference: targetUnit.reference }],
    })));
  });

  it('refuses a member join addressed to a part before issuing any command', async () => {
    const createRel = vi.fn(async () => relationResult), setSendError = vi.fn();
    const result = await createJoinRelationsForContainer({
      getDependentDisplayTarget: () => null, setSendError, msgMap: new Map([['a', message('a')]]), containerRelationTypes: new Set(['CLASSIFY']),
      relationsRef: { current: [] }, createRel, scopeMessageId: 'root', appendCreatedRelation: vi.fn(async () => null),
    }, 'classification', 'CLASSIFY', [{ kind: 'message', messageId: 'a', reference: { messageId: 'a', partId: 'body' } }]);
    expect(result).toBe(false); expect(createRel).not.toHaveBeenCalled();
    expect(setSendError).toHaveBeenCalledWith(expect.stringContaining('当前完整消息'));
  });

  it.each([true, false])('only skips a repeated join when that exact placement is currently active (active: %s)', async active => {
    const existing: Relation = { ...relationResult, id: 'old-join', relationType: 'JOIN', sourceMessageId: 'classification',
      targetRefs: [{ kind: 'message', messageId: 'a' }], state: { messageId: 'old-join', revision: 1, suppressed: false,
        supportCount: 0, oppositionCount: 0, recommendationTotal: 0, membershipActive: active } };
    const createRel = vi.fn(async () => ({ ...existing, id: 'new-join' }));
    const result = await createJoinRelationsForContainer({
      getDependentDisplayTarget: () => null, setSendError: vi.fn(), msgMap: new Map([['a', message('a')]]), containerRelationTypes: new Set(['CLASSIFY']),
      relationsRef: { current: [existing] }, createRel, scopeMessageId: 'root', appendCreatedRelation: vi.fn(async () => null),
    }, 'classification', 'CLASSIFY', ['a']);
    expect(result).toBe(true);
    if (active) expect(createRel).not.toHaveBeenCalled();
    else expect(createRel).toHaveBeenCalledExactlyOnceWith('root', expect.objectContaining({ relationType: 'JOIN', sourceMessageId: 'classification' }));
  });
});

describe('send money and completion', () => {
  it('queues a created text without remounting its classification canvas or scrolling before commit', async () => {
    vi.mocked(api.createMessage).mockResolvedValue({ id: 'sent', kind: 'TEXT', contentType: 'TEXT', content: '新消息', createdAt: '', createdBy: author });
    const scroll = vi.fn(), remount = vi.fn(), onCreated = vi.fn(),setMessages=vi.fn();
    await handleSendMessageOnly({
      requireAuth: () => true, newMessageContent: '新消息', scopeMessageId: 'root', stakeAmount: 1, setSendError: vi.fn(),
      selectedRelationRef: { current: null }, recommendationRef: { current: 0 }, stakeFeeAmountRef: { current: 1 },
      isInsideClassify: true, availablePoints: 20, currentClassifyRelMsgId: 'classification', setMessages, mergeStakeSnapshot: vi.fn(),
      setAuthorStakes: vi.fn(), setStakeAmount: vi.fn(), minSelfStake: 1, setNewMessageContent: vi.fn(), scrollMsgToCenter: scroll,
      setClassifyKey: remount, handleAuthError: vi.fn(async () => false), onCreated,
    });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('sent');
    expect(setMessages.mock.calls[0][0]([])[0]).toMatchObject({id:'sent',author:'甲',authorId:'u'});
    expect(remount).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });
  it('includes the separately charged placement when sending text within a classification', async () => {
    vi.mocked(api.createMessage).mockResolvedValue({ id: 'sent', kind: 'TEXT', contentType: 'TEXT', content: '新消息', createdAt: '', createdBy: author });
    const scroll = vi.fn(), refresh = vi.fn(); window.addEventListener('points-refresh', refresh);
    await handleSendMessageOnly({
      requireAuth: () => true, newMessageContent: '新消息', scopeMessageId: 'root', stakeAmount: 0, setSendError: vi.fn(),
      selectedRelationRef: { current: null }, recommendationRef: { current: 2 }, stakeFeeAmountRef: { current: 1 },
      isInsideClassify: true, availablePoints: 5, currentClassifyRelMsgId: 'classification', setMessages: vi.fn(), mergeStakeSnapshot: vi.fn(),
      setAuthorStakes: vi.fn(), setStakeAmount: vi.fn(), minSelfStake: 0, setNewMessageContent: vi.fn(), scrollMsgToCenter: scroll,
      setClassifyKey: vi.fn(), handleAuthError: vi.fn(async () => false),
    });
    expect(api.createMessage).toHaveBeenCalledWith('classification', expect.objectContaining({ wager: 0, selfAgree: false, recommendation: 2, joinContribution: {wager:1,recommendation:0} }));
    expect(scroll).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce();
    window.removeEventListener('points-refresh', refresh);
  });

  it('includes a truth stake and protocol fee for each separately submitted governance reference', () => {
    expect(calculateSendCost({ relationType: 'proposal', draftUnits: [{ messageId: 'a' }, { messageId: 'b' }], targetUnits: [], newMessageContent: '提案', stakeAmount: 0, relStakeAmount: 0, recommendationAmount: 2 }, 1)).toMatchObject({
      refCount: 2, refStakeTotal: 2, protocolFeeTotal: 3, stakeTotal: 2, recommendationTotal: 2, total: 7,
    });
  });
  it.each([
    [0, 0, '真假和价值至少一项须大于 0'],
    [1, 0, null], [0, 1, null], [1, 1, null],
  ])('validates truth %s and value %s for each text and relation', (truth, value, error) => {
    for (const relationType of [null, 'reply']) {
      expect(calculateSendCost({relationType,draftUnits:[{messageId:'a'}],targetUnits:[],newMessageContent:'正文',stakeAmount:truth as number,
        relStakeAmount:truth as number,recommendationAmount:value as number,
        contributions:{TEXT:{truth:truth as number,value:value as number},REPLY:{truth:truth as number,value:value as number},TAG:{truth:truth as number,value:value as number}}},1)?.contributionError).toBe(error);
    }
  });
  it('counts both text and relationship investments, including manually submitted joins', () => {
    expect(calculateSendCost({relationType:'reply',draftUnits:[{messageId:'a'},{messageId:'b'}],targetUnits:[],newMessageContent:'正文',stakeAmount:0,
      relStakeAmount:0,recommendationAmount:1,contributions:{TEXT:{truth:0,value:1}}},1)).toMatchObject({stakeTotal:0,recommendationTotal:3,protocolFeeTotal:3,total:6,contributionError:null});
    expect(calculateSendCost({relationType:'classify',draftUnits:[{messageId:'a'},{messageId:'b'}],targetUnits:[],newMessageContent:'',stakeAmount:0,
      relStakeAmount:1,recommendationAmount:0,joinOnlyAction:true},1)).toMatchObject({stakeTotal:2,protocolFeeTotal:2,total:4,contributionError:null});
  });

  it.each(['root','classification'])('groups two references and one text, with only one placement inside a classification (%s)', scopeParentId => {
    const cost=calculateSendCost({relationType:'reference',draftUnits:[{messageId:'a'},{messageId:'b'}],targetUnits:[],newMessageContent:'引用正文',
      stakeAmount:1,relStakeAmount:1,scopeParentId,contributions:{TEXT:{truth:2,value:1},REFERENCE:{truth:4,value:3},JOIN:{truth:5,value:2}}},1)!;
    expect(cost.groups.map(({type,count})=>({type,count}))).toEqual([
      {type:'TEXT',count:1},{type:'REFERENCE',count:2},...(scopeParentId==='root'?[]:[{type:'JOIN',count:1}]),
    ]);
    expect(cost).toMatchObject({messageCount:scopeParentId==='root'?3:4,total:scopeParentId==='root'?20:28,contributionError:null});
    expect(cost.groups.find(group=>group.type==='REFERENCE')).toMatchObject({truth:4,value:3,stakeTotal:8,recommendationTotal:6,protocolFeeTotal:2});
  });

  it('uses one shared JOIN input for all generated placements and multiplies by their count',()=>{
    const base={relationType:'classify',draftUnits:[{messageId:'a'},{messageId:'b'},{messageId:'c'}],targetUnits:[],newMessageContent:'分类',stakeAmount:1,relStakeAmount:1,
      contributions:{CLASSIFY:{truth:0,value:1},JOIN:{truth:4,value:0}}};
    expect(calculateSendCost(base,1)).toMatchObject({messageCount:4,joinCount:3,stakeTotal:12,recommendationTotal:1,protocolFeeTotal:4,total:17});
    expect(calculateSendCost({...base,scopeParentId:'parent',parentByMessageId:new Map([['a','parent'],['b','parent'],['c','parent']])},1))
      .toMatchObject({messageCount:5,joinCount:4,stakeTotal:16,total:22});
  });

  it('only charges new placements when adding selected members to an existing classification',()=>{
    expect(calculateSendCost({relationType:'classify',draftUnits:[],targetUnits:[{messageId:'a'},{messageId:'b'},{messageId:'c'}],sourceUnits:[{messageId:'parent'}],
      newMessageContent:'',stakeAmount:1,relStakeAmount:1,joinOnlyAction:true,existingJoinMemberIds:new Set(['a']),contributions:{JOIN:{truth:4,value:0}}},1))
      .toMatchObject({messageCount:2,joinCount:2,stakeTotal:8,protocolFeeTotal:2,total:10,groups:[{type:'JOIN',count:2,truth:4,value:0}]});
  });

  it.each(['root','parent'])('counts placement of the newly written arrangement member as well as existing members (%s)',scopeParentId=>{
    expect(calculateSendCost({relationType:'arrange',draftUnits:[{messageId:'a'},{messageId:'b'}],targetUnits:[],newMessageContent:'新增成员',stakeAmount:1,relStakeAmount:1,
      scopeParentId,parentByMessageId:new Map(scopeParentId==='root'?[]:[['a','parent'],['b','parent']])},1))
      .toMatchObject({messageCount:scopeParentId==='root'?5:7,joinCount:scopeParentId==='root'?3:5,total:scopeParentId==='root'?10:14});
  });

  it('rejects a zero investment in any active type even when other types have positive contributions',()=>{
    expect(calculateSendCost({relationType:'reference',draftUnits:[{messageId:'a'},{messageId:'b'}],targetUnits:[],newMessageContent:'正文',stakeAmount:1,relStakeAmount:1,
      scopeParentId:'parent',contributions:{TEXT:{truth:1,value:0},REFERENCE:{truth:4,value:0},JOIN:{truth:0,value:0}}},1)?.contributionError)
      .toBe('真假和价值至少一项须大于 0');
  });
});
