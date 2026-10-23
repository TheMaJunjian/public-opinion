import {Postgres} from '../../server/src/postgres.js';
import {DATABASE_MIGRATIONS} from '../../server/src/database-version.js';
import {settlementTargetRepairPlan} from './restore-settlement-targets.js';
import {valueVoteMessageRepairPlan} from './repair-value-vote-messages.js';
import {annotationStanceMessageRepairPlan} from './repair-annotation-stance-messages.js';

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
    return {...identity,schema:db.schema,region:region?JSON.parse(String(region)):null,counts,settlementTargets,valueVoteMessages,annotationStanceMessages,
      currentVersion:applied.length,pending:DATABASE_MIGRATIONS.slice(applied.length).map((name,index)=>({version:applied.length+index+1,name}))};
  });}finally{await db.close();}
}
