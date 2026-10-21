import { describe, expect, it, vi } from 'vitest';
import type { Relation } from '../types';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';
import { groupDraftSelections } from '../pages/workbench/actions/cardSelection';
import { getClassifyTargetRefs, getContainerMembershipTargetError, getDependentDisplayTargets, getGroupedTargetTextMessageIds, getSelectedWholeMessageIds, hasCrossNonReferenceTextLinkForClassifyTargets, organizationTargetRef, promoteCompleteContainerSelections, resolveEffectiveTargetUnits } from '../pages/workbench/actions/targetResolution';
import { mergeUnits } from '../pages/workbench/model/selection';
import { handleTagBodyClick } from '../pages/workbench/actions/relationActions';
import type { MouseEvent } from 'react';
import { sendClassificationDraft } from '../pages/workbench/actions/sendClassificationDraft';

const whole=(messageId:string):UnitSelection=>({messageId,selection:{kind:'whole'}});
const element=(messageId:string):UnitSelection=>({messageId,selection:{kind:'whole'},reference:{messageId,revision:3,partId:'relation',path:['roles','members'],memberId:'member'}});
const relation:Relation={id:'group',relationType:'MERGE',sourceMessageId:null,targetRefs:[{kind:'message',messageId:'a'},{kind:'message',messageId:'b'}],createdAt:'',createdBy:{id:'u',username:'用户',createdAt:''}};
const messages:DemoMessage[]=[{id:'a',content:'正文 A',author:'用户',createdAt:'',kind:'normal'},{id:'b',content:'正文 B',author:'用户',createdAt:'',kind:'normal'},{id:'group',content:'归并',author:'用户',createdAt:'',kind:'relation',relationType:'merge'}];
const msgMap=new Map(messages.map(message=>[message.id,message]));
const relationById=new Map([[relation.id,relation]]);
const relationTypeByRelMsgId=new Map([['group','merge' as const]]);

describe('classification boundaries for agreement on an organization', () => {
  const reason: DemoMessage = { ...messages[0], id: 'reason', content: '测试' };
  const agreement: Relation = { ...relation, id: 'agreement', relationType: 'AGREE', sourceMessageId: reason.id,
    targetRefs: [{ kind: 'relation', relationId: relation.id }] };
  const context = { effectiveTargetUnits: [], msgMap: new Map([...msgMap, [reason.id, reason]]),
    relationTypeByRelMsgId, relationById: new Map([...relationById, [agreement.id, agreement]]), relations: [relation, agreement], edges: [] };

  it.each(['AGREE', 'DISAGREE'] as const)('allows either endpoint of %s to be classified without its counterpart or stance message', type => {
    const stance = { ...agreement, relationType: type };
    const edge = { id: 'stance-edge', relationMessageId: stance.id, relationType: type.toLowerCase() as 'agree' | 'disagree',
      from: whole(reason.id), to: whole(relation.id), relationLabel: type };
    for (const edges of [[], [edge]]) {
      const input = { ...context, relations: [relation, stance], edges };
      expect(hasCrossNonReferenceTextLinkForClassifyTargets(input, ['a', 'b'], [whole('group')])).toBeNull();
      expect(hasCrossNonReferenceTextLinkForClassifyTargets(input, ['reason'], [whole('reason')])).toBeNull();
    }
  });

  it.each(['group', 'reason'])('creates a classification containing only the selected %s, without adding the agreement or its other endpoint', async id => {
    const refs = getClassifyTargetRefs({ msgMap: context.msgMap, relationTypeByRelMsgId,
      organizationTargetRef: unit => organizationTargetRef({ msgMap: context.msgMap }, unit) }, [whole(id)]);
    const created = { ...relation, id: 'category', relationType: 'CLASSIFY', targetRefs: refs };
    const createRel = vi.fn(async () => created), showAlert = vi.fn();
    await sendClassificationDraft({
      getGroupedTargetTextMessageIds: units => getGroupedTargetTextMessageIds(context, units),
      msgMap: context.msgMap, relationTypeByRelMsgId, relationById: context.relationById, showAlert,
      hasCrossNonReferenceTextLinkForClassifyTargets: (ids, units) => hasCrossNonReferenceTextLinkForClassifyTargets(context, ids, units),
      edges: [], newMessageContent: '新分类', getClassifyTargetRefs: () => refs, isInsideClassify: false,
      currentClassifyRelMsgId: null, classifyStackRef: { current: [] }, createRel, scopeMessageId: 'root',
      appendCreatedRelation: vi.fn(async () => null), setEdges: vi.fn(), setDraftUnits: vi.fn(), setSourceUnits: vi.fn(),
      setTargetUnits: vi.fn(), setActiveTextSelectId: vi.fn(), setNewMessageContent: vi.fn(), setRelationType: vi.fn(),
      setSecondaryRelationType: vi.fn(), setTraceKey: vi.fn(),
    }, { effectiveTargets: [whole(id)] });
    expect(showAlert).not.toHaveBeenCalled();
    expect(createRel).toHaveBeenCalledExactlyOnceWith('root', expect.objectContaining({ relationType: 'CLASSIFY', targetRefs: refs }));
    expect(refs).toEqual([id === 'group' ? { kind: 'relation', relationId: 'group' } : { kind: 'message', messageId: 'reason' }]);
  });

  it('accepts the reason and the whole organization together without selecting its internal members individually', () => {
    expect(hasCrossNonReferenceTextLinkForClassifyTargets(context, ['a', 'b', 'reason'], [whole('reason'), whole('group')])).toBeNull();
  });

  it('allows a citation across the classification boundary', () => {
    expect(hasCrossNonReferenceTextLinkForClassifyTargets({ ...context, relations: [relation, { ...agreement, relationType: 'REFERENCE' }] }, ['reason'], [whole('reason')])).toBeNull();
  });

  it('keeps the independent-member check when only a member of an unselected merge is chosen', () => {
    expect(hasCrossNonReferenceTextLinkForClassifyTargets(context, ['a'], [whole('a')]))
      .toContain('已在归并消息(group)中');
  });
});

