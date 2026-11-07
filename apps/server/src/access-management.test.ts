import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { cleanupTestDatabases, createTestApp, newTestSchema, testDatabaseUrl } from './test-database.js';
import { send } from './messages.js';
import { executeBatch } from './ui-commands.js';
import { updateUsagePoints, refreshUsagePoints } from './usage-points.js';
import { openMigratingStore } from '../../migrate/src/migrations.js';

afterEach(async () => { vi.restoreAllMocks(); await cleanupTestDatabases(); });

async function setup() {
  const schema = newTestSchema(), app = await createTestApp({databaseSchema:schema}), admin = request.agent(app);
  const registered = await admin.post('/api/register').send({name:'administrator',password:'test-password'});
  expect(registered.status,registered.text).toBe(201);
  const session = registered.body;
  const invite = async () => {
    const result = await admin.post('/api/admin/invites').set('x-csrf-token',session.csrf).send({expiresInDays:7});
    expect(result.status,result.text).toBe(200);
    return result.body as {code:string;invite:{id:string;expiresAt:string}};
  };
  const status = (id:string,disabled:boolean) => admin.post(`/api/admin/accounts/${id}/status`).set('x-csrf-token',session.csrf).send({disabled});
  return {app,admin,session,invite,status,schema};
}

it('requires an invitation after bootstrap, keeps codes private and permits exactly one registration across API instances', async () => {
  const t = await setup(), second = await createTestApp({databaseSchema:t.schema});
  expect((await request(t.app).get('/api/setup')).body).toMatchObject({initialized:true,inviteRequired:true});
  for (const inviteCode of [undefined,'forged-invitation']) {
    expect((await request(t.app).post('/api/register').send({name:'uninvited',password:'password',inviteCode})).status).toBe(403);
  }
  const invitation = await t.invite();
  const raw = await t.app.store.db.prepare('SELECT * FROM registration_invites WHERE id=$1').get(invitation.invite.id);
  expect(JSON.stringify(raw)).not.toContain(invitation.code);
  const attempts = await Promise.all([t.app,second].map((app,index) => request(app).post('/api/register')
    .send({name:`invited-${index}`,password:'password',inviteCode:invitation.code})));
  expect(attempts.map(result=>result.status).sort()).toEqual([201,403]);
  const winner = attempts.find(result=>result.status===201)!.body.user;
  const listing = await t.admin.get('/api/admin/invites');
  expect(listing.body.items).toEqual([expect.objectContaining({id:invitation.invite.id,status:'used',usedBy:winner.id,usedByName:winner.name})]);
  expect(listing.text).not.toContain(invitation.code);
  expect(listing.text).not.toContain('tokenHash');
  const exported = await request(t.app).get('/api/export');
  expect(exported.text).not.toContain(invitation.code);
  expect(exported.text).not.toContain(invitation.invite.id);
  expect((await t.admin.post(`/api/admin/invites/${invitation.invite.id}/revoke`).set('x-csrf-token',t.session.csrf).send({})).status).toBe(409);
});

it('rejects expired and revoked invitations and rolls consumption back when registration fails', async () => {
  const t = await setup(), expired = await t.invite(), revoked = await t.invite(), retry = await t.invite();
  await t.app.store.db.prepare('UPDATE registration_invites SET "expiresAt"=$2 WHERE id=$1').run(expired.invite.id,'2000-01-01T00:00:00.000Z');
  const revoke = () => t.admin.post(`/api/admin/invites/${revoked.invite.id}/revoke`).set('x-csrf-token',t.session.csrf).send({});
  expect((await revoke()).status).toBe(200); expect((await revoke()).status).toBe(200);
  for (const entry of [expired,revoked]) expect((await request(t.app).post('/api/register').send({name:'rejected',password:'password',inviteCode:entry.code})).status).toBe(403);
  expect((await request(t.app).post('/api/register').send({name:'administrator',password:'password',inviteCode:retry.code})).status).toBe(409);
  await t.app.store.db.exec(`CREATE FUNCTION reject_invited_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic session failure'; END; $$;
    CREATE TRIGGER reject_invited_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION reject_invited_session();`);
  vi.spyOn(console,'error').mockImplementation(()=>{});
  expect((await request(t.app).post('/api/register').send({name:'retry-user',password:'password',inviteCode:retry.code})).status).toBe(500);
  expect(await t.app.store.db.prepare('SELECT "usedAt","usedBy" FROM registration_invites WHERE id=$1').get(retry.invite.id)).toEqual({usedAt:null,usedBy:null});
  expect(await t.app.store.db.prepare('SELECT id FROM users WHERE name=$1').get('retry-user')).toBeUndefined();
  await t.app.store.db.exec('DROP TRIGGER reject_invited_session ON sessions');
  expect((await request(t.app).post('/api/register').send({name:'retry-user',password:'password',inviteCode:` ${retry.code} `})).status).toBe(201);
  const listing = await t.admin.get('/api/admin/invites?limit=1');
  expect(listing.body.items).toHaveLength(1);
  const next = await t.admin.get(`/api/admin/invites?before=${listing.body.nextCursor}`);
  expect(next.body.items.map((row:{status:string})=>row.status)).toEqual(['revoked','expired']);
});

