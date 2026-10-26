import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { hash } from 'bcryptjs';
import { DATABASE_MIGRATIONS } from '../apps/server/src/database-version.ts';

// Own Compose project and volumes; never reads deployment credentials.
const directory = mkdtempSync(join(tmpdir(), 'gonglun-release-'));
const project = `gonglun-release-${randomBytes(4).toString('hex')}`;
const password = randomBytes(32).toString('hex');
const founder = randomBytes(32).toString('hex');
const env = join(directory, '.env');
const override = join(directory, 'compose.yml');
const caddy = join(directory, 'Caddyfile');
writeFileSync(env, `DOMAIN=localhost\nPOSTGRES_PASSWORD=${password}\nGONGLUN_FOUNDER_KEY=${founder}\nGONGLUN_IMAGE=${project}-api:latest\n`);
writeFileSync(caddy, 'localhost {\n tls internal\n reverse_proxy api:3000 {\n flush_interval -1\n }\n}\n');
writeFileSync(override, `services:\n  postgres:\n    ports:\n      - "127.0.0.1:54331:5432"\n  caddy:\n    ports: !override\n      - "127.0.0.1:54443:443"\n    volumes: !override\n      - ${JSON.stringify(caddy.replaceAll('\\', '/') + ':/etc/caddy/Caddyfile:ro')}\n      - caddy_data:/data\n      - caddy_config:/config\n`);
const args = ['compose', '-p', project, '-f', resolve('deploy/docker-compose.prod.yml'), '-f', resolve('deploy/docker-compose.build.yml'), '-f', override, '--env-file', env];
function compose(...command) {
  const result = spawnSync('docker', [...args, ...command], {stdio:'inherit'});
  if (result.status !== 0) throw new Error(`Compose ${command[0]} failed`);
}
function request(path, method = 'GET', body, headers = {}) {
  return new Promise((resolveRequest, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({hostname:'localhost',port:54443,path,method,rejectUnauthorized:false,headers:{...headers,...(bytes?{'content-type':'application/json','content-length':Buffer.byteLength(bytes)}:{})}}, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const bytes = Buffer.concat(chunks), text = (res.headers['content-encoding']==='gzip'?gunzipSync(bytes):bytes).toString('utf8');
          resolveRequest({status:res.statusCode,headers:res.headers,body:(res.headers['content-type']??'').includes('application/json')?JSON.parse(text):text});
        } catch(error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTPS timeout')));
    req.on('error', reject); req.end(bytes);
  });
}

async function checkFailedUpgrade(databaseUrl,label){
  const checking=new Pool({connectionString:databaseUrl});
  const badId='smoke-invalid-correction';
  const snapshot=async()=>{
    const rows={};
    for(const table of ['messages','revisions','accounts','ledger','schema_migrations'])rows[table]=(await checking.query(`SELECT * FROM migrated_fixture.${table} ORDER BY 1,2`)).rows;
    return rows;
  };
  try{
    const original=JSON.parse((await checking.query("SELECT body FROM migrated_fixture.messages WHERE id='legacy-message'")).rows[0].body);
    const part=original.parts.find(part=>part.type==='text');
    const invalid={...original,id:badId,revision:1,parts:[
      {id:'relation',type:'relation',relation:'amend',roles:{target:[{id:'target',reference:{messageId:original.id,revision:original.revision,partId:part.id,range:{start:0,end:1}}}]}},
      {id:'data',type:'data',value:{legacyTopicId:'legacy-topic',uiType:'CORRECT',correctionContent:'无法对应旧选区'}},
    ]};
    await checking.query('INSERT INTO migrated_fixture.messages VALUES($1,$2,$3,$4,$5)',[badId,invalid.authorId,invalid.createdAt,invalid.sequence,JSON.stringify(invalid)]);
    await checking.query('INSERT INTO migrated_fixture.revisions VALUES($1,$2,$3)',[badId,1,JSON.stringify(invalid)]);
    await checking.query('DELETE FROM migrated_fixture.schema_migrations WHERE version>=7');
    const before=await snapshot();
    compose('restart','api');
    let health;
    for(let attempt=0;;attempt++){
      try{health=await request('/api/health');assert.equal(health.status,503);assert.equal(health.body.conversionFailure.rollbackStatus,'completed');break;}
      catch(error){if(attempt>=40)throw error;await new Promise(r=>setTimeout(r,500));}
    }
    const report=health.body.conversionFailure;
    assert.ok(Number.isFinite(Date.parse(report.failedAt)));
    assert.ok(report.reason.length>0);assert.ok(report.rollbackResult.includes('已回滚'));
    for(let reload=0;reload<2;reload++){
      const page=await request('/');
      assert.equal(page.status,503);assert.equal(page.headers['cache-control'],'no-store');
      for(const label of ['失败时间：','失败原因：','回滚结果：'])assert.ok(page.body.includes(label));
      assert.deepEqual((await request('/api/health')).body.conversionFailure,report);
    }
    assert.equal((await request('/api/messages','POST',{})).status,503);
    assert.deepEqual(await snapshot(),before,'Failed startup must roll back data and version changes');
    const log=spawnSync('docker',[...args,'logs','--no-color','--tail','80','api'],{encoding:'utf8'});
    assert.equal(log.status,0);assert.ok((log.stdout+log.stderr).includes(report.failedAt));
    await checking.query('DELETE FROM migrated_fixture.revisions WHERE "messageId"=$1',[badId]);
    await checking.query('DELETE FROM migrated_fixture.messages WHERE id=$1',[badId]);
  }finally{await checking.end();}
  compose('restart','api');
  for(let attempt=0;;attempt++){
    try{assert.equal((await request('/api/health')).status,200);break;}
    catch(error){if(attempt>=40)throw error;await new Promise(r=>setTimeout(r,500));}
  }
  console.log(`PASS: ${label} failed upgrade rolls back, shows a stable report over HTTPS, stays unhealthy and recovers after repair`);
}
try {
  compose('up','-d','--build','--wait','--wait-timeout','120');
  // Migrations run before the HTTP listener opens. Keep the real entrypoint
  // unavailable past the old health deadline, then require Compose to finish.
  const delayedStartup=join(directory,'delayed-startup.yml');
  writeFileSync(delayedStartup,`services:\n  api:\n    command: ${JSON.stringify(['node','-e',"setTimeout(()=>import('./apps/server/dist/main.js'),60000)"])}\n`);
  const delayed=spawnSync('docker',[...args,'-f',delayedStartup,'up','-d','--no-deps','--no-build','--wait','--wait-timeout','120','api'],{stdio:'inherit'});
  assert.equal(delayed.status,0,'A slow database startup must remain starting until the API is healthy');
  console.log('PASS: delayed API startup remains eligible for Compose readiness after the previous health deadline');
  compose('up','-d','--no-deps','--no-build','--wait','api');
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await request('/api/health')).status,200); break; }
    catch(error) { if(attempt >= 20) throw error; await new Promise(r=>setTimeout(r,500)); }
  }
  const entry=await request('/');
  assert.equal(entry.status,200);assert.equal(entry.headers['cache-control'],'no-store');
  assert.ok(entry.body.includes('data-app-startup="true"'),'The initial HTML must show its own prompt before JavaScript loads');
  const version=await request('/build.json');
  assert.equal(version.status,200);assert.equal(version.headers['cache-control'],'no-store');
  assert.equal(typeof version.body.id,'string');assert.ok(version.body.id);
  const entryModule=entry.body.match(/<script[^>]*src="([^"]+)"/)[1].replace(/^\.\//,'/');
  const client=await request(entryModule);
  assert.equal(client.status,200);assert.ok(client.headers['cache-control'].includes('immutable'));
  assert.ok(client.body.includes(version.body.id),'Client and deployment manifest must identify the same build');
  assert.equal((await request('/assets/missing.js')).status,404);
  assert.equal((await request('/api/setup')).body.founderKeyRequired,true);
  assert.equal((await request('/api/register','POST',{name:'smoke-user',password:'smoke-password'})).status,403);
  const registered=await request('/api/register','POST',{name:'smoke-user',password:'smoke-password',founderKey:founder});
  assert.equal(registered.status,201);
  assert.ok(registered.headers['set-cookie'][0].includes('Secure'));
  const cookie=registered.headers['set-cookie'][0].split(';')[0];
  const headers={cookie,'x-csrf-token':registered.body.csrf};
  assert.equal((await request('/api/messages','POST',{requestId:randomUUID(),parts:[{id:'text',type:'text',text:'blocked'}]},{cookie})).status,403);
  const created=await request('/api/messages','POST',{requestId:randomUUID(),recommendation:1,parts:[{id:'text',type:'text',text:'production smoke persistence'}]},headers);
  assert.equal(created.status,201);
  compose('restart','api');
  for(let attempt=0;;attempt++) {
    try { assert.equal((await request('/api/health')).status,200); break; }
    catch(error) { if(attempt >= 40) throw error; await new Promise(r=>setTimeout(r,500)); }
  }
  const context=await request(`/api/messages/${created.body.message.id}/context`);
  assert.equal(context.status,200);
  assert.ok(context.body.messages.some(message=>message.id===created.body.message.id));
  assert.equal((await request('/api/session','GET',undefined,{cookie})).body.user.id,registered.body.user.id);
  assert.equal((await request('/api/login','POST',{name:'smoke-user',password:'smoke-password'})).status,200);
  console.log('PASS: PostgreSQL → API → Caddy HTTPS, static page, founder protection, Secure cookie, CSRF, write, restart persistence, session and login');
  // Exercise the actual migration CLI and then run its result through the
  // built production image. All data is synthetic in this owned project.
  const databaseUrl=`postgresql://gonglun:${password}@127.0.0.1:54331/gonglun`;
  const pool=new Pool({connectionString:databaseUrl});
  const time='2026-01-01T00:00:00.000Z';
  const fixture={
    User:[{id:'legacy-user',username:'legacy-user',password:await hash('old',4),publicKey:null,createdAt:time,updatedAt:time}],
    Topic:[{id:'legacy-topic',title:'Legacy topic',status:'OPEN',createdById:'legacy-user',createdAt:time,updatedAt:time}],
    Message:[{id:'legacy-message',topicId:'legacy-topic',createdById:'legacy-user',kind:'TEXT',content:'Legacy message preserved',createdAt:time,updatedAt:time},
      {id:'legacy-result',topicId:'legacy-topic',createdById:'legacy-user',kind:'ROUND_RESULT',relationType:null,content:'Historical settlement result',
        targetRefs:[{messageId:'legacy-message'}],relationPayload:{settlementType:'TRUTH'},createdAt:time,updatedAt:time},
      {id:'legacy-termination',topicId:'legacy-topic',createdById:'legacy-user',kind:'RELATION',relationType:'OPERATIONS',content:'Historical termination request',
        targetRefs:[{messageId:'legacy-message'}],relationPayload:{operationType:'TERMINATE_SETTLEMENT',roundId:'legacy-previous-round'},createdAt:time,updatedAt:time}],
    Balance:[{userId:'legacy-user',balance:300,debtFrozen:false}],
    PointAccount:[{userId:'legacy-user',available:300,locked:0}],
    RevenuePool:[{id:'legacy-pool',balance:20}],
  };
  try {
    await pool.query('CREATE SCHEMA legacy_fixture');
    for(const table of ['User','Topic','Message','Balance','PointAccount','SettlementRound','Stake','VoteStake','BetPool','RevenuePool','LedgerEntry','RuleVersion','UserSigningKey','AuditLog']) {
      const rows=fixture[table]??[],fields=rows.length?[...new Set(rows.flatMap(row=>Object.keys(row)))]:['id'];
      const definitions=fields.map(field=>{const value=rows.find(row=>row[field]!==null&&row[field]!==undefined)?.[field];
        return `"${field}" ${typeof value==='number'?'integer':typeof value==='boolean'?'boolean':value&&typeof value==='object'?'jsonb':'text'}`;});
      await pool.query(`CREATE TABLE legacy_fixture."${table}" (${definitions.join(',')})`);
      for(const row of rows) await pool.query(`INSERT INTO legacy_fixture."${table}" VALUES (${fields.map((_,index)=>`$${index+1}`).join(',')})`,fields.map(field=>row[field]&&typeof row[field]==='object'?JSON.stringify(row[field]):row[field]));
    }
  } finally {await pool.end();}
  const migrated=spawnSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('apps/migrate/src/migrate-legacy-cli.ts'),'--founder-id','legacy-user','--apply','--accept-checkpoint'],{stdio:'inherit',env:{...process.env,LEGACY_DATABASE_URL:databaseUrl,LEGACY_DATABASE_SCHEMA:'legacy_fixture',MIGRATION_TARGET_DATABASE_URL:databaseUrl,MIGRATION_TARGET_SCHEMA:'migrated_fixture'}});
  assert.equal(migrated.status,0);
  writeFileSync(override,readFileSync(override,'utf8')+'  api:\n    environment:\n      DATABASE_SCHEMA: migrated_fixture\n');
  compose('up','-d','--wait','api','caddy');
  for(let attempt=0;;attempt++) {
    try {assert.equal((await request('/api/health')).status,200);break;}
    catch(error){if(attempt>=40)throw error;await new Promise(r=>setTimeout(r,500));}
  }
  const oldLogin=await request('/api/login','POST',{name:'legacy-user',password:'old'});
  assert.equal(oldLogin.status,200);assert.equal(oldLogin.body.account.available,297);
  const legacyView=await request('/api/ui/snapshot?parent=legacy-topic');
  assert.equal(legacyView.status,200);
  assert.ok(legacyView.body.messages.some(message=>message.id==='legacy-message'&&message.content==='Legacy message preserved'));
  const compact=await request('/api/ui/snapshot?parent=root&batch=4&format=compact-v1','GET',undefined,{'accept-encoding':'gzip'});
  assert.equal(compact.status,200);assert.equal(compact.headers['content-encoding'],'gzip');
  assert.equal(compact.body.snapshotEncoding,'relations-v1');
  assert.ok(compact.body.messages.some(message=>message.id==='legacy-message'&&message.content==='Legacy message preserved'));
  assert.ok(compact.body.relationRecords.length>0);
  assert.ok(compact.body.relationRecords.every(index=>Number.isInteger(index)&&compact.body.messages[index]));
  const migratedWrite=await request('/api/messages','POST',{requestId:randomUUID(),recommendation:1,parts:[{id:'body',type:'text',text:'Migrated production write'}]},{cookie:oldLogin.headers['set-cookie'][0].split(';')[0],'x-csrf-token':oldLogin.body.csrf});
  assert.equal(migratedWrite.status,201);assert.equal(migratedWrite.body.account.available,295);
  // The packaged server launches its separate migrator automatically on restart.
  const upgradePool=new Pool({connectionString:databaseUrl});
  try{
    const old=JSON.parse((await upgradePool.query("SELECT body FROM migrated_fixture.messages WHERE id='legacy-result'")).rows[0].body);
    const broken={...old,parts:old.parts.filter(part=>part.id!=='settlement-target')};
    await upgradePool.query('UPDATE migrated_fixture.messages SET body=$1 WHERE id=$2',[JSON.stringify(broken),old.id]);
    await upgradePool.query('UPDATE migrated_fixture.revisions SET body=$1 WHERE "messageId"=$2 AND revision=1',[JSON.stringify(broken),old.id]);
    await upgradePool.query('DELETE FROM migrated_fixture.refs WHERE "sourceId"=$1 AND "targetId"=$2',[old.id,'legacy-message']);
    await upgradePool.query('DELETE FROM migrated_fixture.schema_migrations WHERE version>=7');
  }
  finally{await upgradePool.end();}
  compose('restart','api');
  for(let attempt=0;;attempt++){
    try{assert.equal((await request('/api/health')).status,200);break;}
    catch(error){if(attempt>=40)throw error;await new Promise(r=>setTimeout(r,500));}
  }
  const afterUpgrade=await request('/api/login','POST',{name:'legacy-user',password:'old'});
  assert.equal(afterUpgrade.status,200);assert.equal(afterUpgrade.body.account.available,migratedWrite.body.account.available);
  const upgradedPool=new Pool({connectionString:databaseUrl});
  try{
    assert.equal((await upgradedPool.query('SELECT MAX(version) AS version FROM migrated_fixture.schema_migrations')).rows[0].version,DATABASE_MIGRATIONS.length);
    const repaired=JSON.parse((await upgradedPool.query("SELECT body FROM migrated_fixture.messages WHERE id='legacy-result'")).rows[0].body);
    assert.ok(repaired.parts.some(part=>part.type==='relation'&&part.relation==='distribution'&&part.roles.target?.some(binding=>binding.reference.messageId==='legacy-message')));
    assert.equal((await upgradedPool.query('SELECT COUNT(*) AS n FROM migrated_fixture.refs WHERE "sourceId"=$1 AND "targetId"=$2',['legacy-result','legacy-message'])).rows[0].n,'1');
    const termination=JSON.parse((await upgradedPool.query("SELECT body FROM migrated_fixture.messages WHERE id='legacy-termination'")).rows[0].body);
    assert.equal(termination.spending.wager,1);
    assert.ok(termination.parts.some(part=>part.type==='data'&&part.value?.roundId==='legacy-previous-round'));
  }
  finally{await upgradedPool.end();}
  console.log('PASS: packaged server automatically upgrades an older database without a confirmation');
  await checkFailedUpgrade(databaseUrl,'packaged main');
  // Exercise the same prebuilt image against the already migrated DB. The DB
  // container (including its start time and volume) must remain untouched.
  const capturePostgres=()=>{
    const id=spawnSync('docker',[...args,'ps','-q','postgres'],{encoding:'utf8'}).stdout.trim();
    return spawnSync('docker',['inspect','--format','{{.Id}} {{.State.StartedAt}} {{json .Mounts}}',id],{encoding:'utf8'}).stdout.trim();
  };
  const originalPostgres=capturePostgres();
  const migrationEnv=join(directory,'.env.migration');
  const migrationText=schema=>`MIGRATION_TARGET_DATABASE_URL=${databaseUrl}\nMIGRATION_TARGET_SCHEMA=${schema}\n`;
  writeFileSync(env,readFileSync(env,'utf8')+`GONGLUN_MIGRATION_ENV_FILE=${migrationEnv.replaceAll('\\','/')}\n`);
  args.splice(7,0,'-f',resolve('deploy/docker-compose.rehearsal.yml'));
  writeFileSync(override,readFileSync(override,'utf8')+'    ports: !reset []\n');
  writeFileSync(migrationEnv,migrationText('missing_target'));
  const refused=spawnSync('docker',[...args,'run','--rm','--no-deps','-T','api','node','scripts/start-existing.mjs','--check'],{stdio:'inherit'});
  assert.notEqual(refused.status,0);
  const checking=new Pool({connectionString:databaseUrl});
  try {
    assert.equal((await checking.query("SELECT to_regnamespace('missing_target') AS name")).rows[0].name,null);
    await checking.query("UPDATE migrated_fixture.settings SET value='\"read-only\"' WHERE key='access-mode'");
  } finally {await checking.end();}
  writeFileSync(migrationEnv,migrationText('migrated_fixture'));
  compose('run','--rm','--no-deps','-T','api','node','scripts/start-existing.mjs','--check');
  compose('up','-d','--no-deps','--no-build','--pull','never','--wait','api');
  assert.equal(capturePostgres(),originalPostgres);
  const preserved=await request('/api/login','POST',{name:'legacy-user',password:'old'});
  assert.equal(preserved.status,200);assert.equal(preserved.body.account.available,migratedWrite.body.account.available);
  assert.ok((await request('/api/ui/snapshot?parent=legacy-topic')).body.messages.some(message=>message.id==='legacy-message'));
  assert.equal((await request('/api/messages','POST',{requestId:randomUUID(),parts:[{id:'body',type:'text',text:'must remain read only'}]})).status,503);
  // The shipped tools must inspect without running migrations, then retire an
  // already imported Topic without replacing its messages or touching balances.
  const imageTool=(file,toolArgs,input)=>{
    const result=spawnSync('docker',[...args,'run','--rm','--no-deps','-T','api','node',`apps/migrate/dist/${file}.js`,...toolArgs],{encoding:'utf8',input,maxBuffer:16*1024*1024});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  const retirementPlan=imageTool('retire-legacy-topics-cli',[]);
  assert.equal(retirementPlan.topics,1);
  const beforeRetirement=imageTool('topic-retirement-audit',['capture','-']);
  const beforeRetirementView=imageTool('topic-retirement-view-audit',['capture','-']);
  imageTool('retire-legacy-topics-cli',['--apply','--expect-region',retirementPlan.region]);
  assert.equal(imageTool('topic-retirement-audit',['verify','-','-'],JSON.stringify(beforeRetirement)).verified,true);
  assert.equal(imageTool('topic-retirement-view-audit',['verify','-','-'],JSON.stringify(beforeRetirementView)).verified,true);
  assert.equal(imageTool('retire-legacy-topics-cli',[]).topics,0);
  const retiredRoot=await request('/api/ui/snapshot');
  assert.ok(retiredRoot.body.messages.some(message=>message.id==='legacy-topic'&&message.state.organizationRetired));
  assert.ok(retiredRoot.body.messages.some(message=>message.id==='legacy-message'&&message.content==='Legacy message preserved'));
  console.log('PASS: packaged read-only retirement preflight, incremental upgrade, SQL/replay/all-viewer verification, idempotent rerun');
  console.log('PASS: prebuilt rehearsal image, empty target rejected, same PostgreSQL container/start time/volume, preserved login/balance/messages, read-only writes blocked');
  console.log('PASS: actual Prisma migration CLI → production image → Caddy HTTPS → bcrypt login, preserved message and balance, new write');
  await checkFailedUpgrade(databaseUrl,'prebuilt existing-database launcher');
} finally {
  try { compose('down','--volumes','--remove-orphans'); }
  finally { rmSync(directory,{recursive:true,force:true}); }
}
