import {api} from '../../../api';
import {isWholeMessageSelection} from '../../../utils/messageElementSelection';
import {clearBrowserSelection} from '../../../utils/graphTextSelection';
import type {DraftSendDependencies} from './sendDraftTypes';
import type {UnitSelection} from '../../../utils/modelBridge';

/** A review is a single dependent relation; its reason never becomes a separate public message. */
export async function sendReviewDraft(deps:DraftSendDependencies,targets:UnitSelection[]){
  if(deps.sourceUnits.length||targets.length!==1||!isWholeMessageSelection(targets[0]!,targets[0]!.messageId))throw new Error('审核需要一条完整目标消息，不能有来源消息');
  if(deps.subType!=='pass'&&deps.subType!=='reject')throw new Error('请选择审核通过或不通过');
  const target=targets[0]!,detail=await api.getReview(target.messageId,undefined,target.reference?.revision);
  if(!detail.canReview)throw new Error('当前没有本条消息本轮的审核资格，请从审核入口查看状态');
  const record=await deps.createRel(deps.scopeMessageId,{
    relationType:'REVIEW',sourceMessageId:null,
    targetRefs:[{kind:'message',messageId:detail.summary.messageId,reference:{messageId:detail.summary.messageId,revision:detail.summary.revision}}],
    payload:{caseId:detail.summary.caseId,reviewRound:detail.summary.round,verdict:deps.subType,content:deps.newMessageContent.trim()},
  });
  await deps.appendCreatedRelation(record);
  window.dispatchEvent(new CustomEvent('review-refresh',{detail:{messageId:target.messageId}}));
  deps.setDraftUnits([]);deps.setSourceUnits([]);deps.setTargetUnits([]);deps.setActiveTextSelectId(null);clearBrowserSelection();
  deps.setNewMessageContent('');deps.setRelationType(null);deps.setSecondaryRelationType('none');deps.setSubType('');
}
