import {afterEach,expect,it} from 'vitest';
import {build} from 'esbuild';
import {migratePendingSends} from './browser-state.js';
import {cleanupTestDatabases,createTestApp,testDatabaseUrl} from '../../server/src/test-database.js';
import {migrationPlan} from './preflight.js';
afterEach(cleanupTestDatabases);

it('空库由主程序建立当前结构，预检不会补版本或创建旧版归档表',async()=>{
  const app=await createTestApp();
  expect(await app.store.db.prepare("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'legacy_%'").all(app.store.db.schema)).toEqual([]);
  await app.store.db.prepare('DELETE FROM schema_migrations WHERE version>3').run();
  const plan=await migrationPlan(testDatabaseUrl(),app.store.db.schema);
  expect(plan.pending.map(item=>item.version)).toEqual([4,5,6]);
  expect((await app.store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())?.version).toBe(3);
});

it('主程序构建不包含迁移模块或旧资金表查询',async()=>{
  const result=await build({entryPoints:['apps/server/src/main.ts'],bundle:true,platform:'node',format:'esm',
    external:['express','zod','pg'],write:false,metafile:true});
  expect(Object.keys(result.metafile!.inputs).filter(path=>path.includes('apps/migrate/'))).toEqual([]);
  expect(result.outputFiles[0].text).not.toMatch(/legacy_stakes|legacy_pools|legacy_accounts|legacy_organization_states/);
});

it('待确认缓存仅在独立工具中转换一次，保留请求编号与原文，不发送请求',()=>{
  const map=new Map<string,string>();
  const storage={get length(){return map.size;},key:(index:number)=>[...map.keys()][index]??null,getItem:(key:string)=>map.get(key)??null,
    setItem:(key:string,value:string)=>{map.set(key,value);},removeItem:(key:string)=>{map.delete(key);},clear:()=>map.clear()} as Storage;
  const raw=JSON.stringify({requestId:'unchanged',commands:[{id:'original',method:'POST',path:'/messages',body:{content:'原文'}}]});
  storage.setItem('gonglun:pending-send:user',raw);
  expect(migratePendingSends(storage,'https://example.test')).toBe(1);
  expect(storage.getItem('gonglun:pending-send:v2:["https://example.test/api","user"]')).toBe(raw);
  expect(storage.getItem('gonglun:migration:backup:gonglun:pending-send:user')).toBe(raw);
  expect(migratePendingSends(storage,'https://example.test')).toBe(0);
});