it('enforces administrator permissions and CSRF, protects the administrator and validates expiry', async () => {
  const t = await setup(), invitation = await t.invite(), member = request.agent(t.app);
  const joined = await member.post('/api/register').send({name:'member',password:'password',inviteCode:invitation.code});
  for (const path of ['/api/admin/invites','/api/admin/accounts']) {
    expect((await request(t.app).get(path)).status).toBe(401);
    expect((await member.get(path)).status).toBe(403);
  }
  expect((await member.post('/api/admin/invites').set('x-csrf-token',joined.body.csrf).send({expiresInDays:7})).status).toBe(403);
  expect((await member.post(`/api/admin/accounts/${t.session.user.id}/status`).set('x-csrf-token',joined.body.csrf).send({disabled:true})).status).toBe(403);
  expect((await member.post(`/api/admin/invites/${invitation.invite.id}/revoke`).set('x-csrf-token',joined.body.csrf).send({})).status).toBe(403);
  expect((await t.admin.post('/api/admin/invites').send({expiresInDays:7})).status).toBe(403);
  expect((await t.status(t.session.user.id,true)).status).toBe(403);
  for (const expiresInDays of [0,366,1.5,'7']) expect((await t.admin.post('/api/admin/invites').set('x-csrf-token',t.session.csrf).send({expiresInDays})).status).toBe(400);
  expect((await t.admin.get('/api/admin/accounts?q=member')).body.items).toEqual([expect.objectContaining({id:joined.body.user.id,disabledAt:null,founder:false})]);
});

it('disables every session, blocks queued writes and new logins, and restores access only after a fresh login', async () => {
  const t = await setup(), invitation = await t.invite(), member = request.agent(t.app), otherDevice = request.agent(t.app);
  const joined = await member.post('/api/register').send({name:'member',password:'password',inviteCode:invitation.code});
  const user = joined.body.user, account = joined.body.account;
  await otherDevice.post('/api/login').send({name:'member',password:'password'});
  expect((await member.post('/api/ui/points/activity').set('x-csrf-token',joined.body.csrf).send({action:'start'})).status).toBe(200);
  expect((await t.status(user.id,true)).status).toBe(200);
  expect(await t.app.store.db.prepare('SELECT 1 FROM sessions WHERE "userId"=$1').get(user.id)).toBeUndefined();
  for (const agent of [member,otherDevice]) {
    expect((await agent.get('/api/session')).body).toBeNull();
    expect((await agent.get('/api/ui/reading-state')).status).toBe(401);
    expect((await agent.post('/api/messages').set('x-csrf-token',joined.body.csrf).send({})).status).toBe(401);
  }
  const login = await member.post('/api/login').send({name:'member',password:'password'});
  expect(login.status).toBe(403); expect(login.body.code).toBe('ACCOUNT_DISABLED');
  await expect(send(t.app.store,user,{requestId:randomUUID(),parts:[{id:'text',type:'text',text:'late send'}],recommendation:1})).rejects.toThrow('已停用');
  await expect(executeBatch(t.app.store,user,{requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path:'/messages',body:{content:'late batch',recommendation:1}}]})).rejects.toThrow('已停用');
  await expect(updateUsagePoints(t.app.store,user.id,{action:'start'})).rejects.toThrow('已停用');
  await refreshUsagePoints(t.app.store,Date.now()+86400000);
  expect(await t.app.store.account(user.id)).toEqual(account);
  expect((await t.status(user.id,false)).status).toBe(200);
  expect((await otherDevice.get('/api/session')).body).toBeNull();
  const restored = await member.post('/api/login').send({name:'member',password:'password'});
  expect(restored.status,restored.text).toBe(200);
  expect((await member.get('/api/session')).body.user.id).toBe(user.id);
  expect((await t.admin.get('/api/admin/accounts?q=member')).body.items[0].disabledAt).toBeNull();
});

it('upgrades a version 34 database without changing existing users, sessions or balances', async () => {
  const t = await setup(), before = await t.app.store.account(t.session.user.id);
  await t.app.store.db.exec('DROP TABLE registration_invites,disabled_accounts,access_admin_actions; DELETE FROM schema_migrations WHERE version=35;');
  const upgraded = await openMigratingStore(testDatabaseUrl(),{schema:t.schema});
  try {
    expect(await upgraded.account(t.session.user.id)).toEqual(before);
    expect((await t.admin.get('/api/session')).body.user.id).toBe(t.session.user.id);
    expect((await request(t.app).post('/api/register').send({name:'no-invite',password:'password'})).status).toBe(403);
    expect((await t.invite()).code).toBeTruthy();
  } finally { await upgraded.close(); }
});

it('restarts a restored account with a fresh round and the full earned-point waiting time', async () => {
  const t = await setup(), invitation = await t.invite();
  const joined = await request(t.app).post('/api/register').send({name:'returning-member',password:'password',inviteCode:invitation.code});
  expect(joined.status,joined.text).toBe(201);
  const userId = joined.body.user.id, at = Date.parse('2026-11-07T04:00:00.000Z');
  const first = await updateUsagePoints(t.app.store,userId,{action:'start'},at);
  const second = await updateUsagePoints(t.app.store,userId,{action:'tick',roundId:first.roundId},at+1000);
  const waiting = await updateUsagePoints(t.app.store,userId,{action:'tick',roundId:second.roundId},at+3000);
  expect(waiting).toMatchObject({earned:2,waitSeconds:3,remainingMs:3000});
  expect((await t.status(userId,true)).status).toBe(200);
  expect((await t.status(userId,false)).status).toBe(200);
  const resumed = await updateUsagePoints(t.app.store,userId,{action:'start'},at+4000);
  expect(resumed).toMatchObject({earned:2,waitSeconds:3,remainingMs:3000,awarded:false});
  expect(resumed.roundId).not.toBe(waiting.roundId);
  expect(await updateUsagePoints(t.app.store,userId,{action:'tick',roundId:resumed.roundId},at+5000))
    .toMatchObject({earned:2,remainingMs:2000,awarded:false});
  expect(await updateUsagePoints(t.app.store,userId,{action:'tick',roundId:resumed.roundId},at+7000))
    .toMatchObject({earned:3,awarded:true});
});
