import { randomUUID } from 'node:crypto';
import type { Message } from '@gonglun/core';
import { Mutation, Store } from '../../server/src/db.js';
import { usagePointsSchema } from '../../server/src/usage-points.js';
import { archivedTableFingerprint, type ArchiveManifest } from './points-archive-integrity.js';

// Includes the complete journal and graph, so old balances can be independently reconstructed.
const archiveTables = ['accounts', 'ledger', 'settings', 'rule_versions', 'messages', 'revisions', 'changes',
  'bets', 'rounds', 'escrows', 'effects', 'stake_positions', 'pool_checkpoints', 'account_baselines',
  'message_state_checkpoints', 'published_round_reports', 'settlement_access', 'execution_stances',
  'display_stances', 'memberships', 'membership_actions', 'refs', 'signatures', 'requests', 'command_requests'] as const;

/** Called in the migration transaction. No economic state changes until every archived row is verified. */
export async function resetContributionPoints(store: Store): Promise<void> {
  await store.db.exec(usagePointsSchema);
  if (await store.db.prepare("SELECT 1 FROM settings WHERE key='usage-points-start'").get()) return;
  const previousSequence = await store.latestSequence(), createdAt = new Date().toISOString();
  const accounts = await store.db.prepare('SELECT "userId" FROM accounts ORDER BY "userId"').all<{userId:string}>();
  const rules = await store.rules();
  if (!accounts.length && !await store.setting<number>('minted')) {
    await store.set('rules', { ...rules, initialGrant: 0 });
    await store.set('usage-points-start', { sequence: previousSequence, ledgerPosition: 0, archiveId: null, createdAt });
    return;
  }
  const archiveId = randomUUID(), manifest: ArchiveManifest = {};
  await store.db.prepare('INSERT INTO points_archives VALUES($1,$2,$3,$4::jsonb)').run(archiveId, createdAt, previousSequence, '{}');
  for (const table of archiveTables) {
    await store.db.prepare(`INSERT INTO points_archive_rows("archiveId","tableName",body)
      SELECT $1,$2,to_jsonb(source) FROM ${table} source ${table === 'changes' ? 'ORDER BY source.sequence' : ''}`).run(archiveId, table);
    // EXCEPT ALL also detects missing or duplicated rows; equality is checked before clearing anything.
    const difference = await store.db.prepare(`SELECT 1 FROM (
      (SELECT to_jsonb(source) AS body FROM ${table} source EXCEPT ALL
        SELECT body FROM points_archive_rows WHERE "archiveId"=$1 AND "tableName"=$2)
      UNION ALL
      (SELECT body FROM points_archive_rows WHERE "archiveId"=$1 AND "tableName"=$2 EXCEPT ALL
        SELECT to_jsonb(source) AS body FROM ${table} source)
    ) differences LIMIT 1`).get(archiveId, table);
    if (difference) throw new Error(`旧贡献点归档校验失败：${table}`);
    manifest[table] = await archivedTableFingerprint(store, archiveId, table);
  }
  await store.db.prepare('UPDATE points_archives SET manifest=$2::jsonb WHERE id=$1').run(archiveId, JSON.stringify(manifest));
  const ledgerPosition = Number((await store.db.prepare('SELECT COALESCE(MAX(position),0) AS n FROM ledger').get())!.n);
  const tx = new Mutation(store);
  tx.pointsReset = { archiveId, userIds: accounts.map(row => row.userId) };
  await store.db.exec(`UPDATE accounts SET available=0,locked=0,earned=0,spent=0;
    DELETE FROM bets; DELETE FROM rounds; DELETE FROM escrows; DELETE FROM stake_positions;
    DELETE FROM pool_checkpoints; DELETE FROM account_baselines; DELETE FROM message_state_checkpoints;
    DELETE FROM published_round_reports;
    DELETE FROM effects WHERE key LIKE 'quality:%' OR key='operations:last';`);
  // Authorization markers and graph actions survive: old proposals must not execute twice.
  await store.set('operating', 0);
  await store.set('minted', 0);
  const nextRules = { ...rules, version: rules.version + 1, initialGrant: 0 };
  await store.set('rules', nextRules);
  await store.db.prepare('INSERT INTO rule_versions VALUES($1,$2,NULL,$3)').run(nextRules.version, JSON.stringify(nextRules), createdAt);
  const messages = await store.db.prepare('SELECT body FROM messages ORDER BY sequence,id').all();
  for (const row of messages) {
    const message = JSON.parse(String(row.body)) as Message;
    // Content, IDs, signatures and graph relations are retained. Only current spending is voided.
    if (Object.values(message.spending).some(amount => amount !== 0))
      await tx.put({ ...message, spending: { protocol: 0, recommendation: 0, wager: 0 } });
    else tx.affected.add(message.id);
  }
  const change = await tx.commit();
  await store.set('usage-points-start', { sequence: change.sequence, ledgerPosition, archiveId, createdAt });
}
