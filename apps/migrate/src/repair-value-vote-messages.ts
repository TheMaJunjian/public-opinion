import { referenceKey, relations, resolveReference, textOf, type Change, type Message, type Reference } from '@gonglun/core';
import type { Store } from '../../server/src/db.js';
import type { Postgres } from '../../server/src/postgres.js';
import { partsSchema } from '../../server/src/validation.js';
import { recordPersonal } from '../../server/src/personal-actions.js';
import { statesFor } from '../../server/src/projections.js';
import { createHash } from 'node:crypto';
import { financialFingerprint } from './financial-fingerprint.js';

type Round = { id: string; target: Reference; subjectId?: string; settlementType?: string };
type Repair = { partId: string; relation: 'recommend' | 'archive'; subject: Reference };
const dataOf = (message: Message) => Object.assign({}, ...message.parts.flatMap(part => part.type === 'data'
  && part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));

/** Exact stored round/execution addresses are evidence; ordinary truth votes and body discussions stay intact. */
async function prepareRepair(db: Postgres) {
  const latest = new Map((await db.prepare('SELECT body FROM messages').all()).map(row => {
    const message = JSON.parse(String(row.body)) as Message; return [message.id, message];
  }));
  const originals = new Map((await db.prepare('SELECT body FROM revisions').all()).map(row => {
    const message = JSON.parse(String(row.body)) as Message; return [`${message.id}:${message.revision}`, message];
  }));
  const resolve = (id: string, revision?: number) => revision ? originals.get(`${id}:${revision}`) : latest.get(id);
  const pinned = (reference: Reference): Reference => ({ ...reference, revision: reference.revision ?? resolve(reference.messageId)?.revision });
  const rounds = (await db.prepare('SELECT body FROM rounds').all()).map(row => JSON.parse(String(row.body)) as Round);
  const valueRounds = rounds.filter(round => round.settlementType === 'VALUE');
  const byId = new Map(rounds.map(round => [round.id, round]));
  const executions = new Map((await db.prepare('SELECT * FROM execution_stances').all()).map(row =>
    [`${row.sourceId}:${row.revision}:${row.partId}`, { target: JSON.parse(String(row.target)) as Reference, side: String(row.side) }]));
  const valueBets = new Map<string, Set<string>>();
  for (const row of await db.prepare('SELECT "messageId","roundId" FROM bets').all()) if (byId.get(String(row.roundId))?.settlementType === 'VALUE') {
    const ids = valueBets.get(String(row.messageId)) ?? new Set<string>(); ids.add(String(row.roundId)); valueBets.set(String(row.messageId), ids);
  }
  const repairs = new Map<string, Repair>(), unresolved: Array<{ id: string; reason: string }> = [];
  for (const [version, message] of originals) {
    const stance = relations(message).find(part => part.relation !== 'member-of' || part.roles.member?.length);
    if (!stance || !['agree', 'disagree'].includes(stance.relation) || stance.roles.target?.length !== 1) continue;
    const execution = executions.get(`${version}:${stance.id}`);
    const target = execution?.target ?? stance.roles.target[0]!.reference;
    const requestedId = dataOf(message).roundId;
    const requested = typeof requestedId === 'string' ? byId.get(requestedId) : undefined;
    if (requested && requested.settlementType !== 'VALUE') continue;
    const evaluated = resolve(target.messageId, target.revision);
    const nativeValueClaim = evaluated && relations(evaluated).some(part => part.relation === 'open-value-settlement'
      && (!target.partId || target.partId === part.id) && !target.range && !target.memberId && !target.path?.length);
    // Closed legacy truth/value rounds can share a whole-message address. That alone never proves a value vote.
    if (!requested && !nativeValueClaim && !valueBets.has(message.id)) continue;
    const matching = valueRounds.filter(round => referenceKey(pinned(round.target)) === referenceKey(pinned(target))
      && (requested || nativeValueClaim || valueBets.get(message.id)?.has(round.id)));
    if (!matching.length && requested?.settlementType !== 'VALUE') continue;
    try {
      if (requested && !matching.some(round => round.id === requested.id)) throw new Error('投票执行地址与原价值轮次不一致');
      const subjects = matching.filter(round => !requested || round.id === requested.id).map(round => {
        const evaluated = resolve(round.target.messageId, round.target.revision);
        const claim = evaluated && relations(evaluated).find(part => part.relation === 'open-value-settlement'
          && (!round.target.partId || round.target.partId === part.id));
        const basis = claim?.roles.target?.[0]?.reference;
        const subject = basis ?? (round.subjectId === round.target.messageId ? {
          messageId: round.subjectId, revision: round.target.revision,
        } : undefined);
        if (!subject || resolveReference(subject, resolve) === undefined) throw new Error('缺少可解析的原始价值评价目标');
        return subject;
      });
      if (!subjects.length || new Set(subjects.map(referenceKey)).size !== 1) throw new Error('价值投票存在冲突的原始目标');
      const side = execution?.side ?? (stance.relation === 'agree' ? 'pro' : 'con');
      repairs.set(version, { partId: stance.id, relation: side === 'pro' ? 'recommend' : 'archive', subject: subjects[0]! });
    } catch (error) { unresolved.push({ id: message.id, reason: (error as Error).message }); }
  }
  const ids = [...new Set([...repairs.keys()].map(version => originals.get(version)!.id))];
  const summary = { pending: ids.length, revisions: repairs.size,
    recommendations: [...repairs.values()].filter(repair => repair.relation === 'recommend').length,
    archives: [...repairs.values()].filter(repair => repair.relation === 'archive').length,
    unresolved: unresolved.length, sampleIds: ids.slice(0, 10), unresolvedSamples: unresolved.slice(0, 10) };
  return { latest, originals, repairs, summary, resolve };
}

