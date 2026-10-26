import {afterEach,expect,it} from 'vitest';
import {bindRoles,replayArchive,type Message} from '@gonglun/core';
import {Mutation,Store} from '../../server/src/db.js';
import {cleanupTestDatabases,createTestStore,newTestSchema,testDatabaseUrl} from '../../server/src/test-database.js';
import {openMigratingStore} from './migrations.js';

afterEach(cleanupTestDatabases);

it('主程序拒绝旧格式，独立命令只迁移一次，覆盖版本、日志和幂等结果并保留原文',async()=>{
  const schema=newTestSchema(),store=await createTestStore(schema);
  const originals:Message[]=[];
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    const target=await tx.create('system',[{id:'body',type:'text',text:'目标'}],undefined,'target');
    for(const name of ['follow','unfollow','block','unblock']) originals.push(await tx.create('actor',[
      {id:'relation',type:'relation',relation:name,roles:bindRoles({target:[{messageId:target.id,revision:1,partId:'body',range:{start:0,end:1}}]})},
      {id:'data',type:'data',value:{uiType:name==='follow'?'ATTENTION':name.toUpperCase()}}
    ],undefined,name));
    await tx.commit();
    await store.db.prepare('INSERT INTO requests VALUES($1,$2,$3,$4)').run('actor','retry','original signed input',JSON.stringify({message:originals[1]}));
    await store.db.exec('DELETE FROM schema_migrations WHERE version>=4');
  });
  const before=await store.latestSequence(),ledger=await store.db.prepare('SELECT * FROM ledger').all();
  await expect(Store.open(testDatabaseUrl(),{schema,autoMigrate:false})).rejects.toThrow('请先执行 npm run db:migrate');
  expect((await store.message('unfollow')).parts[0]).toMatchObject({relation:'unfollow'});
  const upgraded=await openMigratingStore(testDatabaseUrl(),{schema});
  try{
    for(const [id,name,reason] of [['follow','follow','YES'],['unfollow','follow','NO'],['block','block','YES'],['unblock','block','NO']]){
      const message=await upgraded.message(id!),revision=await upgraded.message(id!,1);
      expect(message).toEqual(revision);
      expect(message.parts[0]).toMatchObject({id:'relation',relation:name,reason,roles:{target:[{reference:{messageId:'target',revision:1,partId:'body',range:{start:0,end:1}}}]}});
    }
    expect(await upgraded.latestSequence()).toBe(before+2);
    expect(await upgraded.db.prepare('SELECT * FROM ledger').all()).toEqual(ledger);
    const retry=await upgraded.db.prepare('SELECT input,result FROM requests').get();
    expect(retry?.input).toBe('original signed input');
    expect(JSON.parse(String(retry?.result)).message.parts[0]).toMatchObject({relation:'follow',reason:'NO'});
    const backup=await upgraded.db.prepare("SELECT body FROM annotation_reason_backups WHERE table_name='messages' AND row_key='unfollow'").get();
    expect(JSON.parse(String(backup?.body)).parts[0].relation).toBe('unfollow');
    const archive={format:'gonglun-2',changes:(await upgraded.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)))};
    expect(replayArchive(archive).messages.find(message=>message.id==='unfollow')?.parts[0]).toMatchObject({relation:'follow',reason:'NO'});
  }finally{await upgraded.close();}
  const again=await openMigratingStore(testDatabaseUrl(),{schema});
  try{expect(await again.latestSequence()).toBe(before+2);}finally{await again.close();}
});
