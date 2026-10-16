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
try {
  compose('up','-d','--build','--wait','--wait-timeout','120');
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await request('/api/health')).status,200); break; }
    catch(error) { if(attempt >= 20) throw error; await new Promise(r=>setTimeout(r,500)); }
  }
  assert.equal((await request('/')).status,200);
  assert.equal((await request('/api/setup')).body.founderKeyRequired,true);
  assert.equal((await request('/api/register','POST',{name:'smoke-user',password:'smoke-password'})).status,403);
  const registered=await request('/api/register','POST',{name:'smoke-user',password:'smoke-password',founderKey:founder});
  assert.equal(registered.status,201);
  assert.ok(registered.headers['set-cookie'][0].includes('Secure'));
  const cookie=registered.headers['set-cookie'][0].split(';')[0];
  const headers={cookie,'x-csrf-token':registered.body.csrf};
  assert.equal((await request('/api/messages','POST',{requestId:randomUUID(),parts:[{id:'text',type:'text',text:'blocked'}]},{cookie})).status,403);
  const created=await request('/api/messages','POST',{requestId:randomUUID(),parts:[{id:'text',type:'text',text:'production smoke persistence'}]},headers);
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
    Message:[{id:'legacy-message',topicId:'legacy-topic',createdById:'legacy-user',kind:'TEXT',content:'Legacy message preserved',createdAt:time,updatedAt:time}],
    Balance:[{userId:'legacy-user',balance:300,debtFrozen:false}],
    PointAccount:[{userId:'legacy-user',available:300,locked:0}],
    RevenuePool:[{id:'legacy-pool',balance:20}],
  };
  try {
    await pool.query('CREATE SCHEMA legacy_fixture');
    for(const table of ['User','Topic','Message','Balance','PointAccount','SettlementRound','Stake','VoteStake','BetPool','RevenuePool','LedgerEntry','RuleVersion','UserSigningKey','AuditLog']) {
      const rows=fixture[table]??[],fields=Object.keys(rows[0]??{id:''});
      const definitions=fields.map(field=>`"${field}" ${typeof rows[0]?.[field]==='number'?'integer':typeof rows[0]?.[field]==='boolean'?'boolean':'text'}`);
      await pool.query(`CREATE TABLE legacy_fixture."${table}" (${definitions.join(',')})`);
      for(const row of rows) await pool.query(`INSERT INTO legacy_fixture."${table}" VALUES (${fields.map((_,index)=>`$${index+1}`).join(',')})`,fields.map(field=>row[field]));
    }
  } finally {await pool.end();}
  const migrated=spawnSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('apps/server/src/migrate-legacy-cli.ts'),'--founder-id','legacy-user','--apply','--accept-checkpoint'],{stdio:'inherit',env:{...process.env,LEGACY_DATABASE_URL:databaseUrl,LEGACY_DATABASE_SCHEMA:'legacy_fixture',MIGRATION_TARGET_DATABASE_URL:databaseUrl,MIGRATION_TARGET_SCHEMA:'migrated_fixture'}});
  assert.equal(migrated.status,0);
  writeFileSync(override,readFileSync(override,'utf8')+'  api:\n    environment:\n      DATABASE_SCHEMA: migrated_fixture\n');
  compose('up','-d','--wait','api','caddy');
  for(let attempt=0;;attempt++) {
    try {assert.equal((await request('/api/health')).status,200);break;}
    catch(error){if(attempt>=40)throw error;await new Promise(r=>setTimeout(r,500));}
  }
  const oldLogin=await request('/api/login','POST',{name:'legacy-user',password:'old'});
  assert.equal(oldLogin.status,200);assert.equal(oldLogin.body.account.available,300);
  const legacyView=await request('/api/ui/snapshot?parent=legacy-topic');
  assert.equal(legacyView.status,200);
  assert.ok(legacyView.body.messages.some(message=>message.id==='legacy-message'&&message.content==='Legacy message preserved'));
  const compact=await request('/api/ui/snapshot?parent=root&batch=4&format=compact-v1','GET',undefined,{'accept-encoding':'gzip'});
  assert.equal(compact.status,200);assert.equal(compact.headers['content-encoding'],'gzip');
  assert.equal(compact.body.snapshotEncoding,'relations-v1');
  assert.ok(compact.body.messages.some(message=>message.id==='legacy-message'&&message.content==='Legacy message preserved'));
  assert.ok(compact.body.relationRecords.length>0);
  assert.ok(compact.body.relationRecords.every(index=>Number.isInteger(index)&&compact.body.messages[index]));
  const migratedWrite=await request('/api/messages','POST',{requestId:randomUUID(),parts:[{id:'body',type:'text',text:'Migrated production write'}]},{cookie:oldLogin.headers['set-cookie'][0].split(';')[0],'x-csrf-token':oldLogin.body.csrf});
  assert.equal(migratedWrite.status,201);assert.equal(migratedWrite.body.account.available,299);
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
    await checking.query("UPDATE migrated_fixture.settings SET value=(value::jsonb || '{\"mode\":\"read-only-rehearsal\"}'::jsonb)::text WHERE key='migration'");
  } finally {await checking.end();}
  writeFileSync(migrationEnv,migrationText('migrated_fixture'));
  compose('run','--rm','--no-deps','-T','api','node','scripts/start-existing.mjs','--check');
  compose('up','-d','--no-deps','--no-build','--pull','never','--wait','api');
  assert.equal(capturePostgres(),originalPostgres);
  const preserved=await request('/api/login','POST',{name:'legacy-user',password:'old'});
  assert.equal(preserved.status,200);assert.equal(preserved.body.account.available,299);
  assert.ok((await request('/api/ui/snapshot?parent=legacy-topic')).body.messages.some(message=>message.id==='legacy-message'));
  assert.equal((await request('/api/messages','POST',{requestId:randomUUID(),parts:[{id:'body',type:'text',text:'must remain read only'}]})).status,503);
  console.log('PASS: prebuilt rehearsal image, empty target rejected, same PostgreSQL container/start time/volume, preserved login/balance/messages, read-only writes blocked');
  console.log('PASS: actual Prisma migration CLI → production image → Caddy HTTPS → bcrypt login, preserved message and balance, new write');
} finally {
  try { compose('down','--volumes','--remove-orphans'); }
  finally { rmSync(directory,{recursive:true,force:true}); }
}
