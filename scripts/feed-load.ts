/** Isolated local discovery benchmark. Never connects to the deployment DATABASE_URL. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import request from 'supertest';
import type { Message, Session } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases } from '../apps/server/src/test-database.js';
import { Mutation } from '../apps/server/src/db.js';

const serve = process.argv.includes('--serve');
const discussion = process.argv.includes('--discussion');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : 'data/performance/feed.json';
if (!output) throw new Error('--output needs a filename');
const app = await createTestApp({ moderation: true });
try {
  const agent = request.agent(app);
  const registration = await agent.post('/api/register').send({ name: '首页体验', password: 'feed-local-preview' });
  if (registration.status !== 201) throw new Error(registration.text);
  const session = registration.body as Session;
  const samples = [
    '公论首页应该优先展示哪些讨论？我们希望用户进入后，能立即找到与自己有关的新进展，同时保留发现不同观点的机会。欢迎补充你的使用场景。',
    '如何判断一条新证据真正推动了讨论？除了支持与反对，还可以从来源、可核验程度和是否回答了原问题来观察。',
    '关于社区规则的修改提案：把讨论的理由和最终结论放在一起，方便后来的人理解决定是如何形成的。',
    '手机上阅读复杂讨论时，你更希望先看到摘要，还是直接进入消息图？这里收集不同设备上的实际体验。',
  ];
  let template!: Message;
  await app.store.transaction(async () => {
    const tx = new Mutation(app.store);
    template = await tx.create(session.user.id, [{ id: 'body', type: 'text', text: samples[0]! }]);
    await tx.commit();
  });
  async function grow(count: number) {
    for (let offset = 0; offset < count; offset += 250) await app.store.transaction(async () => {
      const tx = new Mutation(app.store);
      const values = Array.from({ length: Math.min(250, count - offset) }, (_, index): Message => ({ ...template,
        id: randomUUID(), sequence: 0, parts: [{ id: 'body', type: 'text', text: `${samples[(offset + index) % samples.length]}（讨论 ${offset + index + 1}）` }] }));
      const input = JSON.stringify(values.map(message => ({ id: message.id, authorId: message.authorId, createdAt: message.createdAt, body: JSON.stringify(message) })));
      await app.store.db.prepare(`INSERT INTO messages SELECT id,"authorId","createdAt",0,body
        FROM jsonb_to_recordset($1::jsonb) AS m(id text,"authorId" text,"createdAt" text,body text)`).run(input);
      await app.store.db.prepare(`INSERT INTO revisions("messageId",revision,body) SELECT id,1,body
        FROM jsonb_to_recordset($1::jsonb) AS m(id text,body text)`).run(input);
      values.forEach(message => { tx.messages.set(message.id, message); tx.affected.add(message.id); });
      await tx.commit();
    });
  }
  const results: Array<Record<string, unknown>> = [];
  let category: Message | undefined;
  async function measure(count: number, focus = template.id) {
    const times: number[] = [], database: number[] = [];
    let bytes = 0;
    for (let index = 0; index < 25; index++) {
      const start = performance.now(), response = discussion
        ? await agent.post('/api/ui/snapshot/discussion').send({focusId:focus}) : await agent.get('/api/ui/feed');
      if (response.status !== 200) throw new Error(response.text);
      times.push(performance.now() - start); bytes = Buffer.byteLength(response.text);
      database.push(Number(/db;dur=([\d.]+)/.exec(response.headers['server-timing'])?.[1]));
      if (discussion ? response.body.messages.length > 25 : response.body.items.length !== 20) throw new Error('Expected a bounded first page');
    }
    const percentile = (values: number[], fraction: number) => Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]! * 100) / 100;
    results.push({ messages: count, ...(discussion ? {scope:focus===template.id?'message':'classification'}:{}), requests: times.length, firstRequestMs: Math.round(times[0]! * 100) / 100,
      p50Ms: percentile(times, .5), p95Ms: percentile(times, .95), dbP95Ms: percentile(database, .95), responseBytes: bytes });
  }
  async function classify() {
    await app.store.transaction(async()=>{
      if (!category) {
        const tx=new Mutation(app.store);
        category=await tx.create(session.user.id,[{id:'title',type:'text',text:'讨论范围与分页体验'},{id:'category',type:'relation',relation:'classify',roles:{}}]);
        await tx.commit();
      }
      await app.store.db.prepare(`INSERT INTO memberships("memberId","parentId","sourceId")
        SELECT id,$1,$1 FROM messages WHERE "authorId"=$2 AND id<>ALL($3::text[]) ON CONFLICT("memberId") DO NOTHING`)
        .run(category!.id,session.user.id,[category!.id,template.id]);
    });
  }
  await grow(99); await measure(100);
  if (discussion) { await classify(); await measure(100,category!.id); }
  if (!serve) { await grow(9900); await measure(10000); if (discussion) { await classify(); await measure(10000,category!.id); } }
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify({ environment: 'isolated local PostgreSQL, moderation enabled, synthetic messages, sequential HTTP requests', results }, null, 2) + '\n');
  console.log(JSON.stringify({ results, output: resolve(output) }));
  if (serve) {
    app.use(express.static(resolve('frontend/dist')));
    app.get('*', (_req, res) => res.sendFile(resolve('frontend/dist/index.html')));
    const server = app.listen(5187, '127.0.0.1'); await once(server, 'listening');
    console.log('Local preview: http://127.0.0.1:5187/#/ — 首页体验 / feed-local-preview — enter q to close and clean up');
    if (category) console.log(`Discussion preview: http://127.0.0.1:5187/#/messages?msg=${category.id}`);
    await new Promise<void>(resolve => {
      const stop = () => {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        process.stdin.removeListener('data', input); process.stdin.pause(); resolve();
      };
      const input = (value: string) => { if (value.trim() === 'q') stop(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      process.stdin.setEncoding('utf8'); process.stdin.on('data', input); process.stdin.resume();
    });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
} finally { await cleanupTestDatabases(); }
