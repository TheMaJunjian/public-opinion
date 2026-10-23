import { createHash } from 'node:crypto';
import { bindRoles, DEFAULT_RULES, referenceKey, replayArchive, resolveReference, resolveStance, type Json, type Membership, type Message, type Part, type Reference, type Rules } from '@gonglun/core';
import { integer, Mutation, Store } from '../../server/src/db.js';
import { Postgres } from '../../server/src/postgres.js';
import { recordPersonal } from '../../server/src/personal-actions.js';
import { recordStance } from '../../server/src/projections.js';
import { rulesSchema, partsSchema, validateReferences } from '../../server/src/validation.js';
import { legacyOrganizationState } from './legacy-organizations.js';
import { legacyTimestamp as timestamp } from './legacy-time.js';
import { openMigratingStore } from './migrations.js';
import {initializeMigrationArchive} from './migration-schema.js';
import { migrateAnnotationReasons, upgradeAnnotationRecords } from './migrate-annotation-reasons.js';
import {migrateQueryRecords} from './migrate-query-records.js';

type Row = Record<string, any>;
type Snapshot = Record<string, Row[]>;
export interface MigrationOptions {
  sourceUrl: string; sourceSchema?: string;
  targetUrl?: string; targetSchema?: string;
  founderId: string; rules?: Rules; apply?: boolean; readOnlyRehearsal?: boolean; preserveActiveState?:boolean; lockAvailable?:boolean; nativeRehearsal?:boolean; nativeImport?:boolean;
}
export interface MigrationReport {
  format: 'gonglun-prisma-migration-1'; sourceDigest: string;
  sourceTables: Record<string, number>; blockers: string[]; notes: string[];
  users: number; topics: number; messages: number; available: number; operating: number;
  applied: boolean; mode?: 'read-only-rehearsal'|'native-rehearsal';
  activeStatePreserved?:boolean;
  financialAudit?:{accountLocked:number;poolExposure:number;activePrincipal:number;fundingGap:number;differences:Array<{userId:string;locked:number;activePrincipal:number;difference:number}>};
  fundingAdjustments?:{userId:string;amount:number;remaining:number}[];
}
const quote = (name: string) => `"${name.replaceAll('"','""')}"`;
const canonical = (value: any): any => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sorted = (rows: Row[]) => [...rows].sort((a,b)=>String(a.createdAt??a.openedAt??'').localeCompare(String(b.createdAt??b.openedAt??''))||String(a.id??a.userId).localeCompare(String(b.id??b.userId)));
const relationNames: Record<string,string> = {ATTENTION:'follow',CORRECT:'amend',JOIN:'member-of',PROPOSAL:'proposal',CODE_CHANGE:'code-change',DELEGATION:'legacy-delegation',OPERATIONS:'operations'};

