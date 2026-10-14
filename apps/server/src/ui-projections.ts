import { organization, relations, textOf, type Message, type Reference } from '@gonglun/core';
import { DomainError, Store } from './db.js';
import { dataOf } from './economy.js';
import { statesFor } from './projections.js';
import { personalMarks } from './personal.js';

export type RecordData=Record<string,any>;
export const userView=(store:Store,userId:string)=>userId==='system'?{id:'system',username:'公论规则',name:'公论规则',founder:false,createdAt:''}:{...store.user(userId),createdAt:String(store.db.prepare('SELECT MIN(createdAt) AS at FROM ledger WHERE userId=?').get(userId)?.at??'')};
interface ViewContext {users:Map<string,RecordData>;messages:Map<string,Message>;members:Map<string,string[]>;rounds:Map<string,RecordData>;recipients:Map<string,string[]>}
const cachedMessage=(store:Store,id:string,revision?:number,context?:ViewContext)=>context?.messages.get(`${id}:${revision??'current'}`)??store.message(id,revision);
const cachedUser=(store:Store,id:string,context?:ViewContext)=>context?.users.get(id)??userView(store,id);
export const primaryRelation=(message:Message)=>relations(message).find(part=>part.relation!=='member-of');
const legacyTypes:Record<string,string>={follow:'ATTENTION',unfollow:'ATTENTION',amend:'CORRECT','rule-change':'PROPOSAL',recharge:'PROPOSAL','revenue-injection':'PROPOSAL',delegate:'DELEGATION',fulfill:'DELEGATION','member-of':'JOIN','low-quality':'ARCHIVE','open-settlement':'ROUND',settlement:'ROUND',distribution:'ROUND_RESULT',terminate:'OPERATIONS',release:'CODE_CHANGE'};
export function legacyType(message:Message):string|null {const relation=primaryRelation(message);return String(dataOf(message).uiType??(relation?(legacyTypes[relation.relation]??relation.relation.toUpperCase()):''))||null;}
export function referenceView(store:Store,reference:Reference,context?:ViewContext):RecordData {
  const target=cachedMessage(store,reference.messageId,reference.revision,context),relation=primaryRelation(target);
  if(reference.range){const part=target.parts.find(p=>p.id===reference.partId);const text=part?.type==='text'?part.text:part?.type==='code'?part.source:part?.type==='web'?part.excerpt:'';return {kind:'text-fragment',messageId:target.id,text:text.slice(reference.range.start,reference.range.end),hash:`${target.id}:${target.revision}:${reference.partId}:${reference.range.start}:${reference.range.end}`,reference};}
  return relation?{kind:'relation',relationId:target.id,part:reference.partId===relation.id?'decoration':reference.partId?'label':'whole',reference}:{kind:'message',messageId:target.id,reference};
}
export function scopeSql(parent:string):{cte:string;predicate:string;params:string[]} {
  if(parent==='root')return {cte:'',predicate:'1=1',params:[]};
  return {cte:`WITH RECURSIVE descendants(id) AS (SELECT ? UNION SELECT m.memberId FROM memberships m JOIN descendants d ON m.parentId=d.id), scoped(id) AS (
    SELECT id FROM descendants UNION SELECT r.sourceId FROM refs r JOIN descendants d ON r.targetId=d.id JOIN messages source ON source.id=r.sourceId
    WHERE EXISTS (SELECT 1 FROM json_each(source.body,'$.parts') part,json_each(part.value,'$.roles') role,json_each(role.value) binding
      WHERE json_extract(part.value,'$.relation')<>'member-of' AND json_extract(binding.value,'$.reference.messageId')=r.targetId)
      OR EXISTS (SELECT 1 FROM json_each(source.body,'$.parts') part WHERE json_extract(part.value,'$.type')='display' AND json_extract(part.value,'$.target.messageId')=r.targetId)
  )`,predicate:'m.id IN (SELECT id FROM scoped) AND m.id<>?',params:[parent,parent]};
}
export function scopeMessages(store:Store,parent='root'):Message[] {
  if(parent!=='root')store.message(parent);
  const scope=scopeSql(parent);
  return store.db.prepare(`${scope.cte} SELECT m.body FROM messages m WHERE ${scope.predicate} ORDER BY m.createdAt,m.id`).all(...scope.params).map(row=>JSON.parse(String(row.body)) as Message);
}
export function parentOf(store:Store,messageId:string):string {return String(store.db.prepare('SELECT parentId FROM memberships WHERE memberId=?').get(messageId)?.parentId??'root');}
export function scopeView(store:Store,messageId:string):RecordData {
  if(messageId==='root')return {messageId:null,title:'公论'};
  const message=store.message(messageId);
  return {messageId,title:textOf(message)||'消息'};
}
function contentView(store:Store,message:Message,context?:ViewContext):string {
  const content=textOf(message);if(content)return content;
  const data=dataOf(message),relation=primaryRelation(message);if(typeof data.content==='string'&&data.content)return data.content;
  if(relation?.relation==='distribution') {
    const labels:Record<string,string>={wager:'对赌分配',operations:'运营收入分配',delegation:'委托报酬',penalty:'低质量处罚',reversal:'分配调整',grant:'贡献点发放'};
    const allocations=Array.isArray(data.allocations)?data.allocations as unknown as RecordData[]:[];
    return `${labels[String(data.source)]??'分配'}：${Number(data.total??0)} 贡献点${allocations.length?'；'+allocations.map(a=>`${cachedUser(store,String(a.userId),context).username} ${Number(a.amount)>0?'+':''}${a.amount}`).join('，'):''}。`;
  }
  const target=relation?.roles.target?.[0]?.reference;
  const targetMessage=target?cachedMessage(store,target.messageId,target.revision,context):undefined;
  const labels:Record<string,string>={settlement:'发起结算','open-settlement':'请求发起结算',terminate:'请求终止结算',agree:'赞同',disagree:'反对',amend:'提出修改',authorize:'授权生效',follow:'关注',unfollow:'取消关注',read:'标记已读',unread:'标记未读',recommend:'推荐',archive:'冷藏','low-quality':'低质量评价','rule-change':'规则修改',distribute:'请求分配运营收入',recharge:'充值分账申请','member-of':'加入组织'};
  return `${relation?labels[relation.relation]??legacyType(message)??relation.relation:'消息'}${targetMessage?`：「${textOf(targetMessage).slice(0,120)||legacyType(targetMessage)||'消息'}」`:''}`;
}
export function messageView(store:Store,message:Message,parent?:string,state?:RecordData,context?:ViewContext):RecordData {
  const relation=primaryRelation(message),type=legacyType(message),data=dataOf(message);
  const sources=relation?.roles.source??relation?.roles.reason??[];
  let references=(relation?.roles.target??relation?.roles.members??[]).map(b=>b.reference);
  const declaredTargetRefs=references;
  if(relation&&['classify','summary','merge','arrange'].includes(relation.relation))references=context?(context.members.get(message.id)??[]).map(messageId=>({messageId})):store.db.prepare('SELECT memberId FROM memberships WHERE parentId=? ORDER BY rowid').all(message.id).map(row=>({messageId:String(row.memberId)}));
  let kind=String(data.kind??(type==='ROUND'?'ROUND':type==='ROUND_RESULT'?'ROUND_RESULT':type==='PROPOSAL'?'GOVERNANCE':type==='CODE_CHANGE'?'CODE':type==='OPERATIONS'?'OPERATIONS':relation?'RELATION':'TEXT'));
  const payload:RecordData={...data};delete payload.uiType;delete payload.kind;delete payload.contentType;
  if(relation&&['classify','summary'].includes(relation.relation))payload.title=textOf(message);
  if(relation?.relation==='amend'&&data.value!==undefined)payload.correctionContent=data.value;
  if(relation?.relation==='delegate'){payload.delegationKind='CREATE';payload.rewardAmount=data.reward;}
  if(relation?.relation==='fulfill')payload.delegationKind='FULFILL';
  const display=message.parts.find(p=>p.type==='display');if(display?.type==='display')payload.targetLayout=display.layout==='row'?'single-row':display.layout==='columns'?'multi-column':'single-column';
  if(relation?.relation==='settlement'){const row=context?undefined:store.db.prepare('SELECT body FROM rounds WHERE id=?').get(message.id),round=context?.rounds.get(message.id)??(row?JSON.parse(String(row.body)):undefined);if(round){payload.roundId=message.id;payload.targetMessageId=round.target.messageId;}}
  if(relation?.relation==='notify'){payload.notifyUserIds=context?context.recipients.get(message.id)??[]:store.db.prepare('SELECT DISTINCT userId FROM notification_receipts WHERE sourceId=?').all(message.id).map(r=>String(r.userId));payload.notifyUsers=payload.notifyUserIds.map((id:string)=>cachedUser(store,id,context));}
  const stateValue=state??statesFor(store,[message.id])[0];
  return {id:message.id,kind,contentType:data.contentType==='MARKDOWN'?'MARKDOWN':'TEXT',content:contentView(store,message,context),createdAt:message.createdAt,updatedAt:message.updatedAt,createdBy:cachedUser(store,message.authorId,context),relationType:type,relSourceId:sources[0]?.reference.messageId??null,sourceMessageId:sources[0]?.reference.messageId??null,sourceRefs:sources.map(b=>b.reference),targetRefs:references.map(ref=>referenceView(store,ref,context)),declaredTargetRefs:declaredTargetRefs.map(ref=>referenceView(store,ref,context)),relationPayload:payload,payload,revision:message.revision,parts:message.parts,sequence:message.sequence,spending:message.spending,state:stateValue,executedStance:stateValue?.executedStance,supersededBy:null};
}
export function viewsFor(store:Store,messages:Message[],parent?:string) {
  const ids=messages.map(m=>m.id),states=new Map(statesFor(store,ids).map(s=>[s.messageId,s])),context:ViewContext={users:new Map(allUsers(store).map(user=>[user.id,user])),messages:new Map(),members:new Map(),rounds:new Map(),recipients:new Map()};context.users.set('system',userView(store,'system'));
  const refs=new Map<string,Reference>();for(const message of messages){context.messages.set(`${message.id}:current`,message);context.messages.set(`${message.id}:${message.revision}`,message);for(const part of relations(message))for(const binding of Object.values(part.roles).flat())refs.set(`${binding.reference.messageId}:${binding.reference.revision??'current'}`,binding.reference);}
  for(let offset=0;offset<ids.length;offset+=200){const batch=ids.slice(offset,offset+200),placeholders=batch.map(()=>'?').join(',');
    for(const row of store.db.prepare(`SELECT parentId,memberId FROM memberships WHERE parentId IN (${placeholders}) ORDER BY rowid`).all(...batch)){const parentId=String(row.parentId),memberId=String(row.memberId);(context.members.get(parentId)??(context.members.set(parentId,[]),context.members.get(parentId)!)).push(memberId);refs.set(`${memberId}:current`,{messageId:memberId});}
    for(const row of store.db.prepare(`SELECT id,body FROM rounds WHERE id IN (${placeholders})`).all(...batch))context.rounds.set(String(row.id),JSON.parse(String(row.body)));
    for(const row of store.db.prepare(`SELECT DISTINCT sourceId,userId FROM notification_receipts WHERE sourceId IN (${placeholders})`).all(...batch)){const key=String(row.sourceId);(context.recipients.get(key)??(context.recipients.set(key,[]),context.recipients.get(key)!)).push(String(row.userId));}
  }
  const missing=[...refs].filter(([key])=>!context.messages.has(key));for(let i=0;i<missing.length;i+=150){const batch=missing.slice(i,i+150),current=batch.filter(([,ref])=>ref.revision===undefined),historical=batch.filter(([,ref])=>ref.revision!==undefined);
    if(current.length)for(const row of store.db.prepare(`SELECT body FROM messages WHERE id IN (${current.map(()=>'?').join(',')})`).all(...current.map(([,ref])=>ref.messageId))){const message=JSON.parse(String(row.body)) as Message;context.messages.set(`${message.id}:current`,message);}
    if(historical.length)for(const row of store.db.prepare(`SELECT body FROM revisions WHERE (messageId,revision) IN (${historical.map(()=>'(?,?)').join(',')})`).all(...historical.flatMap(([,ref])=>[ref.messageId,ref.revision!]))) {const message=JSON.parse(String(row.body)) as Message;context.messages.set(`${message.id}:${message.revision}`,message);}
  }
  return messages.map(m=>messageView(store,m,parent,states.get(m.id),context));
}
export function paginate<T>(data:T[],query:RecordData,max=200) {const page=Math.max(1,Number(query.page)||1),limit=Math.min(max,Math.max(1,Number(query.limit)||50));return {data:data.slice((page-1)*limit,page*limit),pagination:{page,limit,total:data.length,totalPages:Math.ceil(data.length/limit)}};}
export function allUsers(store:Store){return store.db.prepare('SELECT u.id,u.name,u.founder,MIN(l.createdAt) AS createdAt FROM users u LEFT JOIN ledger l ON l.userId=u.id GROUP BY u.id ORDER BY u.rowid').all().map(row=>({id:String(row.id),name:String(row.name),username:String(row.name),founder:!!row.founder,createdAt:String(row.createdAt??'')}));}
export function accountView(store:Store,userId:string) {
  const account=store.account(userId),rows=store.db.prepare('SELECT amount,lockedDelta,reason FROM ledger WHERE userId=? ORDER BY rowid').all(userId);
  const sum=(fn:(row:RecordData)=>number)=>rows.reduce((total,row)=>total+fn(row),0);
  const bets=new Map(store.db.prepare('SELECT id,amount FROM bets WHERE userId=?').all(userId).map(row=>[String(row.id),Number(row.amount)])),latest=new Map<string,RecordData>();
  for(const row of store.db.prepare("SELECT body FROM rounds WHERE json_extract(body,'$.status')='settled' ORDER BY rowid").all()){const round=JSON.parse(String(row.body));latest.set(round.targetKey,round);}
  let totalEarned=0,totalLost=0;for(const round of latest.values()){const principal=(round.betIds as string[]).reduce((sum,id)=>sum+(bets.get(id)??0),0),payout=(round.payouts as RecordData[]).filter(a=>a.userId===userId).reduce((sum,a)=>sum+Number(a.amount),0),net=payout-principal;totalEarned+=Math.max(0,net);totalLost+=Math.max(0,-net);}
  return {points:{available:account.available,locked:account.locked},balance:{amount:account.available,debtFrozen:account.available<0},breakdown:{initialMinted:sum(r=>r.reason==='初始发放'?Number(r.amount):0),totalEarned,totalLost,totalProtocolFees:sum(r=>r.reason==='协议费'?-Number(r.amount):0)}};
}
export function stakesFor(store:Store,ids:string[]):Record<string,RecordData> {
  const users=new Map(allUsers(store).map(user=>[user.id,user])),result:Record<string,RecordData>={};for(const id of ids)result[id]={messageId:id,pool:{lockedPro:0,lockedCon:0},pools:{TRUTH:{lockedPro:0,lockedCon:0},VALUE:{lockedPro:0,lockedCon:0}},stakes:[],counts:{pro:0,con:0},countsByType:{TRUTH:{pro:0,con:0},VALUE:{pro:0,con:0}}};
  for(let offset=0;offset<ids.length;offset+=200){const chunk=ids.slice(offset,offset+200);if(!chunk.length)continue;
    const rows=store.db.prepare(`SELECT bets.*,m.createdAt,r.body AS roundBody FROM bets JOIN messages m ON m.id=bets.messageId JOIN rounds r ON r.id=bets.roundId WHERE COALESCE(json_extract(r.body,'$.subjectId'),json_extract(r.body,'$.target.messageId')) IN (${chunk.map(()=>'?').join(',')})`).all(...chunk);
    for(const row of rows){const round=JSON.parse(String(row.roundBody)),value=result[round.subjectId??round.target.messageId];if(!value)continue;const side=row.side==='pro'?'pro':'con',type=round.settlementType==='VALUE'?'VALUE':'TRUTH';value.counts[side]+=Number(row.amount);value.countsByType[type][side]+=Number(row.amount);value.stakes.push({id:row.id,side:side.toUpperCase(),amount:row.amount,createdAt:row.createdAt,roundId:row.roundId,settlementType:type,user:users.get(String(row.userId)),reference:round.target});if(round.status!=='settled'){value.pool[side==='pro'?'lockedPro':'lockedCon']+=Number(row.amount);value.pools[type][side==='pro'?'lockedPro':'lockedCon']+=Number(row.amount);}}
  }return result;
}
export function roundView(store:Store,id:string,userId?:string):RecordData {
  const row=store.db.prepare('SELECT body FROM rounds WHERE id=?').get(id);if(!row)throw new DomainError('结算不存在',404);
  const round=JSON.parse(String(row.body)),declaration=store.message(id),basis=dataOf(declaration),authorId=String(basis.openedBy??declaration.authorId);
  const bets=store.db.prepare('SELECT b.*,m.createdAt,m.body FROM bets b JOIN messages m ON m.id=b.messageId WHERE b.targetKey=? ORDER BY b.rowid').all(round.targetKey).filter(b=>round.status!=='settled'||round.betIds.includes(b.id));
  const active=bets.filter(b=>b.roundId===id),sum=(side:string,rows=bets)=>rows.filter(b=>b.side===side).reduce((s,b)=>s+Number(b.amount),0);
  let personalSettlement:RecordData|undefined;
  if(userId){const own=bets.filter(b=>b.userId===userId),principal=own.reduce((s,b)=>s+Number(b.amount),0),protocolFee=own.reduce((s,b)=>s+(JSON.parse(String(b.body)) as Message).spending.protocol,0);const payout=(round.payouts??[]).filter((a:RecordData)=>a.userId===userId).reduce((s:number,a:RecordData)=>s+a.amount,0);if(principal){let previousAfter:number|undefined;const previousRow=round.previousRoundId?store.db.prepare('SELECT body FROM rounds WHERE id=?').get(round.previousRoundId):undefined;if(previousRow){const previous=JSON.parse(String(previousRow.body)),prior=own.filter(b=>previous.betIds.includes(b.id));previousAfter=previous.payouts.filter((a:RecordData)=>a.userId===userId).reduce((s:number,a:RecordData)=>s+a.amount,0)-prior.reduce((s,b)=>s+Number(b.amount)+(JSON.parse(String(b.body)) as Message).spending.protocol,0);}const after=payout-principal-protocolFee;personalSettlement={principal:principal+protocolFee,stakePrincipal:principal,protocolFee,after,change:after-(previousAfter??0),...(previousAfter===undefined?{}:{previousAfter})};}}
  return {id,roundMessageId:id,messageId:round.subjectId??round.target.messageId,reference:round.target,createdByUserId:authorId,createdBy:userView(store,authorId),status:round.status==='settled'?'SETTLED':round.status==='waiting'?'VOTING':'OPEN',settlementType:round.settlementType??'TRUTH',result:round.result==='pro'?'TRUE':round.result==='con'?'FALSE':round.result==='tie'?'UNKNOWN':null,previousRoundId:round.previousRoundId,openedAt:round.createdAt,closedAt:round.status==='settled'?round.endsAt:null,endsAt:round.endsAt,note:null,settlementPro:round.pro,settlementCon:round.con,totalProAtSettlement:round.pro,totalConAtSettlement:round.con,weights:{TRUE:sum('pro'),FALSE:sum('con'),UNKNOWN:0},roundWeights:{TRUE:sum('pro',active),FALSE:sum('con',active),UNKNOWN:0},totalWeight:sum('pro')+sum('con'),votes:active.map(b=>({id:b.messageId,vote:b.side==='pro'?'TRUE':'FALSE',amount:b.amount,createdAt:b.createdAt,user:userView(store,String(b.userId))})),_count:{votes:active.length},personalSettlement,distributionId:round.distributionId};
}
export function tagCounts(views:RecordData[]) {const counts:Record<string,Record<string,number>>={};for(const message of views){if(!['TAG','RECOMMEND','ARCHIVE'].includes(message.relationType))continue;for(const ref of message.targetRefs??[]){const id=ref.reference?.messageId??ref.messageId??ref.relationId;const value=counts[id]??={};const type=message.relationType;value[type]=(value[type]??0)+1;const subtype=message.payload?.subType??message.payload?.label;if(subtype)value[subtype]=(value[subtype]??0)+1;}}return counts;}
export function tagCountsFor(store:Store,ids:string[]) {
  const counts:Record<string,Record<string,number>>=Object.fromEntries(ids.map(id=>[id,{}])),sources=new Map<string,Message>();
  for(let i=0;i<ids.length;i+=200){const batch=ids.slice(i,i+200);if(!batch.length)continue;for(const row of store.db.prepare(`SELECT DISTINCT m.body FROM messages m JOIN refs r ON r.sourceId=m.id WHERE r.targetId IN (${batch.map(()=>'?').join(',')}) AND EXISTS (SELECT 1 FROM json_each(m.body,'$.parts') p WHERE json_extract(p.value,'$.relation') IN ('tag','recommend','archive','low-quality'))`).all(...batch)){const message=JSON.parse(String(row.body)) as Message;sources.set(message.id,message);}}
  for(const source of sources.values()){const type=legacyType(source);if(!type||!['TAG','RECOMMEND','ARCHIVE'].includes(type))continue;const data=dataOf(source),targets=new Set((primaryRelation(source)?.roles.target??[]).map(b=>b.reference.messageId));for(const id of targets){const value=counts[id];if(!value)continue;value[type]=(value[type]??0)+1;const sub=String(data.subType??data.label??'');if(sub)value[sub]=(value[sub]??0)+1;}}
  return counts;
}
export function attentionUsers(store:Store,ids?:string[]) {const rows=store.db.prepare("SELECT targetId,authorId FROM personal_marks WHERE family='follow' AND action='follow'").all(),allowed=ids?new Set(ids):null,result:Record<string,string[]>={};for(const row of rows){const id=String(row.targetId);if(!allowed||allowed.has(id))(result[id]??=[]).push(String(row.authorId));}return result;}
export function snapshot(store:Store,parent:string,query:RecordData,userId?:string) {
  const limit=Math.min(200,Math.max(1,Number(query.limit)||200)),after=Number(query.after??0);if(!Number.isSafeInteger(after)||after<0)throw new DomainError('变更游标无效');
  if(after){
    const changeRows=store.db.prepare('SELECT sequence,body FROM changes WHERE sequence>? ORDER BY sequence LIMIT 101').all(after),selected=changeRows.slice(0,100),changes=selected.map(r=>JSON.parse(String(r.body))),changedIds=[...new Set<string>(changes.flatMap(change=>[...change.messages.map((m:Message)=>m.id),...change.states.map((s:RecordData)=>s.messageId),...change.memberships.flatMap((m:RecordData)=>[m.memberId,m.parentId]),...change.removedMemberships]))];
    const scope=scopeSql(parent),messages:Message[]=[],present=new Set<string>();
    for(let i=0;i<changedIds.length;i+=200){const batch=changedIds.slice(i,i+200);if(!batch.length)continue;for(const row of store.db.prepare(`${scope.cte} SELECT m.body FROM messages m WHERE ${scope.predicate} AND m.id IN (${batch.map(()=>'?').join(',')})`).all(...scope.params,...batch)){const message=JSON.parse(String(row.body)) as Message;messages.push(message);present.add(message.id);}}
    const views=viewsFor(store,messages,parent),ids=messages.map(m=>m.id),marks=[];if(userId)for(let i=0;i<ids.length;i+=100)marks.push(...personalMarks(store,userId,ids.slice(i,i+100)));
    return {scope:scopeView(store,parent),messages:views,relations:views.filter(v=>v.relationType),users:allUsers(store),stakes:stakesFor(store,ids),tagCounts:tagCountsFor(store,ids),attentionUsers:attentionUsers(store,ids),personalStates:marks,sequence:selected.length?Number(selected.at(-1)!.sequence):after,hasMore:changeRows.length>100,nextCursor:null,removedMemberships:[...new Set(changes.flatMap(c=>c.removedMemberships))],removedMessageIds:changedIds.filter(id=>id!==parent&&!present.has(id))};
  }
  const scope=scopeSql(parent),params:(string|number)[]=[...scope.params],extra:string[]=[];
  if(after){extra.push('m.sequence>?');params.push(after);}
  if(query.cursor){let cursor:{sequence:number;id:string};try{cursor=JSON.parse(Buffer.from(String(query.cursor),'base64url').toString());}catch{throw new DomainError('分页游标无效');}if(!Number.isSafeInteger(cursor.sequence)||typeof cursor.id!=='string')throw new DomainError('分页游标无效');extra.push('(m.sequence<? OR (m.sequence=? AND m.id<?))');params.push(cursor.sequence,cursor.sequence,cursor.id);}
  const rows=store.db.prepare(`${scope.cte} SELECT m.body FROM messages m WHERE ${scope.predicate}${extra.length?' AND '+extra.join(' AND '):''} ORDER BY m.sequence DESC,m.id DESC LIMIT ?`).all(...params,limit+1),messages=rows.slice(0,limit).map(r=>JSON.parse(String(r.body)) as Message),last=messages.at(-1),views=viewsFor(store,messages,parent),ids=messages.map(m=>m.id);
  const removedMemberships:string[]=[],removedMessageIds:string[]=[];
  if(after){for(const row of store.db.prepare('SELECT body FROM changes WHERE sequence>?').all(after)){const change=JSON.parse(String(row.body));removedMemberships.push(...change.removedMemberships);if(parent!=='root')for(const membership of change.memberships)if(membership.parentId!==parent)removedMessageIds.push(membership.memberId);}}
  const marks=[];if(userId)for(let i=0;i<ids.length;i+=100)marks.push(...personalMarks(store,userId,ids.slice(i,i+100)));
  return {scope:scopeView(store,parent),messages:views,relations:views.filter(v=>v.relationType),users:allUsers(store),stakes:stakesFor(store,ids),tagCounts:tagCountsFor(store,ids),attentionUsers:attentionUsers(store,ids),personalStates:marks,sequence:store.latestSequence(),hasMore:false,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({sequence:last.sequence,id:last.id})).toString('base64url'):null,removedMemberships:[...new Set(removedMemberships)],removedMessageIds:[...new Set(removedMessageIds)]};
}
