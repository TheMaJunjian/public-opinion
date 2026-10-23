import { annotationAtReference, oppositeAnnotation, relations, type Message, type Part, type Change } from '@gonglun/core';
import type { Store } from '../../server/src/db.js';
import type { Postgres } from '../../server/src/postgres.js';
import { recordPersonal } from '../../server/src/personal-actions.js';
import { statesFor } from '../../server/src/projections.js';
import { messageView } from '../../server/src/ui-projections.js';
import { partsSchema } from '../../server/src/validation.js';
import { financialFingerprint } from './financial-fingerprint.js';
import { voteContractFingerprint } from './repair-value-vote-messages.js';

async function prepareRepair(db: Postgres) {
  const originals = new Map((await db.prepare('SELECT body FROM revisions').all()).map(row => {
    const message = JSON.parse(String(row.body)) as Message; return [`${message.id}:${message.revision}`, message];
  }));
  const latest = new Map((await db.prepare('SELECT body FROM messages').all()).map(row => {
    const message = JSON.parse(String(row.body)) as Message; return [message.id, message];
  }));
  const converted = new Map<string, Message>(), visiting = new Set<string>();
  const unresolved: Array<{ id: string; reason: string }> = [];
  function convert(message: Message): Message {
    const key = `${message.id}:${message.revision}`;
    if (converted.has(key)) return converted.get(key)!;
    if (visiting.has(key)) return message;
    visiting.add(key);
    try {
      const stance = relations(message).find(part => part.relation !== 'member-of' || part.roles.member?.length);
      if (!stance || !['agree', 'disagree'].includes(stance.relation) || stance.roles.target?.length !== 1) return message;
      const reference = stance.roles.target[0]!.reference;
      const original = reference.revision ? originals.get(`${reference.messageId}:${reference.revision}`) : latest.get(reference.messageId);
      if (!original) return message;
      const annotation = annotationAtReference(convert(original), reference);
      if (!annotation) return message;
      const action = stance.relation === 'agree' ? annotation : oppositeAnnotation(annotation);
      // An old objection to a custom tag has no defined inverse; retain that historical statement.
      if (!action) return message;
      if (!action.targets.length) throw new Error('原标注缺少目标');
      const upgraded = structuredClone(message), part = relations(upgraded).find(part => part.id === stance.id)!;
      part.relation = action.relation;
      const used = new Set(Object.entries(part.roles).flatMap(([role, bindings]) => role === 'target' ? [] : bindings.map(binding => binding.id)));
      part.roles.target = action.targets.map((reference, index) => {
        let id = index === 0 ? stance.roles.target![0]!.id : `annotation-target-${index}`;
        for (let attempt = 1; used.has(id); attempt++) id = `annotation-target-${index}-${attempt}`;
        used.add(id); return { id, reference };
      });
      if (action.relation === 'follow' || action.relation === 'block') part.reason = action.payload.subType as 'YES' | 'NO';
      else delete part.reason;
      const meta = upgraded.parts.find(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value));
      const payload = Object.fromEntries(['label', 'subType', 'customLabel'].flatMap(key => {
        const value = action.payload[key as keyof typeof action.payload]; return value === undefined ? [] : [[key, value]];
      }));
      const value = { ...(meta?.type === 'data' ? meta.value as object : {}), ...payload,
        uiType: action.relation === 'follow' ? 'ATTENTION' : action.relation.toUpperCase(),
        annotationStance: { target: { ...reference }, side: stance.relation === 'agree' ? 'pro' : 'con' } };
      if (meta?.type === 'data') meta.value = value;
      else {
        let id = 'annotation-data'; for (let index = 1; upgraded.parts.some(part => part.id === id); index++) id = `annotation-data-${index}`;
        upgraded.parts.push({ id, type: 'data', value });
      }
      partsSchema.parse(upgraded.parts);
      converted.set(key, upgraded);
      return upgraded;
    } catch (error) {
      unresolved.push({ id: message.id, reason: (error as Error).message }); return message;
    } finally { visiting.delete(key); }
  }
  for (const message of originals.values()) convert(message);
  const ids = [...new Set([...converted.values()].map(message => message.id))];
  return { originals, latest, converted, summary: { pending: ids.length, revisions: converted.size,
    unresolved: unresolved.length, sampleIds: ids.slice(0, 10), unresolvedSamples: unresolved.slice(0, 10) } };
}

export async function annotationStanceMessageRepairPlan(db: Postgres) { return (await prepareRepair(db)).summary; }

