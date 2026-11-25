import type { Message, MessageView, RelationView, ReviewVerdict, UserView } from '@gonglun/core';
import type { Store } from './db.js';

/** A public vote is a recorded action. Its historical body may also contain
 * a reason or an excerpt which the viewer cannot read. Rebuild only the fact. */
export async function publicReviewDecisions(store:Store, versions:{id:string;revision:number}[]) {
  const cards=new Map<string,MessageView & RelationView>();
  if(!versions.length)return cards;
  const rows=await store.db.prepare(`SELECT r.body,u.name,u."createdAt" AS "registeredAt",fact.action,
    fact.verdict,fact.round,fact.amount,c.id AS "caseId",c."messageId" AS target,c.revision AS "targetRevision"
    FROM jsonb_to_recordset($1::jsonb) wanted(id text,revision integer)
    JOIN revisions r ON r."messageId"=wanted.id AND r.revision=wanted.revision
    JOIN (
      SELECT v."messageId",'review' AS action,v."userId" AS author,v."caseId",v.verdict,v.round,v.amount FROM moderation_votes v
      UNION ALL SELECT d."messageId",'review-appeal',d."payerId",d."caseId",d.verdict,d.round,d.amount FROM moderation_deposits d WHERE d.round>1
    ) fact ON fact."messageId"=wanted.id JOIN moderation_cases c ON c.id=fact."caseId" JOIN users u ON u.id=fact.author`)
    .all<{body:string;name:string;registeredAt:string;action:'review'|'review-appeal';verdict:ReviewVerdict;round:number;amount:number;
      caseId:string;target:string;targetRevision:number}>(JSON.stringify(versions));
  for(const row of rows){
    const m=JSON.parse(row.body) as Message;
    const action=m.parts.find(part=>part.type==='relation'&&part.relation===row.action);
    if(!action)continue;
    const reference={messageId:row.target,revision:row.targetRevision};
    // An appeal is signed against the preceding round. Its self-stake opens the next one.
    const payload={caseId:row.caseId,reviewRound:row.action==='review-appeal'?row.round-1:row.round,verdict:row.verdict,
      ...(row.action==='review-appeal'?{selfStakeVerdict:row.verdict}:{})};
    const createdBy:UserView={id:m.authorId,username:row.name,createdAt:row.registeredAt??''};
    const card={
      id:m.id,revision:m.revision,sequence:m.sequence,authorId:m.authorId,createdAt:m.createdAt,updatedAt:m.updatedAt,
      regionId:m.regionId,ledgerId:m.ledgerId,programVersion:m.programVersion,ruleVersion:m.ruleVersion,
      spending:{...m.spending,...(row.action==='review'?{reviewWager:row.amount}:{reviewDeposit:row.amount})},
      createdBy,kind:'RELATION',contentType:'TEXT' as const,content:'',relationType:row.action.toUpperCase(),sourceRefs:[],sourceMessageId:null,
      payload,relationPayload:payload,targetRefs:[{kind:'message' as const,messageId:row.target,reference}],
      parts:[{type:'relation' as const,id:action.id,relation:row.action,roles:{target:[{id:'target',reference}]}},
        {type:'data' as const,id:m.parts.find(part=>part.type==='data')?.id??(action.id==='review-data'?'data':'review-data'),value:payload}],
    };
    cards.set(JSON.stringify([m.id,m.revision]),card);
  }
  return cards;
}
