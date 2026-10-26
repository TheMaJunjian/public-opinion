import {Postgres} from '../../server/src/postgres.js';
import {DATABASE_MIGRATIONS} from '../../server/src/database-version.js';
import {settlementTargetRepairPlan} from './restore-settlement-targets.js';
import {valueVoteMessageRepairPlan} from './repair-value-vote-messages.js';
import {annotationStanceMessageRepairPlan} from './repair-annotation-stance-messages.js';
import {minimumContributionCandidates} from './backfill-minimum-contributions.js';
import {dependentMembershipRemovalPlan} from './remove-dependent-memberships.js';
import {delegationBodyRepairPlan} from './delegation-body-plan.js';
import {targetInvestmentPlan} from './target-investments.js';
import {retainedTargetInvestmentPlan} from './retained-target-investments.js';
import {legacyAnnotationInvestmentPlan} from './legacy-annotation-investments.js';
import {readingMessageRemovalPlan} from './remove-reading-messages.js';
import {containerReadingCleanupPlan} from './cleanup-container-reading-marks.js';

/** Read-only planning does not initialize, stamp or rewrite any database. */
export async function migrationPlan(databaseUrl:string,schema?:string){
  const db=new Postgres(databaseUrl,schema);
  try{return await db.read(async()=>{
    const identity=await db.prepare('SELECT current_database() AS database').get();
    const tables=new Set((await db.prepare('SELECT tablename FROM pg_tables WHERE schemaname=$1').all(db.schema)).map(row=>String(row.tablename)));
    if(tables.has('User')||tables.has('Message'))throw new Error('这是旧版源库，请使用 db:migrate-legacy 迁入新库');
    const applied=tables.has('schema_migrations')?await db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all<{version:number;name:string}>():[];
    if(applied.some((row,index)=>row.version!==index+1||DATABASE_MIGRATIONS[index]!==row.name))throw new Error('数据库版本与迁移程序不兼容');
    const counts:Record<string,number>={};
    for(const table of ['messages','revisions','changes','accounts','ledger'])if(tables.has(table))counts[table]=Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())!.count);
    const region=tables.has('settings')?(await db.prepare("SELECT value FROM settings WHERE key='region'").get())?.value:undefined;
    const settlementTargets=tables.has('messages')&&tables.has('revisions')?await settlementTargetRepairPlan(db):undefined;
    const valueVoteMessages=['messages','revisions','rounds','bets','execution_stances'].every(table=>tables.has(table))?await valueVoteMessageRepairPlan(db):undefined;
    const annotationStanceMessages=tables.has('messages')&&tables.has('revisions')?await annotationStanceMessageRepairPlan(db):undefined;
    const minimumContributions=tables.has('messages')&&tables.has('accounts')?(await minimumContributionCandidates(db)).length:0;
    const dependentMemberships=tables.has('messages')&&tables.has('memberships')?await dependentMembershipRemovalPlan({db}):undefined;
    const delegationBodies=tables.has('messages')?await delegationBodyRepairPlan(db):undefined;
    const targetInvestments=['messages','rounds','bets','execution_stances'].every(table=>tables.has(table))?await targetInvestmentPlan({db}):undefined;
    const retainedTargetInvestments=tables.has('target_investment_migrations')?await retainedTargetInvestmentPlan({db}):undefined;
    const legacyAnnotationInvestments=tables.has('target_investment_migrations')?await legacyAnnotationInvestmentPlan({db}):undefined;
    const readingMessages=['messages','ledger','bets','rounds'].every(table=>tables.has(table))?await readingMessageRemovalPlan({db}):undefined;
    const containerReadingMarks=['reading_marks','messages','membership_actions','message_state_checkpoints','settings'].every(table=>tables.has(table))?await containerReadingCleanupPlan({db}):undefined;
    const meaningAuthors=tables.has('messages')?await db.prepare(`SELECT "authorId",COUNT(*) AS count,COALESCE(SUM(COALESCE((body::jsonb->'spending'->>'protocol')::bigint,0)),0) AS "previousProtocol" FROM messages WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(body::jsonb->'parts') p WHERE p->>'type'='data' AND p->'value'->>'correctionKind'='MEANING') AND EXISTS (SELECT 1 FROM jsonb_array_elements(body::jsonb->'parts') p WHERE p->>'type'='relation' AND p->>'relation' IN ('correct','amend')) GROUP BY "authorId" ORDER BY "authorId"`).all():[];
    const simplifiedCorrections=meaningAuthors.reduce((total,row)=>total+Number(row.count),0),fee=tables.has('settings')?JSON.parse(String((await db.prepare("SELECT value FROM settings WHERE key='rules'").get())?.value??'{}')).protocolFee??1:1;
    const bodyProtocolAdjustment=simplifiedCorrections*fee-meaningAuthors.reduce((total,row)=>total+Number(row.previousProtocol),0);
    const referenceConsumption={messages:simplifiedCorrections,protocolFee:simplifiedCorrections*fee,valueContribution:simplifiedCorrections,total:simplifiedCorrections*(fee+1),bodyProtocolAdjustment,netDeduction:bodyProtocolAdjustment+simplifiedCorrections*(fee+1),debtAllowed:true,authors:await Promise.all(meaningAuthors.map(async row=>{
      const available=tables.has('accounts')?Number((await db.prepare('SELECT available FROM accounts WHERE "userId"=$1').get(row.authorId))?.available??0):0;
      const total=Number(row.count)*(fee+1),bodyProtocolAdjustment=Number(row.count)*fee-Number(row.previousProtocol),netDeduction=bodyProtocolAdjustment+total;
      return {userId:row.authorId,messages:Number(row.count),available,total,bodyProtocolAdjustment,netDeduction,balanceAfter:available-netDeduction};
    }))};
    const sharedReadingMarks=tables.has('reading_marks')?Number((await db.prepare("SELECT COUNT(*) AS count FROM reading_marks WHERE body->>'format' IS DISTINCT FROM '3'").get())!.count):0;
    return {...identity,schema:db.schema,region:region?JSON.parse(String(region)):null,counts,settlementTargets,valueVoteMessages,annotationStanceMessages,minimumContributions,dependentMemberships,delegationBodies,targetInvestments,retainedTargetInvestments,legacyAnnotationInvestments,
      readingMessages,containerReadingMarks,simplifiedCorrections,referenceConsumption,sharedReadingMarks,currentVersion:applied.length,pending:DATABASE_MIGRATIONS.slice(applied.length).map((name,index)=>({version:applied.length+index+1,name}))};
  });}finally{await db.close();}
}
