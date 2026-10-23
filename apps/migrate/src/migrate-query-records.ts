import {referenceKey,type Message,type Change} from '@gonglun/core';
import type {Store} from '../../server/src/db.js';
import {querySchema} from '../../server/src/query-schema.js';
import {archivedRoundReport} from './archived-round-report.js';
import {migrateMessageFormat} from './migrate-message-format.js';
import {initializeOrganizationMemberships} from './migrate-organization-memberships.js';
import {statesFor} from '../../server/src/projections.js';
import {validateRetirementJournal} from './validate-retirement-journal.js';

/** Materialize previous-release records in the current query schema once, without executing financial actions. */
export async function migrateQueryRecords(store:Store):Promise<void> {
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)) as Change);
  validateRetirementJournal({format:'gonglun-2',changes});
  await store.db.exec(querySchema);
  const retired = await store.db.prepare("SELECT value FROM settings WHERE key='retired-legacy-topics'").get();
  if(retired)await store.set('retired-organizations',JSON.parse(String(retired.value)));
  await store.db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
    UPDATE users u SET "createdAt"=COALESCE((SELECT old."createdAt" FROM legacy_users old WHERE old.id=u.id),
      (SELECT MIN(l."createdAt") FROM ledger l WHERE l."userId"=u.id),u."createdAt");
    INSERT INTO account_baselines SELECT "userId",COALESCE((body->>'totalEarned')::bigint,0),COALESCE((body->>'totalLost')::bigint,0)
      FROM legacy_accounts ON CONFLICT("userId") DO UPDATE SET earned=excluded.earned,lost=excluded.lost;
    INSERT INTO message_state_checkpoints SELECT "messageId",jsonb_build_object('supportCount',COALESCE(body->'agreeCount','0'),
      'oppositionCount',COALESCE(body->'disagreeCount','0'),'suppressed',COALESCE(body->'rejected','false')) FROM legacy_organization_states
      WHERE COALESCE(body->>'nativeOverride','false')<>'true' ON CONFLICT("messageId") DO NOTHING`);
  const rounds=await store.db.prepare('SELECT id,body FROM rounds ORDER BY position').all();
  const funded=new Set<string>();
  for (const row of rounds) {
    const round=JSON.parse(String(row.body));
    if(round.legacyHistory&&!round.legacyActive){
      const declaration=await store.message(String(row.id));
      const data=declaration.parts.find(part=>part.type==='data');
      const author=String(data?.type==='data'&&data.value&&typeof data.value==='object'&&!Array.isArray(data.value)?data.value.openedBy??declaration.authorId:declaration.authorId);
      const report=await archivedRoundReport(store,String(row.id),round,author);
      delete report.legacyHistory;
      await store.db.prepare('INSERT INTO published_round_reports VALUES($1,$2) ON CONFLICT(id) DO NOTHING').run(row.id,JSON.stringify(report));
      if(round.status!=='settled')round.status='frozen';
    }
    if(round.legacyActive){
      funded.add(`${round.subjectId??round.target.messageId}:${round.settlementType??'TRUTH'}`);
      round.targetKey=referenceKey(round.target);
      await store.db.prepare('UPDATE bets SET "targetKey"=$1 WHERE "roundId"=$2').run(round.targetKey,row.id);
    }
    for(const key of Object.keys(round))if(key.startsWith('legacy'))delete round[key];
    await store.db.prepare('UPDATE rounds SET "targetKey"=$1,body=$2 WHERE id=$3').run(round.targetKey,JSON.stringify(round),row.id);
  }
  await store.db.exec(`INSERT INTO stake_positions(id,"userId","subjectId","roundId","settlementType",side,amount,"createdAt",reference)
    SELECT b.id,b."userId",COALESCE(r.body::jsonb->>'subjectId',r.body::jsonb #>> '{target,messageId}'),b."roundId",
      COALESCE(r.body::jsonb->>'settlementType','TRUTH'),b.side,b.amount,m."createdAt",r.body::jsonb->'target'
      FROM bets b JOIN rounds r ON r.id=b."roundId" JOIN messages m ON m.id=b."messageId" ON CONFLICT(id) DO NOTHING;
    INSERT INTO stake_positions(id,"userId","subjectId","roundId","settlementType",side,amount,"createdAt")
      SELECT id,"userId","messageId","roundId",CASE WHEN "settlementType"='VALUE' THEN 'VALUE' ELSE 'TRUTH' END,
        CASE WHEN side='PRO' THEN 'pro' ELSE 'con' END,amount,"createdAt" FROM legacy_stakes ON CONFLICT(id) DO NOTHING`);
  for(const row of await store.db.prepare('SELECT * FROM legacy_pools').all()){
    if(funded.has(`${row.messageId}:${row.settlementType}`))continue;
    let pro=Number(row.lockedPro),con=Number(row.lockedCon);
    if(row.settlementType==='DELEGATION'){
      const escrow=await store.db.prepare('SELECT amount FROM escrows WHERE "messageId"=$1 AND "recipientId" IS NULL').get(row.messageId);
      const reward=Number(escrow?.amount??0);con=Math.max(0,con-Math.max(0,reward-pro));pro=Math.max(0,pro-reward);
    }
    await store.db.prepare('INSERT INTO pool_checkpoints VALUES($1,$2,$3,$4) ON CONFLICT("messageId","settlementType") DO NOTHING')
      .run(row.messageId,row.settlementType,pro,con);
  }
  for(const row of await store.db.prepare("SELECT key,body FROM effects WHERE key LIKE 'legacy-settlement:%'").all()){
    const policy=JSON.parse(String(row.body)),id=String(row.key).slice('legacy-settlement:'.length);
    const keys=(policy.activeTargets??[]).map((entry:any)=>referenceKey(entry.reference));
    await store.db.prepare('INSERT INTO settlement_access VALUES($1,$2) ON CONFLICT("messageId") DO NOTHING').run(id,keys);
  }
  const mode=await store.db.prepare("SELECT value FROM settings WHERE key='migration'").get();
  if(mode&&JSON.parse(String(mode.value)).mode==='read-only-rehearsal')await store.set('access-mode','read-only');
  await migrateMessageFormat(store);
  await store.db.exec('CREATE TABLE IF NOT EXISTS command_receipt_backups("userId" TEXT NOT NULL,"requestId" TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY("userId","requestId"))');
  for(const row of await store.db.prepare('SELECT * FROM command_requests').all()){
    const receipt=JSON.parse(String(row.result));
    if(receipt.projection)continue;
    const input=JSON.parse(String(row.input)),parents=[...new Set((input.commands??[]).map((command:any)=>command.body?.parentMessageId??'root'))];
    await store.db.prepare('INSERT INTO command_receipt_backups VALUES($1,$2,$3) ON CONFLICT DO NOTHING').run(row.userId,row.requestId,row.result);
    delete receipt.snapshots;receipt.projection={after:0,parents};
    await store.db.prepare('UPDATE command_requests SET result=$1 WHERE "userId"=$2 AND "requestId"=$3').run(JSON.stringify(receipt),row.userId,row.requestId);
  }
  await initializeOrganizationMemberships(store);
  const messages=(await store.db.prepare('SELECT body FROM messages ORDER BY id').all()).map(row=>JSON.parse(String(row.body)) as Message);
  if(messages.length){
    const previousSequence=await store.latestSequence();
    const sequence=Number((await store.db.prepare("INSERT INTO changes(body) VALUES('{}') RETURNING sequence").get())!.sequence);
    const change:Change={sequence,previousSequence,messages,memberships:[],removedMemberships:[],states:await statesFor(store,messages.map(message=>message.id)),
      ledger:[],treasury:{operating:await store.setting('operating'),issued:await store.setting('minted')}};
    await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change),sequence);
  }
}
