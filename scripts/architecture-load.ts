import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, platform } from 'node:os';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { replayArchive } from '../packages/core/src/replay.js';

// Explicit test server only. Both workers own a fresh namespace; no deployment credentials.
const schema = process.env.LOAD_SCHEMA ?? `gonglun_load_${randomUUID().replaceAll('-', '')}`;
if (!/^gonglun_load_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid load-test schema');
const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://gonglun:gonglun_dev@127.0.0.1:54329/gonglun');
url.searchParams.set('application_name', schema);

if (process.argv.includes('--worker')) {
  const { createApp } = await import(process.env.LOAD_SERVER_SOURCE ?? '../apps/server/src/app.js');
  const app = await createApp({ databaseUrl: url.toString(), databaseSchema: schema, settlementTickMs: 1000 });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.send?.({ port: (server.address() as { port: number }).port });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.close(); process.exit(0);
  };
  process.on('message', () => { void stop(); });
  process.on('disconnect', () => { void stop(); });
} else {
  const output = process.argv[process.argv.indexOf('--output') + 1];
  if (!process.argv.includes('--output') || !output) throw new Error('Use --output <report.json>');
  const children: ChildProcess[] = [], pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
  const samples: { waiting: number; connections: number }[] = [];
  const workers: string[] = [];
  let sampleTimer: NodeJS.Timeout | undefined, sampling: Promise<void> | undefined;
  let samplingFailure: unknown;
  const percentile = (values: number[], p: number) => Math.round([...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)] * 100) / 100;
  const distribution = (values: number[]) => ({ count: values.length, p50Ms: percentile(values,.5), p95Ms: percentile(values,.95), p99Ms: percentile(values,.99) });
  try {
    for (let i = 0; i < 2; i++) {
      const child = fork(fileURLToPath(import.meta.url), ['--worker'], { env: { ...process.env, NODE_ENV: 'test', LOAD_SCHEMA: schema }, stdio: ['ignore','inherit','inherit','ipc'] });
      children.push(child);
      const ready = await new Promise<{port:number}>((resolve,reject) => {
        const timer = setTimeout(()=>{ child.kill(); reject(new Error('Worker startup timeout')); },30000);
        child.once('message', message=>{ clearTimeout(timer); resolve(message as {port:number}); });
        child.once('exit', code=>{ clearTimeout(timer); reject(new Error(`Worker exited ${code}`)); });
      });
      workers.push(`http://127.0.0.1:${ready.port}`);
    }
    const actors: { cookie: string; csrf: string; id: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await fetch(`${workers[i%2]}/api/register`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:`load-user-${i}`,password:'synthetic-load-password'})});
      assert.equal(response.status,201); const data = await response.json() as any;
      actors.push({ cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf, id: data.user.id });
    }
    let head = 0, expectedWrites = 0;
    const command = (content: string) => ({requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path:'/messages',body:{content}}]});
    const post = async (index: number, body: unknown, actor = actors[index%actors.length]) => fetch(`${workers[index%2]}/api/ui/commands`, {
      method:'POST',headers:{'content-type':'application/json',cookie:actor.cookie,'x-csrf-token':actor.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(30000),
    });
    for (let i=0;i<16;i++) { const r=await post(i,command('warmup')); assert.equal(r.status,201); head=(await r.json() as any).sequence; expectedWrites++; }
    sampleTimer = setInterval(()=>{
      if (sampling) return;
      sampling=pool.query("SELECT COUNT(*)::int AS connections,COUNT(*) FILTER (WHERE wait_event='advisory')::int AS waiting FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()",[schema])
        .then(result=>{samples.push(result.rows[0]);}).catch(error=>{samplingFailure=error;}).finally(()=>{sampling=undefined;});
    },25);
    const phases: unknown[] = [];
    for (let repetition=1;repetition<=3;repetition++) for (const concurrency of [1,8,24]) {
      const reads: number[] = [], writes: number[] = [], errors: unknown[] = [];
      const sampleStart=samples.length, started=performance.now(); let index=0;
      await Promise.all(Array.from({length:concurrency},async()=>{
        while (index<192) {
          const task=index++, start=performance.now(), read=task%4===0;
          try {
            const response=read ? await fetch(`${workers[task%2]}/api/ui/snapshot?after=${head}`,{signal:AbortSignal.timeout(30000)}) : await post(task,command(`load ${repetition}/${concurrency}/${task}`));
            const data=await response.json() as any;
            if(response.status!==(read?200:201)) throw new Error(`${response.status}: ${data.error}`);
            head=Math.max(head,data.sequence); if(!read)expectedWrites++;
            (read?reads:writes).push(performance.now()-start);
          } catch(error) { errors.push(String(error)); }
        }
      }));
      const durationMs=performance.now()-started, observations=samples.slice(sampleStart);
      const phase={repetition,concurrency,requests:192,durationMs:Math.round(durationMs),requestsPerSecond:Math.round(192000/durationMs*100)/100,reads:distribution(reads),writes:distribution(writes),errors,
        maxAdvisoryWaiters:Math.max(0,...observations.map(s=>s.waiting)),maxConnections:Math.max(0,...observations.map(s=>s.connections))};
      phases.push(phase); console.log(JSON.stringify(phase));
      assert.equal(errors.length,0);
    }
    const retry=command('concurrent identical retry');
    const retries=await Promise.all(Array.from({length:32},(_,i)=>post(i,retry,actors[0]).then(async r=>{assert.equal(r.status,201);return r.json() as Promise<any>;})));
    assert.ok(retries.every(r=>r.results[0].id===retry.commands[0].id)); expectedWrites++;
    const before=(await pool.query('SELECT available FROM accounts WHERE "userId"=$1',[actors[7].id])).rows[0].available;
    const overspend=await Promise.all(Array.from({length:24},(_,i)=>post(i,{requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path:'/messages',body:{content:'contended balance',recommendation:before-1}}]},actors[7]).then(async r=>{await r.text();return r.status;})));
    assert.equal(overspend.filter(s=>s===201).length,1); assert.ok(overspend.every(s=>s===201||s===400)); expectedWrites++;
    const exported=await fetch(`${workers[0]}/api/ui/export`).then(r=>r.json()) as any;
    const replay=replayArchive(exported), accounts=(await pool.query('SELECT * FROM accounts')).rows;
    for(const {userId,...account} of accounts) assert.deepEqual(replay.accounts.get(userId),Object.fromEntries(Object.entries(account).map(([key,value])=>[key,Number(value)])));
    assert.equal(exported.changes.length,8+expectedWrites);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM command_requests')).rows[0].n,expectedWrites);
    assert.equal(samplingFailure,undefined);
    const sourceDirectory=process.env.LOAD_SERVER_SOURCE ? dirname(fileURLToPath(process.env.LOAD_SERVER_SOURCE)) : resolve('apps/server/src');
    const sourceSha256=Object.fromEntries(await Promise.all(['postgres.ts','db.ts','auth.ts','messages.ts','ui-commands.ts'].map(async file=>[file,createHash('sha256').update(await readFile(resolve(sourceDirectory,file))).digest('hex')])));
    const report={createdAt:new Date().toISOString(),sourceSha256,environment:{node:process.version,platform:platform(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,postgres:(await pool.query('SHOW server_version')).rows[0].server_version},
      workload:{processes:2,users:8,repetitions:3,concurrency:[1,8,24],requestsPerPhase:192,writePercent:75,transport:'localhost HTTP, UI command batches + incremental snapshots',settlementTickMs:1000},phases,
      integrity:{concurrentRetries:32,retryCommits:1,overspendAttempts:24,overspendCommits:1,committedWrites:expectedWrites,journalEntries:exported.changes.length,accountsReplayed:accounts.length,passed:true}};
    await mkdir(dirname(output),{recursive:true}); await writeFile(output,JSON.stringify(report,null,2)+'\n');
    console.log(`PASS: load and replay checks; report ${output}`);
  } finally {
    if(sampleTimer)clearInterval(sampleTimer); await sampling;
    await Promise.all(children.map(child=>new Promise<void>(resolve=>{
      if(child.exitCode!==null){resolve();return;}
      const timer=setTimeout(()=>child.kill(),10000); child.once('exit',()=>{clearTimeout(timer);resolve();});
      if(child.connected)child.send('stop');else child.kill();
    })));
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
  }
}
