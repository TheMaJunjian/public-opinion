import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { replayArchive, relations, type Message } from '@gonglun/core';
import { Postgres } from '../../server/src/postgres.js';
import { legacyTimestamp } from './legacy-time.js';
import { legacyOrganizationState } from './legacy-organizations.js';

const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const json=(value:unknown)=>JSON.stringify(canonical(value));
const digest=(value:unknown)=>createHash('sha256').update(json(value)).digest('hex');
if(!process.env.LEGACY_DATABASE_URL||!process.env.MIGRATION_TARGET_DATABASE_URL) throw new Error('需要显式源库和目标库连接');
const source=new Postgres(process.env.LEGACY_DATABASE_URL,process.env.LEGACY_DATABASE_SCHEMA);
const target=new Postgres(process.env.MIGRATION_TARGET_DATABASE_URL,process.env.MIGRATION_TARGET_SCHEMA);
const reportPath=process.argv[2];
if(!reportPath) throw new Error('需要报告路径');
try {
  const verification=await source.read(async()=>target.read(async()=>{
    await source.exec("SET LOCAL TIME ZONE 'UTC'");
    const originalTables=await source.prepare('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename').all(source.schema);
    let archivedRecords=0;
    for(const table of originalTables) {
      const name=String(table.tablename),quoted=`"${name.replaceAll('"','""')}"`;
      const original=await source.prepare(`SELECT row_to_json(t) AS body FROM ${quoted} t`).all();
      const expected=original.map(row=>row.body).sort((a,b)=>json(a).localeCompare(json(b)));
      const archived=await target.prepare('SELECT body,digest FROM legacy_records WHERE "tableName"=$1 ORDER BY position').all(name);
      if(expected.length!==archived.length) throw new Error(`归档行数不匹配: ${name}`);
      for(let index=0;index<expected.length;index++) {
        if(json(expected[index])!==json(archived[index].body)||digest(archived[index].body)!==archived[index].digest) throw new Error(`归档内容不匹配: ${name}/${index}`);
      }
      archivedRecords+=archived.length;
    }
    const oldUsers=await source.prepare('SELECT id,username,password FROM "User"').all();
    for(const user of oldUsers) {
      const actual=await target.prepare('SELECT id,name,password FROM users WHERE id=$1').get(user.id);
      if(!actual||actual.name!==user.username||actual.password!==user.password) throw new Error(`用户身份或密码哈希不匹配: ${user.id}`);
    }
    const accounts=await source.prepare('SELECT * FROM "PointAccount"').all();
    const migration=JSON.parse(String((await target.prepare("SELECT value FROM settings WHERE key='migration'").get())!.value));
    const changes=await target.prepare('SELECT body FROM changes ORDER BY sequence').all();
    const replay=replayArchive({format:'gonglun-2',changes:changes.map(row=>JSON.parse(String(row.body)))});
    for(const account of accounts) {
      const actual=await target.prepare('SELECT available,locked FROM accounts WHERE "userId"=$1').get(account.userId);
      const reconstructed=replay.accounts.get(String(account.userId));
      const adjustment=Number(migration.fundingAdjustments?.find((row:any)=>row.userId===account.userId)?.amount??0);
      if(!actual||!reconstructed||actual.available!==account.available-adjustment||actual.locked!==account.locked+adjustment||reconstructed.available!==actual.available||reconstructed.locked!==actual.locked||actual.available+actual.locked!==account.available+account.locked) throw new Error(`资金或账本重放不匹配: ${account.userId}`);
    }
    const oldMessages=(await source.prepare('SELECT row_to_json(t) AS body FROM "Message" t').all()).map(row=>row.body);
    const oldTopics=(await source.prepare('SELECT row_to_json(t) AS body FROM "Topic" t').all()).map(row=>row.body);
    const topicIds=new Set(oldTopics.map(row=>String(row.id)));
    const parents=new Map((await target.prepare('SELECT "memberId","parentId" FROM memberships').all()).map(row=>[String(row.memberId),String(row.parentId)]));
    for(const topic of oldTopics){
      const row=await target.prepare('SELECT body FROM messages WHERE id=$1').get(topic.id),converted=row?JSON.parse(String(row.body)) as Message:undefined;
      const body=converted?.parts.find(part=>part.id==='body'),data=converted?.parts.find(part=>part.type==='data');
      const meta=data?.type==='data'?data.value as Record<string,any>:undefined;
      if(body?.type!=='text'||body.text!==topic.id||meta?.title!==topic.id||meta?.origin?.kind!=='topic-classification'||meta?.origin?.id!==topic.id||!converted?.parts.some(part=>part.type==='relation'&&part.relation==='classify')) throw new Error(`Topic 分类内容或原元数据不一致: ${topic.id}`);
    }
    for(const message of oldMessages) {
      const actual=await target.prepare('SELECT body FROM messages WHERE id=$1').get(message.id);
      const converted=actual?JSON.parse(String(actual.body)) as Message:undefined;
      const part=converted?.parts.find(part=>part.id==='body');
      const text=part?.type==='text'?part.text:part?.type==='code'?part.source:undefined;
      if(!converted||text!==String(message.content??'')) throw new Error(`消息正文不匹配: ${message.id}`);
      if(converted.createdAt!==legacyTimestamp(message.createdAt)||converted.updatedAt!==legacyTimestamp(message.updatedAt)) throw new Error(`消息时间不匹配: ${message.id}`);
      const data=converted.parts.find(part=>part.type==='data'),meta=data?.type==='data'?data.value as Record<string,any>:undefined;
      const original=await target.prepare('SELECT body FROM legacy_records WHERE \"tableName\"=$1 AND body->>\'id\'=$2').get('Message',message.id);
      if(json(original?.body?.targetRefs??[])!==json(message.targetRefs??[])) throw new Error(`原始容器/关系引用不匹配: ${message.id}`);
      if(['ROUND','ROUND_RESULT'].includes(message.kind)&&(message.targetRefs??[]).length){
        const expected=[...new Set(message.targetRefs.map((ref:any)=>ref.reference?.messageId??ref.messageId??ref.relationId))].sort();
        const actual=[...new Set(relations(converted).flatMap(part=>(part.roles.target??[]).map(binding=>binding.reference.messageId)))].sort();
        if(json(expected)!==json(actual))throw new Error(`结算原生目标引用不匹配: ${message.id}`);
      }
      let parent=parents.get(String(message.id));const visited=new Set<string>([message.id]);
      while(parent&&!topicIds.has(parent)){
        if(visited.has(parent)) throw new Error(`容器归属循环: ${message.id}`);
        visited.add(parent);parent=parents.get(parent);
      }
      if(parent!==message.topicId) throw new Error(`消息的原 Topic 边界已改变: ${message.id}`);
    }
    const structured:Record<string,number>={};
    if(migration.activeStatePreserved) {
      for(const [originalTable,targetTable] of [['Stake','legacy_stakes'],['VoteStake','legacy_votes'],['BetPool','legacy_pools'],['Balance','legacy_accounts']]) {
        const original=await source.prepare(`SELECT row_to_json(t) AS body FROM "${originalTable}" t`).all();
        const converted=await target.prepare(`SELECT * FROM ${targetTable}`).all();
        if(original.length!==converted.length) throw new Error(`结构化记录数量不一致: ${originalTable}`);
        const key=(row:any)=>originalTable==='BetPool'?JSON.stringify([row.messageId,row.settlementType]):originalTable==='Balance'?row.userId:row.id;
        const byId=new Map(converted.map(row=>[key(row),row]));
        for(const row of original) {
          const actual=byId.get(key(row.body));
          if(!actual||json(actual.body)!==json(row.body)) throw new Error(`结构化原文不一致: ${originalTable}`);
          for(const field of originalTable==='Stake'?['id','userId','messageId','roundId','settlementType','side','amount']:originalTable==='BetPool'?['messageId','settlementType','lockedPro','lockedCon']:originalTable==='VoteStake'?['id','roundId','userId','vote','amount']:['userId']) {
            if(actual[field]!==row.body[field]) throw new Error(`结构化字段不一致: ${originalTable}/${field}`);
          }
        }
        structured[originalTable]=converted.length;
      }
      const sourceRounds=(await source.prepare('SELECT row_to_json(t) AS body FROM "SettlementRound" t').all()).map(row=>row.body);
      for(const row of sourceRounds) {
        const converted=await target.prepare('SELECT body FROM rounds WHERE id=$1').get(row.id);
        const actual=converted?JSON.parse(String(converted.body)):undefined;
        const report=(await target.prepare('SELECT body FROM published_round_reports WHERE id=$1').get(row.id))?.body;
        if(!actual||(!report&&actual.status!=='open')||(report&&report.status!==row.status)||actual.previousRoundId!==row.previousRoundId||actual.createdAt!==legacyTimestamp(row.openedAt)||actual.endsAt!==(row.closedAt?legacyTimestamp(row.closedAt):null)) throw new Error(`轮次生命周期不一致: ${row.id}`);
      }
      structured.SettlementRound=sourceRounds.length;
      if(migration.mode==='native-rehearsal') {
        const active=sourceRounds.filter(row=>['OPEN','VOTING'].includes(row.status));
        const stakes=await source.prepare('SELECT * FROM "Stake"').all(),votes=await source.prepare('SELECT * FROM "VoteStake"').all();
        let principal=0;
        for(const round of active) {
          const body=JSON.parse(String((await target.prepare('SELECT body FROM rounds WHERE id=$1').get(round.id))!.body));
          if(body.status!=='open'||typeof body.targetKey!=='string'||body.target.messageId!==round.messageId||(round.settlementType==='VALUE'&&body.target.partId!=='body')) throw new Error(`活动轮次执行边界不一致: ${round.id}`);
          const expected:Record<string,any>[]=[...stakes.filter(row=>row.roundId===round.id).map(row=>({...row,side:row.side==='PRO'?'pro':'con'})),...votes.filter(row=>row.roundId===round.id).map(row=>({...row,messageId:round.messageId,side:row.vote==='TRUE'?'pro':'con'}))];
          const actual=await target.prepare('SELECT * FROM bets WHERE "roundId"=$1').all(round.id);
          if(expected.length!==actual.length) throw new Error(`活动本金记录数量不一致: ${round.id}`);
          for(const stake of expected) {
            const bet=actual.find(row=>row.id===stake.id);
            if(!bet||['userId','messageId','side','amount'].some(key=>bet[key]!==stake[key])) throw new Error(`活动本金执行记录不一致: ${stake.id}`);
            principal+=stake.amount;
          }
        }
        const pools=await source.prepare('SELECT * FROM "BetPool" WHERE "settlementType"=\'DELEGATION\' AND "lockedPro"+"lockedCon">0').all();
        for(const pool of pools) {
          const task=oldMessages.find(row=>row.id===pool.messageId),escrow=await target.prepare('SELECT * FROM escrows WHERE "messageId"=$1').get(pool.messageId);
          const owners=[...new Set(stakes.filter(row=>row.messageId===pool.messageId&&row.settlementType==='DELEGATION').map(row=>row.userId))];
          if(!escrow||escrow.amount!==task?.relationPayload?.rewardAmount||escrow.ownerId!==owners[0]||escrow.recipientId!==null||escrow.fulfillmentId!==null) throw new Error(`委托奖励未完整保留: ${pool.messageId}`);
        }
        structured.nativeActiveRounds=active.length;structured.nativeActivePrincipal=principal;structured.nativeDelegations=pools.length;
      }
      const rawUsers=(await source.prepare('SELECT row_to_json(t) AS body FROM "User" t').all()).map(row=>row.body);
      for(const user of rawUsers) {
        const converted=await target.prepare('SELECT "createdAt" FROM users WHERE id=$1').get(user.id);
        if(converted?.createdAt!==legacyTimestamp(user.createdAt)) throw new Error(`用户时间不一致: ${user.id}`);
      }
      const organizations=legacyOrganizationState(oldMessages,rawUsers);
      const imported=await target.prepare('SELECT "messageId",body FROM legacy_organization_states').all();
      for(const row of imported) {
        if(!!row.body.rejected!==organizations.rejected.has(String(row.messageId))||!!row.body.effectiveJoin!==organizations.effectiveJoins.has(String(row.messageId))||Number(row.body.agreeCount??0)!==Number(organizations.stats[String(row.messageId)]?.agreeCount??0)||Number(row.body.disagreeCount??0)!==Number(organizations.stats[String(row.messageId)]?.disagreeCount??0)) throw new Error(`组织执行状态不一致: ${row.messageId}`);
      }
      structured.organizationStates=imported.length;
      structured.effectiveJoins=organizations.effectiveJoins.size;
    }
    if(!['read-only-rehearsal','native-rehearsal'].includes(migration.mode)) throw new Error('目标不是明确的隔离演练库');
    const sourceAvailable=accounts.reduce((total,row)=>total+row.available,0),sourceLocked=accounts.reduce((total,row)=>total+row.locked,0),transferred=(migration.fundingAdjustments??[]).reduce((sum:number,row:any)=>sum+row.amount,0);
    return {verified:true,mode:migration.mode,archivedRecords,users:oldUsers.length,topics:oldTopics.length,messages:oldMessages.length,accounts:accounts.length,sourceAvailable,sourceLocked,available:sourceAvailable-transferred,locked:sourceLocked+transferred,transferredToLocked:transferred,remainingFundingDifference:(migration.fundingAdjustments??[]).reduce((sum:number,row:any)=>sum+row.remaining,0),changes:changes.length,accountTotalUnchanged:true,accountAndReplayMatch:true,archiveContentAndDigestMatch:true,userAndPasswordHashMatch:true,messageBodyMatch:true,topicClassificationContentMatch:true,originalReferencesMatch:true,topicBoundariesMatch:true,structured,blockers:migration.blockers.length,readyForProduction:false};
  }));
  writeFileSync(reportPath,JSON.stringify(verification,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(verification,null,2));
} finally {await Promise.all([source.close(),target.close()]);}