describe('visible element selection preserves its exact target',()=>{
  it('shows members/type selections separately from the containing whole card',()=>{
    const part=element('group');
    expect(groupDraftSelections([part])).toEqual([{messageId:'group',wholeSelected:false,wholeUnits:[],fragments:[part]}]);
    expect(getSelectedWholeMessageIds({draftUnits:[part,whole('a')]})).toEqual(['a']);
    expect(groupDraftSelections([part,whole('group')])[0]).toMatchObject({wholeSelected:true,wholeUnits:[whole('group')],fragments:[part]});
  });

  it('does not promote selected elements or historical messages into their parent organization',()=>{
    const part=element('a'), historical={...whole('b'),reference:{messageId:'b',revision:1}};
    expect(promoteCompleteContainerSelections({relations:[relation]},[part,whole('b')])).toEqual([part,whole('b')]);
    expect(promoteCompleteContainerSelections({relations:[relation]},[whole('a'),historical])).toEqual([whole('a'),historical]);
    expect(promoteCompleteContainerSelections({relations:[relation]},[whole('a'),whole('b'),part])).toEqual([part,whole('group')]);
  });

  it('never expands an organization member-count selection to all contained messages',()=>{
    const context={msgMap,relationById,relationTypeByRelMsgId};
    expect(getGroupedTargetTextMessageIds(context,[element('group')])).toEqual([]);
    expect(getGroupedTargetTextMessageIds(context,[whole('group')])).toEqual(['a','b']);
    const agree:Relation={...relation,id:'agree',relationType:'AGREE',targetRefs:[{kind:'message',messageId:'a'}]};
    expect(getDependentDisplayTargets({relationById:new Map([['agree',agree]])},[element('agree')])).toEqual([]);
    expect(getDependentDisplayTargets({relationById:new Map([['agree',agree]])},[whole('agree')])).toEqual([{messageId:'agree',dependencyId:'a'}]);
  });

  it('keeps the exact reference in relation requests, but rejects elements as organization members',()=>{
    const part=element('group');
    const refs=getClassifyTargetRefs({msgMap,relationTypeByRelMsgId,organizationTargetRef:unit=>organizationTargetRef({msgMap},unit)},[part]);
    expect(refs[0].reference).toEqual(part.reference);
    expect(getContainerMembershipTargetError({relations:[]},[part])).toContain('当前完整消息');
    expect(resolveEffectiveTargetUnits({msgMap,promoteCompleteContainerSelections:units=>promoteCompleteContainerSelections({relations:[relation]},units)},[part],[],'classify')).toEqual([part]);
  });

  it('deduplicates equivalent current whole refs without merging historical or part refs',()=>{
    const current={...whole('a'),reference:{messageId:'a'}},historical={...whole('a'),reference:{messageId:'a',revision:2}},part=element('a');
    expect(mergeUnits([whole('a')],[current,historical,part])).toEqual([whole('a'),historical,part]);
  });

  it('toggling a whole tag record keeps an independently selected visible element',()=>{
    const part=element('tag');
    let draft:UnitSelection[]=[part];
    const click=()=>handleTagBodyClick({setLastClickedMessageId:()=>undefined,setDraftUnits:next=>{draft=typeof next==='function'?next(draft):next;}},{stopPropagation:()=>undefined} as MouseEvent,'a','重要',['tag']);
    click();
    expect(draft).toEqual([part,whole('tag')]);
    click();
    expect(draft).toEqual([part]);
  });
});