export async function valueVoteMessageRepairPlan(db: Postgres) {
  return (await prepareRepair(db)).summary;
}

export async function voteContractFingerprint(db: Postgres) {
  const hash = createHash('sha256');
  for (const [table, order] of [['rounds', 'id'], ['bets', 'id'], ['stake_positions', 'id'],
    ['execution_stances', '"sourceId",revision,"partId"'], ['signatures', '"messageId"']]) {
    hash.update(table);
    for (const row of await db.prepare(`SELECT row_to_json(t) body FROM ${table} t ORDER BY ${order}`).all()) hash.update(JSON.stringify(row.body));
  }
  return hash.digest('hex');
}

/** Format-only, repeatable repair: never send a message, debit an account or execute a wager/settlement. */
export async function repairValueVoteMessages(store: Store): Promise<number> {
  const prepared = await prepareRepair(store.db);
  const { originals, repairs, summary, resolve } = prepared;
  if (summary.unresolved) throw new Error(`价值投票消息迁移无法确认 ${summary.unresolved} 个原始目标：${JSON.stringify(summary.unresolvedSamples)}`);
  if (!repairs.size) return 0;
  const moneyBefore = await financialFingerprint(store.db), contractsBefore = await voteContractFingerprint(store.db);
  function transform(input: any): any {
    if (Array.isArray(input)) return input.map(transform);
    if (!input || typeof input !== 'object') return input;
    if (typeof input.id !== 'string' || !Array.isArray(input.parts))
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, key === 'input' || key === 'sourceAudit' ? value : transform(value)]));
    const repair = repairs.get(`${input.id}:${input.revision}`);
    if (!repair) return input;
    const message = structuredClone(input) as Message;
    const stance = relations(message).find(part => part.id === repair.partId);
    if (!stance || !['agree', 'disagree'].includes(stance.relation)) return input;
    stance.relation = repair.relation;
    stance.roles.target = [{ id: stance.roles.target![0]!.id, reference: repair.subject }];
    const meta = message.parts.find(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value));
    if (meta?.type === 'data') meta.value = { ...(meta.value as object), uiType: repair.relation.toUpperCase() };
    else {
      let id = 'vote-data'; for (let i = 1; message.parts.some(part => part.id === id); i++) id = `vote-data-${i}`;
      message.parts.push({ id, type: 'data', value: { uiType: repair.relation.toUpperCase() } });
    }
    partsSchema.parse(message.parts);
    // Committed response caches contain both native parts and their transport projection.
    if ('relationType' in input) {
      const subject = resolve(repair.subject.messageId, repair.subject.revision)!;
      const target = repair.subject.range ? { kind: 'text-fragment', messageId: subject.id,
        text: String(resolveReference(repair.subject, resolve)), hash: `${subject.id}:${subject.revision}:${repair.subject.partId}:${repair.subject.range.start}:${repair.subject.range.end}`, reference: repair.subject }
        : relations(subject).some(part => part.relation !== 'member-of' || part.roles.member?.length)
          ? { kind: 'relation', relationId: subject.id, part: repair.subject.partId ? 'label' : 'whole', reference: repair.subject }
          : { kind: 'message', messageId: subject.id, reference: repair.subject };
      Object.assign(message, { relationType: repair.relation.toUpperCase(), targetRefs: [target], declaredTargetRefs: [target],
        content: textOf(message) || `${repair.relation === 'recommend' ? '推荐' : '冷藏'}：「${textOf(subject).slice(0, 120) || '消息'}」` });
      for (const key of ['payload', 'relationPayload']) if (key in input)
        (message as any)[key] = { ...input[key] };
    }
    return message;
  }
  const tables = [
    { name: 'messages', column: 'body', key: 'id' },
    { name: 'revisions', column: 'body', key: 'jsonb_build_array("messageId",revision)::text' },
    { name: 'changes', column: 'body', key: 'sequence::text' },
    { name: 'requests', column: 'result', key: 'jsonb_build_array("userId","requestId")::text' },
    { name: 'command_requests', column: 'result', key: 'jsonb_build_array("userId","requestId")::text' },
  ];
  await store.db.exec('CREATE TABLE IF NOT EXISTS value_vote_message_backups(table_name TEXT NOT NULL,row_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(table_name,row_key))');
  const changed: Message[] = [];
  for (const table of tables) for (const row of await store.db.prepare(`SELECT ${table.key} row_key,${table.column} body FROM ${table.name}`).all()) {
    const old = JSON.parse(String(row.body)), upgraded = transform(old);
    if (JSON.stringify(old) === JSON.stringify(upgraded)) continue;
    await store.db.prepare('INSERT INTO value_vote_message_backups VALUES($1,$2,$3) ON CONFLICT DO NOTHING').run(table.name, row.row_key, row.body);
    await store.db.prepare(`UPDATE ${table.name} SET ${table.column}=$1 WHERE ${table.key}=$2`).run(JSON.stringify(upgraded), row.row_key);
    if (table.name === 'messages') {
      changed.push(upgraded);
      await store.db.prepare('DELETE FROM refs WHERE "sourceId"=$1').run(upgraded.id);
      const targets = new Set(relations(upgraded).flatMap(part => Object.values(part.roles).flat().map(binding => binding.reference.messageId)));
      for (const part of upgraded.parts) if (part.type === 'display' && part.target) targets.add(part.target.messageId);
      for (const target of targets) await store.db.prepare('INSERT INTO refs VALUES($1,$2) ON CONFLICT DO NOTHING').run(upgraded.id, target);
    }
  }
  for (const version of repairs.keys()) {
    const original = originals.get(version)!;
    if (original.revision === 1) await recordPersonal(store, transform(original));
  }
  const remaining = await valueVoteMessageRepairPlan(store.db);
  if (remaining.pending || remaining.unresolved) throw new Error('价值投票消息修复后仍有遗漏');
  const previousSequence = await store.latestSequence();
  const sequence = Number((await store.db.prepare("INSERT INTO changes(body) VALUES('{}') RETURNING sequence").get())!.sequence);
  const affected = [...new Set([...changed.map(message => message.id), ...[...repairs.values()].map(repair => repair.subject.messageId)])];
  const change: Change = { sequence, previousSequence, messages: changed, memberships: [], removedMemberships: [],
    states: await statesFor(store, affected), ledger: [], treasury: { operating: await store.setting('operating'), issued: await store.setting('minted') } };
  await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change), sequence);
  if (moneyBefore !== await financialFingerprint(store.db) || contractsBefore !== await voteContractFingerprint(store.db))
    throw new Error('价值投票格式迁移改变了资金、轮次、押注或签名，已中止');
  return summary.pending;
}
