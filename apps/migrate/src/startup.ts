import {createHash,randomUUID} from 'node:crypto';
import {Postgres} from '../../server/src/postgres.js';
import {openMigratingStore} from './migrations.js';
import {migrationPlan} from './preflight.js';
import {migrateLegacy} from './migrate-legacy.js';
import {DATABASE_MIGRATIONS} from '../../server/src/database-version.js';
import {ConversionFailure,conversionFailure} from '@gonglun/core';
import {RollbackUnconfirmedError} from '../../server/src/postgres.js';

/** Resumes native upgrades; Prisma imports retain the entire original schema. */
export async function prepareStartupDatabase(databaseUrl:string,schema='public',options:{plan?:boolean;founderId?:string;targetSchema?:string}={}){
  const source=new Postgres(databaseUrl,schema);
  let legacy=false,founderId:string|undefined;
  try{
    const tables=new Set((await source.prepare('SELECT tablename FROM pg_tables WHERE schemaname=$1').all(schema)).map(row=>String(row.tablename)));
    legacy=tables.has('User')&&tables.has('Message');
    if(!legacy&&!tables.has('messages'))throw new Error('目标没有已有消息结构，拒绝自动转换空库或未知数据库');
    if(legacy){
      const users=await source.prepare('SELECT id FROM "User" ORDER BY "createdAt",id').all();
      founderId=options.founderId??String(users[0]?.id??'');
      if(!founderId||!users.some(user=>user.id===founderId))throw new Error('旧数据库没有可用的创始用户');
    }
  }finally{await source.close();}
  if(legacy){
    const suffix='_gonglun_2',target=options.targetSchema??(schema.length+suffix.length<=63?schema+suffix:`gonglun_${createHash('sha256').update(schema).digest('hex').slice(0,24)}`);
    const sourceSchema=schema,guard=new Postgres(databaseUrl,sourceSchema);
    let staging:string|undefined;
    try{await guard.transaction(async()=>{
    const current=new Postgres(databaseUrl,target);
    let imported=false;
    try{
      const exists=await current.prepare("SELECT to_regclass('settings') AS settings").get();
      if(exists?.settings){
        const row=await current.prepare("SELECT value FROM settings WHERE key='migration'").get();
        const origin=await current.prepare("SELECT value FROM settings WHERE key='automatic-import-source'").get();
        imported=!!row&&JSON.parse(String(row.value)).applied===true&&!!origin&&JSON.parse(String(origin.value))===schema;
        if(!imported)throw new Error('自动迁移目标存在未完成的数据库，保留原库并停止启动');
      }
    }finally{await current.close();}
    if(!imported){
      staging=`gonglun_import_${randomUUID().replaceAll('-','')}`;
      const report=await migrateLegacy({sourceUrl:databaseUrl,sourceSchema:sourceSchema,targetUrl:databaseUrl,targetSchema:staging,
        founderId:founderId!,apply:!options.plan,preserveActiveState:true,nativeImport:true});
      if(report.blockers.length||!options.plan&&!report.applied)throw new Error(`旧库不能可靠转换：${report.blockers.join('；')}`);
      if(!options.plan){
        const importedStore=await openMigratingStore(databaseUrl,{schema:staging});
        try{await importedStore.set('automatic-import-source',sourceSchema);}finally{await importedStore.close();}
        await guard.exec(`ALTER SCHEMA "${staging}" RENAME TO "${current.schema}"`);
      }
    }
    });}catch(error){
      const uncertain=error instanceof RollbackUnconfirmedError;
      let status:'unchanged'|'unconfirmed'=uncertain?'unconfirmed':'unchanged';
      let result=uncertain?'旧数据库未修改；转换目标的发布结果未获确认，已停止业务访问。':'旧数据库未修改，未切换到转换结果。';
      if(staging&&!options.plan){
        // Only remove the unique staging schema owned by this attempt.
        const cleanup=new Postgres(databaseUrl);
        try{await cleanup.exec(`DROP SCHEMA IF EXISTS "${staging}" CASCADE`);result+=' 本次临时转换数据已清理。';}
        catch{status='unconfirmed';result+=' 临时转换数据清理失败，请检查数据库。';}
        finally{await cleanup.close();}
      }
      const failure=conversionFailure(error,status,result);
      throw new ConversionFailure({...failure.report,rollbackStatus:status,rollbackResult:result});
    }finally{await guard.close();}
    if(options.plan)return {schema:target,legacy:true};
    schema=target;
  }
  const plan=await migrationPlan(databaseUrl,schema);
  if(!options.plan){
    const store=await openMigratingStore(databaseUrl,{schema});
    try{
      const mode=await store.setting<string>('access-mode');
      return {schema,mode,version:DATABASE_MIGRATIONS.length};
    }finally{await store.close();}
  }
  return {schema,version:plan.currentVersion,pending:plan.pending};
}