/** A read-only consistent source snapshot. No legacy business actions are replayed. */
export async function migrateLegacy(options: MigrationOptions): Promise<MigrationReport> {
  const source = new Postgres(options.sourceUrl,options.sourceSchema);
  let snapshot: Snapshot;
  try {
    snapshot = await source.read(async()=>{
      await source.exec("SET LOCAL TIME ZONE 'UTC'");
      const tables = await source.prepare('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename').all(source.schema);
      const data: Snapshot = Object.create(null);
      for(const table of tables) {
        const rows = await source.prepare(`SELECT row_to_json(t) AS body FROM ${quote(source.schema)}.${quote(String(table.tablename))} t`).all();
        data[String(table.tablename)] = rows.map(row=>row.body).sort((a,b)=>JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
      }
      return data;
    });
  } finally { await source.close(); }
  const get = (table:string) => snapshot[table]??[];
  const report: MigrationReport = {
    format:'gonglun-prisma-migration-1',sourceDigest:digest(snapshot),sourceTables:Object.fromEntries(Object.entries(snapshot).map(([table,rows])=>[table,rows.length])),
    blockers:[],notes:[
      '旧版全部表原文归档到私有 legacy_records；旧审计和签名不伪装为新版签名。',
      '迁移是余额检查点，不重新执行旧流水，不发放 initialGrant；新版 earned/spent 从检查点开始，旧统计在原文归档中保留。',
      '新版执行显式提供的 rules 或 DEFAULT_RULES；旧规则原文永久归档，不能按新版规则重放旧操作。',
      '已结算旧轮次保留历史展示，禁止跨迁移边界翻案或对旧资金目标再次下注；新消息使用新版结算。',
      'JWT 会话不导入；bcrypt 密码继续可登录，设备公钥保留。',
    ],users:get('User').length,topics:get('Topic').length,messages:get('Message').length,available:0,operating:0,applied:false,
  };
  for(const table of ['User','Topic','Message','Balance','PointAccount','SettlementRound','Stake','VoteStake','RevenuePool','LedgerEntry','RuleVersion','UserSigningKey','AuditLog']) {
    if(!(table in snapshot)) report.blockers.push(`缺少生产基线表 ${table}，请确认源库为 a5216ca 的完整备份`);
  }
  const users = sorted(get('User')), topics=sorted(get('Topic')), oldMessages=sorted(get('Message'));
  const names = new Set<string>(), ids = new Set<string>();
  for(const row of [...users,...topics,...oldMessages]) {
    if(typeof row.id!=='string'||!row.id||row.id.length>100||ids.has(row.id)||['system','root'].includes(row.id)||row.id.startsWith('migration:')) report.blockers.push(`身份冲突或不支持的 ID: ${row.id}`);
    ids.add(row.id);
  }
  for(const user of users) {
    const folded=String(user.username).toLowerCase();
    if(names.has(folded)||typeof user.username!=='string'||user.username.length<2||user.username.length>40) report.blockers.push(`用户名冲突或不兼容: ${user.id}`);
    names.add(folded);
    if(!/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(user.password??'')) report.blockers.push(`不支持的密码哈希: ${user.id}`);
  }
  if(!users.some(row=>row.id===options.founderId)) report.blockers.push('必须指定存在的旧用户 ID 作为新版 founderId');
  const accountById=new Map(get('PointAccount').map(row=>[row.userId,row]));
  const balanceById=new Map(get('Balance').map(row=>[row.userId,row]));
  for(const user of users) {
    const account=accountById.get(user.id), balance=balanceById.get(user.id);
    if(!account||!balance) {report.blockers.push(`账户记录缺失: ${user.id}`);continue;}
    if(!Number.isSafeInteger(account.available)||!Number.isSafeInteger(account.locked)||account.available!==balance.balance) report.blockers.push(`Balance/PointAccount 对账失败: ${user.id}`);
    if(account.locked!==0&&!options.preserveActiveState) report.blockers.push(`存在锁定资金，须在旧版完成结算或解锁: ${user.id} locked=${account.locked}`);
    if(Boolean(balance.debtFrozen)!==(balance.balance<0)) report.blockers.push(`负债冻结状态异常: ${user.id}`);
    report.available=integer(report.available+(Number.isSafeInteger(account.available)?account.available:0));
  }
  for(const round of get('SettlementRound')) if(!['SETTLED','CANCELLED','EFFECTED'].includes(round.status)&&!options.preserveActiveState) report.blockers.push(`旧版进行中轮次尚不可无损转换: ${round.id} status=${round.status}`);
  for(const pool of get('BetPool')) if((pool.lockedPro!==0||pool.lockedCon!==0)&&!options.preserveActiveState) report.blockers.push(`旧版押注池未清零: ${pool.messageId}/${pool.settlementType}`);
  for(const pool of get('RevenuePool')) {
    if(!Number.isSafeInteger(pool.balance)||pool.balance<0) report.blockers.push(`运营池余额无效: ${pool.id}`);
    else report.operating=integer(report.operating+pool.balance);
  }
  const rules=rulesSchema.parse(options.rules??DEFAULT_RULES) as Rules;
  const messageIds=new Set([...topics,...oldMessages].map(row=>row.id));
  const userIds=new Set(users.map(row=>row.id));
  for(const row of [...topics,...oldMessages]) if(!userIds.has(row.createdById)) report.blockers.push(`作者缺失: ${row.id}`);
  for(const row of oldMessages) if(!topics.some(topic=>topic.id===row.topicId)) report.blockers.push(`话题缺失: ${row.id}`);
  const converted = new Map<string,Message>();
  function convertRef(raw: Row): Reference {
    if(!raw||typeof raw!=='object') throw new Error('旧引用不是对象');
    const id=raw.messageId??raw.relationId;
    if(typeof id!=='string'||!messageIds.has(id)) throw new Error(`旧引用目标不存在: ${id}`);
    if(raw.kind==='text-fragment') {
      const row=oldMessages.find(message=>message.id===id);
      const body=String(row?.content??''), text=String(raw.text??'');
      const start=body.indexOf(text);
      if(!text||start<0||body.indexOf(text,start+1)>=0) throw new Error(`片段无法唯一定位: ${id}`);
      return {messageId:id,revision:1,partId:'body',range:{start,end:start+text.length}};
    }
    if(raw.kind==='relation'&&raw.part&&raw.part!=='whole') {
      if(!['label','decoration'].includes(raw.part)) throw new Error(`未知关系部件: ${raw.part}`);
      return {messageId:id,partId:raw.part==='label'?'body':'relation'};
    }
    if(raw.kind&&!['message','relation'].includes(raw.kind)) throw new Error(`不支持的旧引用类型: ${raw.kind}`);
    return {messageId:id};
  }
  function make(row:Row,parts:Part[]): Message {
    const message:Message=upgradeAnnotationRecords({id:row.id,revision:1,authorId:row.createdById,createdAt:timestamp(row.createdAt),updatedAt:timestamp(row.updatedAt??row.createdAt),regionId:'pending',ledgerId:'local',programVersion:'2.0.0',ruleVersion:rules.version,parts,spending:{protocol:0,recommendation:0,wager:0},sequence:0});
    partsSchema.parse(message.parts);
    return message;
  }
  for(const row of topics) try {
    converted.set(row.id,make(row,[{id:'body',type:'text',text:row.id},{id:'relation',type:'relation',relation:'classify',roles:{}},{id:'data',type:'data',value:{kind:'RELATION',uiType:'CLASSIFY',title:row.id,legacyTopicId:row.id,legacyTopicStatus:row.status,legacyTitle:row.title,legacyBody:row.body??null}}]));
  } catch(error) {report.blockers.push(`话题 ${row.id}: ${(error as Error).message}`);}
  for(const row of oldMessages) try {
    const payload=(row.relationPayload??{}) as Row;
    const references=(row.targetRefs??[]).map(convertRef);
    const parts:Part[]=[{id:'body',type:row.kind==='CODE'?'code':'text',...(row.kind==='CODE'?{language:'text',source:String(row.content??'')}:{text:String(row.content??'')})} as Part];
    if(row.relationType) {
      let name=relationNames[row.relationType]??String(row.relationType).toLowerCase();
      if(name==='follow'&&payload.action==='unfollow') name='unfollow';
      if((options.nativeRehearsal||options.nativeImport)&&row.relationType==='DELEGATION') name=payload.delegationKind==='FULFILL'?'fulfill':'delegate';
      const roles:Record<string,Reference[]>=['CLASSIFY','MERGE','SUMMARY','ARRANGE'].includes(row.relationType)?{members:references}:{target:references};
      if(row.relSourceId) { if(!messageIds.has(row.relSourceId)) throw new Error('关系源消息不存在'); roles.source=[{messageId:row.relSourceId}]; }
      // Preserve the original JOIN record and its source/targets for display;
      // native ownership is reconstructed separately below.
      if(row.relationType==='JOIN') name='legacy-join';
      if(row.supersededBy&&!messageIds.has(row.supersededBy)) throw new Error('替换消息不存在');
      parts.push({id:'relation',type:'relation',relation:name,roles:bindRoles(roles)});
      if(['CLASSIFY','MERGE','SUMMARY','ARRANGE'].includes(row.relationType)) {
        parts.push({id:'display',type:'display',relationPartId:'relation',layout:payload.targetLayout==='single-row'?'row':payload.targetLayout==='multi-column'?'columns':'flow'});
      }
    }
    parts.push({id:'data',type:'data',value:{...payload,kind:row.kind,uiType:row.relationType??null,contentType:row.contentType??'TEXT',legacyTopicId:row.topicId,legacyTargetRefs:row.targetRefs??[],legacySupersededBy:row.supersededBy??null,legacyQuote:{sourceId:row.quoteSourceId??null,text:row.quotedText??null,hash:row.quotedTextHash??null,before:row.quoteContextBefore??null,after:row.quoteContextAfter??null}} as Json});
    parts.push({id:'placement',type:'relation',relation:'member-of',roles:bindRoles({parent:[{messageId:row.topicId}]})});
    converted.set(row.id,make(row,parts));
  } catch(error) {report.blockers.push(`消息 ${row.id}: ${(error as Error).message}`);}
  const membershipById=new Map<string,Membership>();
  const organizationState=legacyOrganizationState(oldMessages,users);
  for(const row of oldMessages) membershipById.set(row.id,{memberId:row.id,parentId:row.topicId,sourceId:row.id,sourcePartId:'placement',sourceRevision:1});
  const groups=new Set(oldMessages.filter(row=>['CLASSIFY','MERGE','SUMMARY','ARRANGE'].includes(row.relationType)&&!row.supersededBy).map(row=>row.id));
  const joins=new Map<string,Row>();
  const joinedMembers=new Set(oldMessages.filter(row=>row.relationType==='JOIN'&&!row.supersededBy).flatMap(row=>(row.targetRefs??[]).map((ref:Row)=>ref.messageId??ref.relationId)));
  for(const row of oldMessages) if(row.relationType==='JOIN'&&!row.supersededBy) {
    if(!groups.has(row.relSourceId)) {report.blockers.push(`JOIN 父容器无效: ${row.id}`);continue;}
    if(options.preserveActiveState&&!organizationState.effectiveJoins.has(row.id)) continue;
    for(const raw of row.targetRefs??[]) try {
      const ref=convertRef(raw);
      if(ref.partId||ref.range) {report.blockers.push(`新版组织不支持片段成员: ${row.id}`);continue;}
      joins.set(ref.messageId,row);
    } catch(error) {report.blockers.push(`JOIN ${row.id}: ${(error as Error).message}`);}
  }
  const candidateParents=new Map<string,Set<string>>();
  for(const row of oldMessages) if(groups.has(row.id)&&!(options.preserveActiveState&&organizationState.rejected.has(row.id))) for(const raw of row.targetRefs??[]) try {
    const ref=convertRef(raw);
    if(ref.partId||ref.range) {report.blockers.push(`新版组织不支持片段成员: ${row.id}`);continue;}
    (candidateParents.get(ref.messageId)??(candidateParents.set(ref.messageId,new Set()),candidateParents.get(ref.messageId)!)).add(row.id);
  } catch(error) {report.blockers.push(`组织 ${row.id}: ${(error as Error).message}`);}
  for(const [memberId,parents] of candidateParents) {
    if(joins.has(memberId)||(options.preserveActiveState&&joinedMembers.has(memberId))) continue;
    if(parents.size!==1) {report.blockers.push(`旧成员同时属于多个组织，需明确归属: ${memberId}`);continue;}
    const parentId=[...parents][0];
    membershipById.set(memberId,{memberId,parentId,sourceId:parentId,sourcePartId:'relation',sourceRevision:1});
  }
  for(const [memberId,row] of joins) membershipById.set(memberId,{memberId,parentId:row.relSourceId,sourceId:row.id,sourcePartId:'relation',sourceRevision:1});
  for(const membership of membershipById.values()) {
    let current:string|undefined=membership.parentId;
    const visited=new Set([membership.memberId]);
    while(current) {
      if(visited.has(current)) {report.blockers.push(`组织归属循环: ${membership.memberId}`);break;}
      visited.add(current);current=membershipById.get(current)?.parentId;
    }
  }
  for(const row of oldMessages) if(!options.preserveActiveState&&!row.supersededBy&&['AGREE','DISAGREE'].includes(row.relationType)) for(const raw of row.targetRefs??[]) {
    const target=raw.messageId??raw.relationId;
    if(groups.has(target)||oldMessages.some(message=>message.id===target&&message.relationType==='JOIN')) report.blockers.push(`组织含赞同/否定执行状态，需专项归属转换: ${row.id}`);
  }
  for(const message of converted.values()) {
    for(const part of message.parts) if(part.type==='relation') for(const binding of Object.values(part.roles).flat()) {
      if(resolveReference(binding.reference,id=>converted.get(id))===undefined) report.blockers.push(`无法解析迁移引用: ${message.id}/${part.id}`);
    }
  }
  for(const round of get('SettlementRound')) {
    if(!messageIds.has(round.messageId)||!userIds.has(round.createdByUserId)) report.blockers.push(`轮次引用缺失: ${round.id}`);
    if(ids.has(round.id)) report.blockers.push(`轮次 ID 冲突: ${round.id}`);
  }
  for(const key of get('UserSigningKey')) if(!userIds.has(key.userId)) report.blockers.push(`签名设备用户缺失: ${key.id}`);
  if(options.preserveActiveState) {
    report.activeStatePreserved=true;
    const activeRounds=new Set(get('SettlementRound').filter(row=>['OPEN','VOTING'].includes(row.status)).map(row=>row.id));
    const principals=new Map<string,number>();
    for(const row of get('Stake')) if(activeRounds.has(row.roundId)||row.settlementType==='DELEGATION') principals.set(row.userId,integer((principals.get(row.userId)??0)+row.amount));
    for(const row of get('VoteStake')) if(activeRounds.has(row.roundId)) principals.set(row.userId,integer((principals.get(row.userId)??0)+row.amount));
    const differences=users.map(row=>({userId:row.id,locked:accountById.get(row.id)?.locked??0,activePrincipal:principals.get(row.id)??0,difference:integer((principals.get(row.id)??0)-(accountById.get(row.id)?.locked??0))})).filter(row=>row.difference!==0);
    report.financialAudit={accountLocked:users.reduce((sum,row)=>integer(sum+(accountById.get(row.id)?.locked??0)),0),poolExposure:get('BetPool').reduce((sum,row)=>integer(sum+row.lockedPro+row.lockedCon),0),activePrincipal:[...principals.values()].reduce((sum,amount)=>integer(sum+amount),0),fundingGap:differences.reduce((sum,row)=>integer(sum+row.difference),0),differences};
    if(options.lockAvailable) {
      report.fundingAdjustments=differences.filter(row=>row.difference>0).map(row=>{const amount=Math.min(Math.max(0,accountById.get(row.userId)?.available??0),row.difference);return {userId:row.userId,amount,remaining:row.difference-amount};});
      report.notes.push('按用户授权对虚拟贡献点尽量补锁：仅从可用余额转入锁定额，账户总额和 minted 不变；余额不足则保留剩余差异，不增发、不借款、不清零、不强制结算。');
    } else for(const row of differences) report.blockers.push(`旧合同活动本金与账户锁定额差异: ${row.userId} locked=${row.locked} principal=${row.activePrincipal} difference=${row.difference}`);
    if(!options.readOnlyRehearsal&&!options.nativeImport) report.blockers.push('活跃状态保真迁移必须显式启用只读演练，直到旧资金合同的执行兼容性通过验收');
    report.notes.push('活跃状态结构化迁移：保留原 Stake、VoteStake、BetPool、锁定额、投票中轮次及组织状态，不清零、不结算、不改变旧合同。');
  }
  if(options.nativeImport&&(!options.preserveActiveState||options.lockAvailable||report.financialAudit?.differences.length))
    report.blockers.push('自动迁移要求旧本金与锁定余额完全一致，不能自动补锁或调整资金');
  if(options.nativeRehearsal) {
    if(!options.preserveActiveState||!options.lockAvailable||!options.readOnlyRehearsal) report.blockers.push('可操作隔离演练必须同时显式保留活跃状态并按可用余额补锁');
    if(report.fundingAdjustments?.some(row=>row.remaining>0)) report.blockers.push('存在未覆盖本金，保持只读，不接通对应轮次的资金执行');
    report.notes.push('当前已补锁轮次接入新版结算：仅导入活动本金，已完成旧轮次不重放、不追溯收回旧分配；历史累计权重保留在兼容索引和原文。未来操作采用新版规则。');
  }
  if(!options.apply) return report;
  if(options.readOnlyRehearsal) {
    report.mode=options.nativeRehearsal?'native-rehearsal':'read-only-rehearsal';
    report.notes.push(options.nativeRehearsal?'隔离可操作演练：原投票轮次保持开启，不自动结算；正式切换仍需停写后的最终备份和验收。':'只读真实数据演练：保留源账户锁定额及进行中轮次原文；禁用业务写入和自动结算，不能上线。');
    const inspectable=['存在锁定资金','旧版进行中轮次','旧版押注池未清零','组织含赞同/否定执行状态','旧合同活动本金与账户锁定额差异'];
    if(report.blockers.some(blocker=>!inspectable.some(prefix=>blocker.startsWith(prefix)))) return report;
  } else if(report.blockers.length) return report;
  if(!options.targetUrl) throw new Error('应用迁移必须提供独立 targetUrl');
  // Check physical identity as well as URLs: differently spelled URLs can point to one database.
  const probeSource=new Postgres(options.sourceUrl,options.sourceSchema), probeTarget=new Postgres(options.targetUrl,options.targetSchema);
  try {
    const sql='SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port';
    const [left,right]=await Promise.all([probeSource.prepare(sql).get(),probeTarget.prepare(sql).get()]);
    if(JSON.stringify(left)===JSON.stringify(right)&&probeSource.schema===probeTarget.schema) throw new Error('源库与目标库相同，拒绝迁移');
    const tables=await probeTarget.prepare('SELECT COUNT(*)::integer AS n FROM pg_tables WHERE schemaname=$1').get(probeTarget.schema);
    if(tables?.n) throw new Error('目标 schema 必须为空；每次演练使用新的独立数据库/schema');
  } finally {await probeSource.close();await probeTarget.close();}
  const store=await openMigratingStore(options.targetUrl,{schema:options.targetSchema});
  try {
    await store.transaction(async()=>{
      await initializeMigrationArchive(store);
      if((await store.db.prepare('SELECT COUNT(*)::integer AS n FROM users').get())!.n||(await store.latestSequence())) throw new Error('目标已存在业务数据');
      await store.db.exec('CREATE TABLE legacy_records ("tableName" TEXT NOT NULL, position INTEGER NOT NULL, digest TEXT NOT NULL, body JSONB NOT NULL, PRIMARY KEY("tableName",position))');
      for(const [table,rows] of Object.entries(snapshot)) for(let position=0;position<rows.length;position++) await store.db.prepare('INSERT INTO legacy_records VALUES ($1,$2,$3,$4::jsonb)').run(table,position,digest(rows[position]),JSON.stringify(rows[position]));
      if(options.preserveActiveState) {
        for(const row of get('Stake')) await store.db.prepare('INSERT INTO legacy_stakes VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)').run(row.id,row.userId,row.messageId,row.roundId??null,row.settlementType,row.side,integer(row.amount),timestamp(row.createdAt),JSON.stringify(row));
        for(const row of get('VoteStake')) await store.db.prepare('INSERT INTO legacy_votes VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)').run(row.id,row.roundId,row.userId,row.vote,integer(row.amount),timestamp(row.createdAt),JSON.stringify(row));
        for(const row of get('BetPool')) await store.db.prepare('INSERT INTO legacy_pools VALUES ($1,$2,$3,$4,$5::jsonb)').run(row.messageId,row.settlementType,integer(row.lockedPro),integer(row.lockedCon),JSON.stringify(row));
        for(const row of get('Balance')) await store.db.prepare('INSERT INTO legacy_accounts VALUES ($1,$2::jsonb)').run(row.userId,JSON.stringify(row));
        for(const row of oldMessages.filter(row=>groups.has(row.id)||row.relationType==='JOIN')) {
          await store.db.prepare('INSERT INTO legacy_organization_states VALUES ($1,$2::jsonb)').run(row.id,JSON.stringify({...organizationState.stats[row.id],rejected:organizationState.rejected.has(row.id),effectiveJoin:organizationState.effectiveJoins.has(row.id)}));
        }
      }
      await store.set('rules',rules);
      await store.db.prepare('INSERT INTO rule_versions VALUES ($1,$2,NULL,$3) ON CONFLICT(version) DO UPDATE SET body=excluded.body').run(rules.version,JSON.stringify(rules),new Date().toISOString());
      for(const user of users) {
        await store.db.prepare('INSERT INTO users(id,name,password,founder) VALUES ($1,$2,$3,$4)').run(user.id,user.username,user.password,user.id===options.founderId?1:0);
        await store.db.prepare('INSERT INTO accounts VALUES ($1,0,0,0,0)').run(user.id);
        await store.db.prepare('INSERT INTO legacy_users VALUES ($1,$2)').run(user.id,timestamp(user.createdAt));
      }
      for(const key of get('UserSigningKey')) await store.db.prepare('INSERT INTO signing_keys VALUES ($1,$2,$3,$4)').run(key.userId,key.deviceId,key.publicKey,timestamp(key.createdAt));
      for(const user of users) if(user.publicKey&&!get('UserSigningKey').some(key=>key.userId===user.id)) await store.db.prepare('INSERT INTO signing_keys VALUES ($1,$2,$3,$4)').run(user.id,`legacy:${user.username}`,user.publicKey,timestamp(user.createdAt));
      const tx=new Mutation(store),regionId=await store.setting<string>('region');
      for(const message of converted.values()) {message.regionId=regionId;await tx.put(message);}
      for(const message of converted.values()) {
        await validateReferences(store,message.parts);
        const membership=membershipById.get(message.id);
        if(membership) {
          await store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId","sourcePartId","sourceRevision") VALUES ($1,$2,$3,$4,$5)').run(membership.memberId,membership.parentId,membership.sourceId,membership.sourcePartId,1);
          tx.memberships.set(message.id,membership);
        }
      }
      await tx.commit();
      // Each imported statement gets a real change cursor, so subsequent live
      // statements always supersede it. Never invent projection-only cursors.
      for(const message of converted.values()) {
        const projectionTx=new Mutation(store);
        message.sequence=(await store.latestSequence())+1;
        await projectionTx.put(message);
        const old=oldMessages.find(row=>row.id===message.id);
        if(!old?.supersededBy) await recordPersonal(store,message);
        for(const part of message.parts) if(!old?.supersededBy&&part.type==='relation'&&['agree','disagree'].includes(part.relation)&&part.roles.target?.length===1) {
          const resolved=resolveStance(part.roles.target[0].reference,part.relation==='agree'?'pro':'con',id=>converted.get(id));
          const target={...resolved.target,revision:1};
          await store.db.prepare('INSERT INTO execution_stances VALUES ($1,1,$2,$3,$4)').run(message.id,part.id,JSON.stringify(target),resolved.side);
          await recordStance(store,message,{target,side:resolved.side});
        }
        await projectionTx.commit();
      }
      // Historical source records remain immutable; checkpoint ledger begins here.
      const checkpointTx=new Mutation(store);
      const checkpoint=await checkpointTx.create('system',[{id:'body',type:'text',text:'旧版数据迁移余额检查点'},{id:'data',type:'data',value:{migrationFormat:report.format,sourceDigest:report.sourceDigest,legacyHistory:true}}],undefined,`migration:${report.sourceDigest.slice(0,32)}`);
      for(const user of users) await store.ledger(user.id,checkpoint.id,accountById.get(user.id)!.available,options.readOnlyRehearsal||options.nativeImport?accountById.get(user.id)!.locked:0,'旧版余额检查点',true);
      if(report.fundingAdjustments?.some(row=>row.amount>0)) {
        const adjustment=await checkpointTx.create('system',[{id:'body',type:'text',text:'迁移时按可用余额补锁虚拟贡献点；不增发、不强制结算'},{id:'data',type:'data',value:{sourceDigest:report.sourceDigest,policy:'lock-available',adjustments:report.fundingAdjustments as unknown as Json}}],undefined,`migration:lock:${report.sourceDigest.slice(0,32)}`);
        for(const row of report.fundingAdjustments) if(row.amount>0) await store.ledger(row.userId,adjustment.id,-row.amount,row.amount,'迁移虚拟贡献点补锁');
      }
      await store.set('operating',report.operating);
      const locked=options.readOnlyRehearsal||options.nativeImport?users.reduce((sum,user)=>integer(sum+accountById.get(user.id)!.locked),0):0;
      await store.set('minted',integer(report.available+locked+report.operating));
      // Make old closed rounds visible, without guessing historical payouts.
      const activeTargets=new Map<string,Array<{reference:Reference;targetKey:string}>>();
      for(const row of sorted(get('SettlementRound'))) {
        if(converted.has(row.id)) throw new Error('旧轮次与消息 ID 冲突');
        const target={messageId:row.messageId,revision:1};
        const declaration=make({id:row.id,createdById:row.createdByUserId,createdAt:row.openedAt},[{id:'body',type:'text',text:row.note??'旧版结算历史'},{id:'relation',type:'relation',relation:'settlement',roles:bindRoles({target:[target]})},{id:'data',type:'data',value:{kind:'ROUND',openedBy:row.createdByUserId,legacyHistory:true}}]);
        declaration.regionId=regionId;await checkpointTx.put(declaration);
        const round={id:row.id,target,targetRevision:1,status:['SETTLED','CANCELLED','EFFECTED'].includes(row.status)?'settled':'legacy-pending',pro:row.totalProAtSettlement??row.settlementPro??0,con:row.totalConAtSettlement??row.settlementCon??0,result:row.result==='TRUE'?'pro':row.result==='FALSE'?'con':row.result==='UNKNOWN'?'tie':null,previousRoundId:row.previousRoundId??null,distributionId:null,endsAt:row.closedAt?timestamp(row.closedAt):null,targetKey:referenceKey(target),payouts:[],betIds:[],createdAt:timestamp(row.openedAt),settlementType:row.settlementType,subjectId:row.messageId,legacyHistory:true,legacyStatus:row.status,legacyNote:row.note??null,legacyVotes:get('VoteStake').filter(vote=>vote.roundId===row.id).map(vote=>({id:vote.id,userId:vote.userId,vote:vote.vote,amount:vote.amount,createdAt:vote.createdAt}))};
        if((options.nativeRehearsal||options.nativeImport)&&['OPEN','VOTING'].includes(row.status)) {
          if(!['TRUTH','VALUE'].includes(row.settlementType)) throw new Error('不支持的活跃轮次类型');
          const reference:Reference={messageId:row.messageId,revision:1,...(row.settlementType==='VALUE'?{partId:'body'}:{})};
          const key=`legacy-active:${row.settlementType}:${referenceKey(reference)}`;
          const stakes=get('Stake').filter(stake=>stake.roundId===row.id),votes=get('VoteStake').filter(vote=>vote.roundId===row.id);
          const pro=stakes.filter(stake=>stake.side==='PRO').reduce((sum,stake)=>integer(sum+stake.amount),0)+votes.filter(vote=>vote.vote==='TRUE').reduce((sum,vote)=>integer(sum+vote.amount),0);
          const con=stakes.filter(stake=>stake.side==='CON').reduce((sum,stake)=>integer(sum+stake.amount),0)+votes.filter(vote=>vote.vote==='FALSE').reduce((sum,vote)=>integer(sum+vote.amount),0);
          if(votes.some(vote=>vote.vote==='UNKNOWN'&&vote.amount>0)) throw new Error('UNKNOWN 投票本金尚不能按二元新版结算执行');
          const pool=get('BetPool').find(pool=>pool.messageId===row.messageId&&pool.settlementType===row.settlementType);
          if((pool?.lockedPro??0)!==pro||(pool?.lockedCon??0)!==con) throw new Error(`轮次本金和原池不一致: ${row.id}`);
          Object.assign(round,{target:reference,targetKey:key,status:'open',pro,con,legacyActive:true,legacyActiveBoundary:true,legacyOriginalTarget:target});
          for(const stake of [...stakes,...votes.map((vote):Row=>({...vote,messageId:row.messageId,side:vote.vote==='TRUE'?'PRO':'CON'}))]) await store.db.prepare('INSERT INTO bets(id,"roundId","targetKey","userId","messageId",side,amount) VALUES ($1,$2,$3,$4,$5,$6,$7)').run(stake.id,row.id,key,stake.userId,stake.messageId,stake.side==='PRO'?'pro':'con',stake.amount);
          (activeTargets.get(row.messageId)??(activeTargets.set(row.messageId,[]),activeTargets.get(row.messageId)!)).push({reference,targetKey:key});
        }
        await store.db.prepare('INSERT INTO rounds(id,"targetKey",body,"createdAt") VALUES ($1,$2,$3,$4)').run(row.id,round.targetKey,JSON.stringify(round),round.createdAt);
      }
      if(options.nativeRehearsal||options.nativeImport) for(const pool of get('BetPool').filter(pool=>pool.settlementType==='DELEGATION'&&pool.lockedPro+pool.lockedCon>0)) {
        const task=oldMessages.find(message=>message.id===pool.messageId),stakes=get('Stake').filter(stake=>stake.messageId===pool.messageId&&stake.settlementType==='DELEGATION');
        const owners=[...new Set(stakes.map(stake=>stake.userId))];
        const reward=task?.relationPayload?.rewardAmount;
        if(owners.length!==1||!Number.isSafeInteger(reward)||reward<=0||reward>pool.lockedPro+pool.lockedCon) throw new Error('委托本金或奖励不能无损接通新版');
        await store.db.prepare('INSERT INTO escrows VALUES ($1,$2,$3,NULL,NULL)').run(pool.messageId,owners[0],reward);
      }
      const frozenIds=[...new Set([...get('Stake').map(row=>row.messageId),...get('SettlementRound').map(row=>row.messageId)])];
      for(const target of frozenIds) await store.db.prepare('INSERT INTO effects VALUES ($1,$2)').run(`legacy-settlement:${target}`,JSON.stringify({sourceDigest:report.sourceDigest,activeTargets:activeTargets.get(target)??[]}));
      await checkpointTx.commit();
      await migrateAnnotationReasons(store);
      await migrateQueryRecords(store);
      const changeRows=await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all();
      const replay=replayArchive({format:'gonglun-2',regionId,ledgerId:'local',programVersion:'2.0.0',changes:changeRows.map(row=>JSON.parse(String(row.body)))});
      for(const user of users) {
        const account=await store.account(user.id),expected=accountById.get(user.id)!;
        const adjustment=report.fundingAdjustments?.find(row=>row.userId===user.id)?.amount??0;
        if(account.available!==expected.available-adjustment||account.locked!==expected.locked+adjustment||JSON.stringify(account)!==JSON.stringify(replay.accounts.get(user.id))) throw new Error(`目标资金对账失败: ${user.id}`);
      }
      const archiveCount=(await store.db.prepare('SELECT COUNT(*)::integer AS n FROM legacy_records').get())!.n;
      if(archiveCount!==Object.values(snapshot).reduce((total,rows)=>total+rows.length,0)) throw new Error('旧原文归档数量不一致');
      report.applied=true;
      await store.set('migration',report);
      if(options.readOnlyRehearsal)await store.set('access-mode','read-only');
    });
    return report;
  } finally {await store.close();}
}
