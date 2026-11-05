import { relations, targetInvestmentDimension, type Message } from '@gonglun/core';
import { Mutation, type Store } from '../../server/src/db.js';
import { chargeMessage } from '../../server/src/message-spending.js';
import { fundHistoricalMessageContribution, settleDue } from '../../server/src/economy.js';
import { isGeneratedContributionRecord } from './backfill-minimum-contributions.js';
import { archivedTableFingerprint, type ArchiveManifest } from './points-archive-integrity.js';
import { financialFingerprint } from './financial-fingerprint.js';

/** Select only messages in the cleared epoch. New publications and completed debits are never selected. */
async function candidates(store: Pick<Store, 'db'>) {
  const startRow = await store.db.prepare("SELECT value FROM settings WHERE key='usage-points-start'").get();
  const start = startRow && JSON.parse(String(startRow.value)) as { archiveId: string | null };
  if (!start?.archiveId) return { archiveId: null, messages: [] as Message[] };
  const audited = !!(await store.db.prepare("SELECT to_regclass('reset_message_contributions') AS name").get())?.name;
  const rows = await store.db.prepare(`SELECT m.body,archive.body->>'body' AS original
    FROM points_archive_rows archive JOIN messages m ON m.id=archive.body->>'id'
    JOIN accounts a ON a."userId"=m."authorId"
    WHERE archive."archiveId"=$1 AND archive."tableName"='messages'
      AND (m.body::jsonb #>> '{spending,protocol}')::bigint=0
      AND (m.body::jsonb #>> '{spending,recommendation}')::bigint=0
      AND (m.body::jsonb #>> '{spending,wager}')::bigint=0
      ${audited ? 'AND NOT EXISTS (SELECT 1 FROM reset_message_contributions done WHERE done."messageId"=m.id)' : ''}
    ORDER BY m.sequence,m.id`).all(start.archiveId);
  const messages: Message[] = [];
  for (const row of rows) {
    const original = JSON.parse(String(row.original)) as Message;
    if (await isGeneratedContributionRecord(store.db, original)) continue;
    messages.push(JSON.parse(String(row.body)) as Message);
  }
  return { archiveId: start.archiveId, messages };
}

export async function resetMessageContributionPlan(store: Pick<Store, 'db'>) {
  const { messages } = await candidates(store);
  const rules = JSON.parse(String((await store.db.prepare("SELECT value FROM settings WHERE key='rules'").get())!.value));
  return { pending: messages.length, minimumInvestment: 1, protocolFee: Number(rules.protocolFee),
    total: messages.length * (Number(rules.protocolFee) + 1), debtAllowed: true };
}

/** The old issuance stays cleared. Each paid user message receives one new minimum investment and fee. */
export async function fundResetMessageContributions(store: Store): Promise<number> {
  const { archiveId, messages } = await candidates(store);
  if (!archiveId || !messages.length) return 0;
  const archive = await store.db.prepare('SELECT manifest FROM points_archives WHERE id=$1').get(archiveId);
  const expected = (archive?.manifest as ArchiveManifest | undefined)?.messages;
  const actual = await archivedTableFingerprint(store, archiveId, 'messages');
  if (!expected || expected.count !== actual.count || expected.sha256 !== actual.sha256)
    throw new Error('旧消息归档校验失败，停止补扣');
  await store.db.exec(`CREATE TABLE IF NOT EXISTS reset_message_contributions(
    "messageId" TEXT PRIMARY KEY,"archiveId" TEXT NOT NULL,body JSONB NOT NULL,
    "ledgerIds" TEXT[] NOT NULL,sequence BIGINT NOT NULL)`);
  // Complete only current-era rounds that have already reached their cutoff before funding any new principal.
  const due = new Mutation(store);
  if (await settleDue(due)) await due.commit();
  const before = await financialFingerprint(store.db), ledgerStart = store.db.ledger.length;
  const protocolFee = (await store.rules()).protocolFee;
  let operatingDelta = 0;
  for (const original of messages) {
    const tx = new Mutation(store), message = structuredClone(original);
    const parts = relations(message);
    const value = parts.find(part => targetInvestmentDimension(part.relation) === 'VALUE' && part.roles.target?.length === 1);
    const truths = parts.filter(part => ['agree', 'disagree'].includes(part.relation) && part.roles.target?.length === 1);
    const action = value ?? truths.find(part => part.roles.target![0]!.reference.messageId !== message.id) ?? truths[0];
    const truth = !!action && ['agree', 'disagree'].includes(action.relation);
    message.spending = { protocol: protocolFee, recommendation: truth ? 0 : 1, wager: truth ? 1 : 0 };
    message.ruleVersion = (await store.rules()).version;
    await tx.put(message);
    await chargeMessage(store, message, !!value, true);
    if (action) await fundHistoricalMessageContribution(tx, message, action);
    operatingDelta += protocolFee + (action ? 0 : 1);
    const change = await tx.commit();
    await store.db.prepare('INSERT INTO reset_message_contributions VALUES($1,$2,$3::jsonb,$4,$5)')
      .run(message.id, archiveId, JSON.stringify(original), change.ledger.map(entry => entry.id), change.sequence);
    if (change.ledger.reduce((sum, entry) => sum + entry.amount, 0) !== -(protocolFee + 1))
      throw new Error('旧消息最低补扣金额不一致');
  }
  if (before !== await financialFingerprint(store.db, store.db.ledger.slice(ledgerStart), operatingDelta))
    throw new Error('旧消息补扣改变了预期之外的账户或旧账本');
  if ((await candidates(store)).messages.length) throw new Error('旧消息最低补扣仍有遗漏');
  return messages.length;
}