/** Restore native annotation semantics and remove obsolete truth decorations without re-executing funds. */
export async function repairAnnotationStanceMessages(store: Store): Promise<number> {
  const { converted, summary } = await prepareRepair(store.db);
  if (summary.unresolved) throw new Error(`历史标注表态迁移无法确认原始目标：${JSON.stringify(summary.unresolvedSamples)}`);
  if (!converted.size) return 0;
  const moneyBefore = await financialFingerprint(store.db), contractsBefore = await voteContractFingerprint(store.db);
  // Project references before writing so both original and converted history addresses remain resolvable.
  const projections = new Map<string, { relationType: string; targetRefs: unknown[]; payload: Record<string, unknown>; content: string }>();
  for (const [key, message] of converted) {
    const view = await messageView(store, message);
    projections.set(key, { relationType: view.relationType!, targetRefs: view.targetRefs, payload: { ...view.payload }, content: view.content });
  }
  function transform(input: any): any {
    if (Array.isArray(input)) return input.map(transform);
    if (!input || typeof input !== 'object') return input;
    if (typeof input.id !== 'string' || !Array.isArray(input.parts)) return Object.fromEntries(Object.entries(input)
      .map(([key, value]) => [key, key === 'input' || key === 'sourceAudit' ? value : transform(value)]));
    const key = `${input.id}:${input.revision}`, message = converted.get(key);
    if (!message) return input;
    const result = { ...input, parts: message.parts };
    if ('relationType' in input) {
      const projection = projections.get(key)!;
      Object.assign(result, projection, { declaredTargetRefs: projection.targetRefs, relationPayload: projection.payload });
    }
    return result;
  }
  await store.db.exec('CREATE TABLE IF NOT EXISTS annotation_stance_message_backups(table_name TEXT NOT NULL,row_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(table_name,row_key))');
  const backup = (table: string, key: string, body: string) => store.db.prepare('INSERT INTO annotation_stance_message_backups VALUES($1,$2,$3) ON CONFLICT DO NOTHING').run(table, key, body);
  const changed: Message[] = [], affected = new Set<string>();
  for (const table of [
    { name: 'messages', column: 'body', key: 'id' },
    { name: 'revisions', column: 'body', key: 'jsonb_build_array("messageId",revision)::text' },
    { name: 'changes', column: 'body', key: 'sequence::text' },
    { name: 'requests', column: 'result', key: 'jsonb_build_array("userId","requestId")::text' },
    { name: 'command_requests', column: 'result', key: 'jsonb_build_array("userId","requestId")::text' },
  ]) for (const row of await store.db.prepare(`SELECT ${table.key} row_key,${table.column} body FROM ${table.name}`).all()) {
    const old = JSON.parse(String(row.body)), upgraded = transform(old);
    if (JSON.stringify(old) === JSON.stringify(upgraded)) continue;
    await backup(table.name, String(row.row_key), String(row.body));
    await store.db.prepare(`UPDATE ${table.name} SET ${table.column}=$1 WHERE ${table.key}=$2`).run(JSON.stringify(upgraded), row.row_key);
    if (table.name === 'messages') {
      changed.push(upgraded); affected.add(upgraded.id);
      await store.db.prepare('DELETE FROM refs WHERE "sourceId"=$1').run(upgraded.id);
      const targets = new Set<string>((upgraded.parts as Part[]).flatMap(part => part.type === 'relation' ? Object.values(part.roles).flat().map(binding => binding.reference.messageId)
        : part.type === 'display' && part.target ? [part.target.messageId] : []));
      for (const target of targets) { affected.add(target); await store.db.prepare('INSERT INTO refs VALUES($1,$2) ON CONFLICT DO NOTHING').run(upgraded.id, target); }
    }
  }
  for (const message of converted.values()) if (message.revision === 1) {
    // The source now expresses an annotation, so its old agree/disagree count must disappear as well.
    for (const row of await store.db.prepare('SELECT * FROM display_stances WHERE "sourceId"=$1').all(message.id)) {
      await backup('display_stances', message.id, JSON.stringify(row)); affected.add(String(row.targetId));
      const checkpoint = await store.db.prepare('SELECT * FROM message_state_checkpoints WHERE "messageId"=$1').get(row.targetId);
      if (checkpoint) await backup('message_state_checkpoints', String(row.targetId), JSON.stringify(checkpoint));
      await store.db.prepare('DELETE FROM message_state_checkpoints WHERE "messageId"=$1').run(row.targetId);
    }
    await store.db.prepare('DELETE FROM display_stances WHERE "sourceId"=$1').run(message.id);
    await recordPersonal(store, message);
  }
  const remaining = await annotationStanceMessageRepairPlan(store.db);
  if (remaining.pending || remaining.unresolved) throw new Error('历史标注表态迁移后仍有遗漏');
  const previousSequence = await store.latestSequence();
  const sequence = Number((await store.db.prepare("INSERT INTO changes(body) VALUES('{}') RETURNING sequence").get())!.sequence);
  const change: Change = { sequence, previousSequence, messages: changed, memberships: [], removedMemberships: [], states: await statesFor(store, [...affected]),
    ledger: [], treasury: { operating: await store.setting('operating'), issued: await store.setting('minted') } };
  await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change), sequence);
  if (moneyBefore !== await financialFingerprint(store.db) || contractsBefore !== await voteContractFingerprint(store.db)) throw new Error('历史标注表态迁移改变了资金或原押注合同');
  return summary.pending;
}
