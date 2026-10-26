import { annotationValueSide, bindRoles, referenceKey, relations, resolveStance, textOf, type Allocation, type Distribution, type Json, type Message, type Reference, type RelationPart, type Round } from '@gonglun/core';
import { DomainError, id, integer, Mutation, now, Store } from './db.js';
import { recordStance } from './projections.js';
import { validateJoinApproval } from './organizations.js';

type Bet={id:string;roundId:string;targetKey:string;userId:string;messageId:string;side:'pro'|'con';amount:number};
type SavedRound=Round&{targetKey:string;payouts:Allocation[];betIds:string[];createdAt:string;settlementType?:'TRUTH'|'VALUE';subjectId?:string};
type QualityEffect={userId:string;messageId:string;amount:number;active:boolean};
type Escrow={messageId:string;ownerId:string;amount:number;recipientId:string|null;fulfillmentId:string|null};
export function dataOf(message:Message):Record<string,Json> {
  const value=message.parts.find(p=>p.type==='data');
  return value?.type==='data'&&value.value&&typeof value.value==='object'&&!Array.isArray(value.value)?value.value:{};
}
export function oneTarget(message:Message,name:string,role='target'):Reference {
  const relation=relations(message).find(r=>r.relation===name);
  if(!relation)throw new DomainError(`${name} 关系不存在`);
  return relationTarget(relation,role);
}
export function relationTarget(relation:RelationPart,role='target'):Reference {
  if(relation.roles[role]?.length!==1) throw new DomainError(`${relation.relation} 必须指定唯一 ${role}`);
  return relation.roles[role]![0]!.reference;
}
export async function distribution(tx: Mutation, target: Reference | undefined, value: Omit<Distribution, 'ledgerId' | 'programVersion'>): Promise<Message> {
    integer(value.total);
    const labels: Record<Distribution['source'], string> = { wager: '对赌分配', operations: '运营收入分配', delegation: '委托报酬', penalty: '低质量处罚', reversal: '分配调整', grant: '贡献点发放' };
    const recipientNames = new Map<string, string>();
    for (const allocation of value.allocations) {
        if (!recipientNames.has(allocation.userId)) recipientNames.set(allocation.userId, (await tx.store.user(allocation.userId)).name);
    }
    const recipients = value.allocations.map(a => `${recipientNames.get(a.userId)} ${a.amount > 0 ? '+' : ''}${a.amount}`).join('，');
    return await tx.create('system', [
        { id: 'body', type: 'text', text: `${labels[value.source]}：${value.total} 贡献点${recipients ? `；${recipients}` : ''}。` },
        { id: 'distribution', type: 'relation', relation: 'distribution', roles: bindRoles(target ? { target: [target] } : {}) },
        { id: 'allocation', type: 'data', value: { ...value, ledgerId: 'local', programVersion: '2.0.0' } as unknown as Json },
    ]);
}
const getEffect = async <T>(store: Store, key: string): Promise<T | undefined> => {
    const row = await store.db.prepare("SELECT body FROM effects WHERE key=$1").get(key);
    return row ? JSON.parse(row.body as string) as T : undefined;
};
export async function markEffect(store: Store, key: string, value: unknown) { await store.db.prepare("INSERT INTO effects(key,body) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(key, JSON.stringify(value)); }
export async function hasEffect(store: Store, key: string) { return !!(await store.db.prepare("SELECT 1 FROM effects WHERE key=$1").get(key)); }
async function savedRounds(store: Store, key: string): Promise<SavedRound[]> { return (await store.db.prepare(`SELECT body FROM rounds WHERE "targetKey"=$1 ORDER BY "createdAt",position`).all(key)).map(r => JSON.parse(r.body as string) as SavedRound); }
async function saveRound(store: Store, round: SavedRound) { await store.db.prepare(`INSERT INTO rounds(id,"targetKey",body,"createdAt") VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(round.id, round.targetKey, JSON.stringify(round), round.createdAt); }
/** Value annotations and the arbitration panel share the same subject and round. */
export async function valueRoundFor(store: Store, reference: Reference): Promise<SavedRound | undefined> {
    const subject = await store.message(reference.messageId, reference.revision);
    const pinned = { ...reference, revision: subject.revision };
    const rows = await store.db.prepare("SELECT body FROM rounds WHERE (body::jsonb #>> '{subjectId}')=$1 AND (body::jsonb #>> '{settlementType}')='VALUE' ORDER BY position DESC").all(subject.id);
    for (const row of rows) {
        const round = JSON.parse(String(row.body)) as SavedRound;
        const evaluated = await store.message(round.target.messageId, round.target.revision);
        const basis = relations(evaluated).find(part => part.relation === 'open-value-settlement')?.roles.target?.[0]?.reference;
        if (basis && referenceKey(basis) === referenceKey(pinned)) return round;
        // Imported active rounds use the original body as their execution address.
        if (!basis && (round.status === 'open' || round.status === 'waiting') && round.target.messageId === subject.id
            && round.target.revision === subject.revision && !reference.partId && !reference.memberId && !reference.range && !reference.path?.length) return round;
    }
    return undefined;
}
async function newRound(tx: Mutation, selected: {
    key: string;
    target: Reference;
    revision: number;
}, trigger: Message, previous?: SavedRound): Promise<SavedRound> {
    const evaluated = await tx.store.message(selected.target.messageId, selected.target.revision), valueRelation = relations(evaluated).find(part => part.relation === 'open-value-settlement'), subjectId = valueRelation?.roles.target?.[0]?.reference.messageId;
    const {readReference}=await import('./validation.js');
    const displayed=selected.target.context&&'version' in selected.target.context&&selected.target.context.version&&!selected.target.partId?await readReference(tx.store,selected.target) as Message:evaluated;
    const declaration = await tx.create('system', [
        { id: 'body', type: 'text', text: `发起结算：${textOf(displayed).slice(0, 160) || '所选消息部件'}。发起人：${(await tx.store.user(trigger.authorId)).name}。` },
        { id: 'settlement', type: 'relation', relation: 'settlement', roles: bindRoles({ target: [selected.target], trigger: [{ messageId: trigger.id }] }) },
        { id: 'basis', type: 'data', value: { openedBy: trigger.authorId, triggerId: trigger.id, previousRoundId: previous?.id ?? null, settlementType: subjectId ? 'VALUE' : 'TRUTH', subjectId: subjectId ?? selected.target.messageId } },
    ]);
    return { id: declaration.id, target: selected.target, targetRevision: selected.revision, status: 'open', pro: previous?.pro ?? 0, con: previous?.con ?? 0, result: null, previousRoundId: previous?.id ?? null, distributionId: null, endsAt: null, targetKey: selected.key, payouts: [], betIds: [], createdAt: now(), settlementType: subjectId ? 'VALUE' : previous?.settlementType??'TRUTH', subjectId: subjectId ?? previous?.subjectId??selected.target.messageId };
}
export async function openSettlement(tx: Mutation, message: Message) {
    const valueRelation = relations(message).find(part => part.relation === 'open-value-settlement');
    const selected = await targetKey(tx.store, valueRelation ? { messageId: message.id, partId: valueRelation.id } : oneTarget(message, 'open-settlement'));
    const history = await savedRounds(tx.store, selected.key);
    if (history.some(round => round.status !== 'settled'))
        throw new DomainError('目标已有进行中的结算', 409);
    await saveRound(tx.store, (await newRound(tx, selected, message, history.at(-1))));
}
async function targetKey(store: Store, target: Reference): Promise<{
    key: string;
    target: Reference;
    revision: number;
}> {
    const current = await store.message(target.messageId);
    const revision = target.revision === undefined || target.revision === current.revision
        ? current.revision : (await store.message(target.messageId, target.revision)).revision;
    const pinned = { ...target, revision };
    const policy=await store.db.prepare('SELECT allowed_keys FROM settlement_access WHERE "messageId"=$1').get(target.messageId);
    if(policy && !policy.allowed_keys.includes(referenceKey(pinned))) throw new DomainError('该消息已关闭资金操作，请创建新消息',409);
    return { key: referenceKey(pinned), target: pinned, revision };
}
export async function roundsFor(store: Store, messageId: string): Promise<Round[]> {
    return (await store.db.prepare(`SELECT body FROM rounds WHERE (body::jsonb #>> '{target,messageId}')=$1 ORDER BY "createdAt" DESC LIMIT 100`).all(messageId)).map(r => {
        const { targetKey: _key, payouts: _payouts, betIds: _ids, createdAt: _at, ...round } = JSON.parse(r.body as string) as SavedRound;
        return round;
    });
}
/** Interpret an existing stance using the content and direction it actually executed. */
async function executionResolver(store: Pick<Store,'db'|'message'>, messageId: string, revision?: number): Promise<Message> {
    const message = await store.message(messageId, revision);
    const executed = await store.db.prepare(`SELECT "partId",target,side FROM execution_stances WHERE "sourceId"=$1 AND revision=$2`).all(message.id, message.revision);
    if (executed.length === 0)
        return message;
    return { ...message, parts: message.parts.map(part => {
            const basis = executed.find(row => row.partId === part.id);
            if (!basis || part.type !== 'relation')
                return part;
            return { ...part, relation: basis.side === 'pro' ? 'agree' : 'disagree', roles: { ...part.roles, target: [{ id: part.roles.target?.[0]?.id ?? 'target', reference: JSON.parse(basis.target as string) as Reference }] } };
        }) };
}
/** Load historical messages asynchronously while keeping the shared stance resolver authoritative. */
export async function resolveExecutedStance(store: Pick<Store,'db'|'message'>, target: Reference, side: 'pro' | 'con') {
    const loaded = new Map<string, Message>();
    const missing = new Error('Historical stance message not loaded');
    let requested: { messageId: string; revision?: number } | undefined;
    for (;;) {
        try {
            return resolveStance(target, side, (messageId, revision) => {
                const message = loaded.get(JSON.stringify([messageId, revision]));
                if (message) return message;
                requested = { messageId, revision };
                throw missing;
            });
        } catch (error) {
            if (error !== missing || !requested) throw error;
            const { messageId, revision } = requested;
            loaded.set(JSON.stringify([messageId, revision]), await executionResolver(store, messageId, revision));
        }
    }
}
export async function placeWager(tx: Mutation, message: Message, amount: number, allowDebt = false) {
    const stance = relations(message).filter(r => r.relation === 'agree' || r.relation === 'disagree');
    if (stance.length !== 1 || stance[0]!.roles.target?.length !== 1)
        throw new DomainError('押注必须对应一项明确的赞同或反对');
    const resolved = await resolveExecutedStance(tx.store, stance[0]!.roles.target![0]!.reference, stance[0]!.relation === 'agree' ? 'pro' : 'con');
    await placeResolvedWager(tx, message, amount, stance[0]!.id, resolved, {allowDebt});
}
export async function placeValueWager(tx: Mutation, message: Message, annotation: RelationPart, amount: number, allowDebt = false) {
    const reference = relationTarget(annotation);
    if (reference.revision !== undefined) await tx.store.message(reference.messageId);
    const subject = await tx.store.message(reference.messageId, reference.revision);
    const pinned = { ...reference, revision: subject.revision };
    const previous = await valueRoundFor(tx.store, pinned);
    const requested = dataOf(message).roundId;
    if (requested !== undefined && requested !== previous?.id) throw new DomainError('投票目标与轮次不一致', 409);
    let target = previous?.target;
    if (!target) {
        const claim = await tx.create('system', [
            { id: 'body', type: 'text', text: '这条消息具有讨论价值。' },
            { id: 'relation', type: 'relation', relation: 'open-value-settlement', roles: bindRoles({ target: [pinned] }) },
            { id: 'data', type: 'data', value: { uiType: 'ROUND', settlementType: 'VALUE' } },
        ]);
        target = { messageId: claim.id, revision: claim.revision, partId: 'relation' };
    }
    await placeResolvedWager(tx, message, amount, annotation.id, { target, side: annotationValueSide(annotation) }, {allowDebt});
}
/** Maintenance only: backfill an author's self-agreement without replaying the message's actions. */
export async function placeHistoricalSelfWager(tx: Mutation, message: Message, partId: string) {
    await placeResolvedWager(tx, message, 1, partId, { target: { messageId: message.id, revision: message.revision }, side: 'pro' }, {historical:true,validateRequestedRound:false});
}
/** Reassign existing principal while preserving the original execution address and version. */
export async function relocateHistoricalTargetWager(tx:Mutation,message:Message,amount:number,partId:string,target:Reference,side:'pro'|'con'){
    await placeResolvedWager(tx,message,amount,partId,{target,side},{allowDebt:true,validateRequestedRound:false});
}
/** Maintenance can fund an already executed JOIN without executing or approving it again. */
export async function relocateRecordedTargetWager(tx:Mutation,message:Message,amount:number,partId:string,target:Reference,side:'pro'|'con'){
    const execution=await tx.store.db.prepare('SELECT target,side FROM execution_stances WHERE "sourceId"=$1 AND revision=$2 AND "partId"=$3').get(message.id,message.revision,partId);
    const display=await tx.store.db.prepare('SELECT "targetKey",side FROM display_stances WHERE "sourceId"=$1').get(message.id);
    const key=referenceKey(target);
    if(!execution||referenceKey(JSON.parse(String(execution.target)))!==key||execution.side!==side||display?.targetKey!==key||display.side!==side)
        throw new Error('历史投入缺少一致的原始执行和展示记录');
    await tx.store.db.prepare('DELETE FROM execution_stances WHERE "sourceId"=$1 AND revision=$2 AND "partId"=$3').run(message.id,message.revision,partId);
    await placeResolvedWager(tx,message,amount,partId,{target,side},{allowDebt:true,validateApproval:false,validateRequestedRound:false});
}
/** Reverse only an unsettled migration stake mistakenly attached to an automatic record. */
export async function refundHistoricalSelfWager(tx: Mutation, message: Message, partId: string, reason='系统自动记录真假补扣退回') {
    const key=referenceKey({messageId:message.id,revision:message.revision});
    const bets=await tx.store.db.prepare('SELECT * FROM bets WHERE "messageId"=$1 AND "targetKey"=$2 ORDER BY position DESC LIMIT 1').all<Bet>(message.id,key);
    if(bets.length!==1||bets[0]!.amount!==1||bets[0]!.userId!==message.authorId||bets[0]!.side!=='pro')throw new Error('系统记录补扣缺少唯一押注，停止退款');
    const bet=bets[0]!,round=(await savedRounds(tx.store,key)).find(round=>round.id===bet.roundId);
    if(!round||round.status!=='open'||round.pro<1)throw new Error('系统记录补扣已进入结算，停止自动退款');
    await tx.store.db.prepare('DELETE FROM bets WHERE id=$1').run(bet.id);
    await tx.store.db.prepare('DELETE FROM stake_positions WHERE id=$1').run(bet.id);
    round.pro-=1;
    await saveRound(tx.store,round);
    await tx.store.db.prepare('DELETE FROM execution_stances WHERE "sourceId"=$1 AND revision=$2 AND "partId"=$3').run(message.id,message.revision,partId);
    await tx.store.db.prepare('DELETE FROM display_stances WHERE "sourceId"=$1 AND "targetId"=$1').run(message.id);
    await tx.store.db.prepare('DELETE FROM message_state_checkpoints WHERE "messageId"=$1').run(message.id);
    await tx.store.ledger(message.authorId,message.id,1,-1,reason,true);
    // Close the migration's now-empty round without affecting any prior settlement.
    if(!round.previousRoundId&&!await tx.store.db.prepare('SELECT 1 FROM bets WHERE "targetKey"=$1').get(key))await settle(tx,round,message.id);
}
async function placeResolvedWager(tx: Mutation, message: Message, amount: number, partId: string, resolved: { target: Reference; side: 'pro' | 'con' }, options: {historical?:boolean;allowDebt?:boolean;validateApproval?:boolean;validateRequestedRound?:boolean} = {}) {
    const {historical=false,allowDebt=false,validateApproval=true,validateRequestedRound=true}=options;
    if (!historical && validateApproval) await validateJoinApproval(tx.store, resolved.target, resolved.side, message.authorId);
    if(amount===0 && await tx.store.db.prepare('SELECT 1 FROM settlement_access WHERE "messageId"=$1').get(resolved.target.messageId)) {
        const target={...resolved.target,revision:(await tx.store.message(resolved.target.messageId,resolved.target.revision)).revision};
        await tx.store.db.prepare(`INSERT INTO execution_stances("sourceId",revision,"partId",target,side) VALUES ($1,$2,$3,$4,$5)`).run(message.id,message.revision,partId,JSON.stringify(target),resolved.side);
        tx.affected.add(await recordStance(tx.store,message,{target,side:resolved.side}));
        return;
    }
    const selected = historical
        ? { key: referenceKey(resolved.target), target: resolved.target, revision: message.revision }
        : await targetKey(tx.store, resolved.target);
    await tx.store.db.prepare(`INSERT INTO execution_stances("sourceId",revision,"partId",target,side) VALUES ($1,$2,$3,$4,$5)`).run(message.id, message.revision, partId, JSON.stringify(selected.target), resolved.side);
    tx.affected.add((await recordStance(tx.store, message, { target: selected.target, side: resolved.side })));
    const history = await savedRounds(tx.store, selected.key);
    let round = history.find(r => r.status !== 'settled');
    if (round?.status === 'waiting' && Date.parse(round.endsAt!) <= Date.now())
        throw new DomainError('结算截止，请刷新后参与下一轮', 409);
    if (!round) {
        const previous = history.at(-1);
        round = (await newRound(tx, selected, message, previous));
    }
    // Maintenance verifies the relocated target independently of the old request.
    const requested=dataOf(message).roundId;if(validateRequestedRound&&requested!==undefined&&requested!==round.id)throw new DomainError('投票目标与轮次固定依据不一致',409);
    round[resolved.side] = integer(round[resolved.side] + amount);
    if (amount > 0) {
        await tx.store.ledger(message.authorId, message.id, -amount, amount, historical ? '历史消息真假补扣' : '对赌锁定', historical || allowDebt);
        const betId = id();
        await tx.store.db.prepare(`INSERT INTO bets(id,"roundId","targetKey","userId","messageId",side,amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`).run(betId, round.id, selected.key, message.authorId, message.id, resolved.side, amount);
        await tx.store.db.prepare('INSERT INTO stake_positions VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)').run(betId,message.authorId,
          round.subjectId??round.target.messageId,round.id,round.settlementType??'TRUTH',resolved.side,amount,message.createdAt,JSON.stringify(round.target));
    }
    await saveRound(tx.store, round);
}
function allocate(total:number,weights:Array<{userId:string;weight:number;messageId:string}>,reason:string):Allocation[] {
  if(total<=0||weights.length===0)return [];
  const weightSum=weights.reduce((sum,w)=>sum+BigInt(w.weight),0n);
  if(weightSum===0n)return [];
  const allocations=weights.map(w=>({userId:w.userId,amount:Number(BigInt(total)*BigInt(w.weight)/weightSum),reason,messageIds:[w.messageId]}));
  let remaining=total-allocations.reduce((sum,a)=>sum+a.amount,0);
  // Stable largest-remainder allocation; message identity breaks ties deterministically.
  const order=weights.map((w,i)=>({i,remainder:BigInt(total)*BigInt(w.weight)%weightSum,id:w.messageId})).sort((a,b)=>a.remainder===b.remainder?a.id.localeCompare(b.id):a.remainder>b.remainder?-1:1);
  for(const item of order) {if(!remaining)break;allocations[item.i]!.amount++;remaining--;}
  return allocations.filter(a=>a.amount>0);
}
export async function terminate(tx: Mutation, message: Message) {
    const targets = relations(message).find(part => part.relation === 'terminate')?.roles.target?.map(binding => binding.reference) ?? [];
    if (!targets.length)
        throw new DomainError('终止结算必须指定目标');
    const seen = new Set<string>();
    for (const target of targets) {
        const selected = await targetKey(tx.store, target);
        if (seen.has(selected.key))
            continue;
        seen.add(selected.key);
        const round = (await savedRounds(tx.store, selected.key)).find(r => r.status !== 'settled');
        if (!round)
            throw new DomainError('目标没有进行中的结算');
        const requested = dataOf(message).roundId;
        if (requested !== undefined && requested !== round.id)
            throw new DomainError('终止目标与轮次不一致', 409);
        if (round.status === 'waiting')
            continue;
        const delay = (await tx.store.rules()).settlementDelayMs;
        if (delay > 0) {
            round.status = 'waiting';
            round.endsAt = new Date(Date.now() + delay).toISOString();
            await saveRound(tx.store, round);
        }
        else
            await settle(tx, round, message.id);
    }
}
export async function settleDue(tx: Mutation): Promise<number> {
    const rounds = await tx.store.db.prepare("SELECT body FROM rounds WHERE (body::jsonb #>> '{status}')='waiting' AND (body::jsonb #>> '{endsAt}')<=$1").all(now());
    for (const row of rounds) {
        const round = JSON.parse(row.body as string) as SavedRound;
        await settle(tx, round, round.target.messageId);
    }
    return rounds.length;
}
async function settle(tx: Mutation, round: SavedRound, triggerId: string) {
    const store = tx.store;
    if (round.status === 'settled')
        return;
    const bets = (await store.db.prepare(`SELECT * FROM bets WHERE "targetKey"=$1 ORDER BY position`).all(round.targetKey)) as unknown as Bet[];
    if (round.previousRoundId && (await savedRounds(store,round.targetKey)).find(item=>item.id===round.previousRoundId)?.distributionId) {
        const previous = (await savedRounds(store, round.targetKey)).find(r => r.id === round.previousRoundId)!;
        const reverse = await distribution(tx, round.target, { source: 'reversal', total: -previous.payouts.reduce((s, a) => s + a.amount, 0), ruleVersion: (await store.rules()).version, inputs: { roundId: previous.id, distributionId: previous.distributionId }, allocations: previous.payouts.map(a => ({ ...a, amount: -a.amount, reason: '后续结算撤回先前分配' })) });
        for (const allocation of previous.payouts)
            await store.ledger(allocation.userId, reverse.id, -allocation.amount, 0, '撤回先前对赌分配', true);
        const previousIds = new Set(previous.betIds);
        for (const bet of bets)
            if (previousIds.has(bet.id))
                await store.ledger(bet.userId, reverse.id, 0, bet.amount, '恢复先前对赌本金', true);
    }
    const pro = integer(bets.filter(b => b.side === 'pro').reduce((s, b) => integer(s + b.amount), 0));
    const con = integer(bets.filter(b => b.side === 'con').reduce((s, b) => integer(s + b.amount), 0));
    const result = pro === con ? 'tie' : pro > con ? 'pro' : 'con';
    const winners = result === 'tie' ? bets : bets.filter(b => b.side === result);
    const payouts = allocate(integer(pro + con), winners.map(b => ({ userId: b.userId, weight: b.amount, messageId: b.messageId })), result === 'tie' ? '平局退还本金' : pro === 0 || con === 0 ? '单边胜出退还本金' : '胜方按出资比例分配');
    const output = await distribution(tx, round.target, { source: 'wager', total: integer(pro + con), ruleVersion: (await store.rules()).version, inputs: { roundId: round.id, previousRoundId: round.previousRoundId, triggerId, pro, con, result, betIds: bets.map(b => b.id) }, allocations: payouts });
    for (const bet of bets)
        await store.ledger(bet.userId, output.id, 0, -bet.amount, '结束对赌锁定', true);
    for (const allocation of payouts)
        await store.ledger(allocation.userId, output.id, allocation.amount, 0, allocation.reason, true);
    Object.assign(round, { pro, con, result, status: 'settled', endsAt: now(), distributionId: output.id, payouts, betIds: bets.map(b => b.id) });
    await saveRound(store, round);
    await applyResultEffects(tx, round, output.id);
}
async function applyResultEffects(tx: Mutation, round: SavedRound, distributionId: string) {
    // An assertion about a reason fragment is not a verdict on the full quality/completion claim.
    if (round.target.memberId || round.target.path?.length || round.target.range)
        return;
    const evaluated = await tx.store.message(round.target.messageId, round.targetRevision);
    const evaluatedRelations = relations(evaluated).filter(part => !round.target.partId || part.id === round.target.partId);
    for (const lowQuality of evaluatedRelations.filter(r => r.relation === 'low-quality' || r.relation === 'open-value-settlement')) {
        const target = relationTarget(lowQuality);
        const original = await tx.store.message(target.messageId, target.revision);
        const settlementInitiator = relations(original).some(part => part.relation === 'settlement') ? dataOf(original).openedBy : undefined;
        const responsibleUser = original.authorId === 'system' && typeof settlementInitiator === 'string' ? settlementInitiator : original.authorId;
        if (responsibleUser === 'system')
            continue;
        const key = `quality:${evaluated.id}:${lowQuality.id}`;
        const before = await getEffect<QualityEffect>(tx.store, key);
        const active = round.result === (lowQuality.relation === 'open-value-settlement' ? 'con' : 'pro');
        if (active && !before?.active) {
            const amount = (await tx.store.rules()).lowQualityPenalty;
            const output = await distribution(tx, target, { source: 'penalty', total: amount, ruleVersion: (await tx.store.rules()).version, inputs: { evaluationId: evaluated.id, distributionId }, allocations: [{ userId: responsibleUser, amount: -amount, reason: '低质量评价成立', messageIds: [original.id, evaluated.id] }] });
            await tx.store.ledger(responsibleUser, output.id, -amount, 0, '低质量处罚', true);
            await tx.store.operating(amount, true);
            await markEffect(tx.store, key, { userId: responsibleUser, messageId: original.id, amount, active: true });
        }
        else if (!active && before?.active) {
            const output = await distribution(tx, target, { source: 'reversal', total: before.amount, ruleVersion: (await tx.store.rules()).version, inputs: { evaluationId: evaluated.id, distributionId }, allocations: [{ userId: before.userId, amount: before.amount, reason: '低质量评价平反', messageIds: [original.id, evaluated.id] }] });
            await tx.store.operating(-before.amount, true);
            await tx.store.ledger(before.userId, output.id, before.amount, 0, '低质量处罚平反', true);
            await markEffect(tx.store, key, { ...before, active: false });
        }
    }
    for (const fulfillment of evaluatedRelations.filter(r => r.relation === 'fulfill')) {
        const task = relationTarget(fulfillment);
        const fulfillmentKey = `${evaluated.id}:${fulfillment.id}`;
        const escrow = (await tx.store.db.prepare(`SELECT * FROM escrows WHERE "messageId"=$1`).get(task.messageId)) as Escrow | undefined;
        if (!escrow)
            throw new DomainError('委托资金不存在');
        if (round.result === 'pro' && !escrow.recipientId) {
            const output = await distribution(tx, task, { source: 'delegation', total: escrow.amount, ruleVersion: (await tx.store.rules()).version, inputs: { fulfillmentId: evaluated.id, fulfillmentPartId: fulfillment.id, distributionId }, allocations: [{ userId: evaluated.authorId, amount: escrow.amount, reason: '委托完成报酬', messageIds: [task.messageId, evaluated.id] }] });
            await tx.store.ledger(escrow.ownerId, output.id, 0, -escrow.amount, '委托报酬支付', true);
            await tx.store.ledger(evaluated.authorId, output.id, escrow.amount, 0, '委托完成报酬', true);
            await tx.store.db.prepare(`UPDATE escrows SET "recipientId"=$1,"fulfillmentId"=$2 WHERE "messageId"=$3`).run(evaluated.authorId, fulfillmentKey, task.messageId);
        }
        else if (round.result !== 'pro' && escrow.fulfillmentId === fulfillmentKey && escrow.recipientId) {
            const output = await distribution(tx, task, { source: 'reversal', total: -escrow.amount, ruleVersion: (await tx.store.rules()).version, inputs: { fulfillmentId: evaluated.id, distributionId }, allocations: [{ userId: escrow.recipientId, amount: -escrow.amount, reason: '撤回委托完成认定', messageIds: [task.messageId, evaluated.id] }] });
            await tx.store.ledger(escrow.recipientId, output.id, -escrow.amount, 0, '追回委托报酬', true);
            await tx.store.ledger(escrow.ownerId, output.id, 0, escrow.amount, '恢复委托锁定报酬', true);
            await tx.store.db.prepare(`UPDATE escrows SET "recipientId"=NULL,"fulfillmentId"=NULL WHERE "messageId"=$1`).run(task.messageId);
        }
    }
}
export async function lockDelegation(tx: Mutation, message: Message) {
    const reward = dataOf(message).reward;
    if (typeof reward !== 'number' || !Number.isSafeInteger(reward) || reward <= 0)
        throw new DomainError('委托报酬须为正整数');
    await tx.store.ledger(message.authorId, message.id, -reward, reward, '委托报酬锁定');
    await tx.store.db.prepare(`INSERT INTO escrows("messageId","ownerId",amount,"recipientId","fulfillmentId") VALUES ($1,$2,$3,NULL,NULL)`).run(message.id, message.authorId, reward);
}
export async function distributeOperations(tx: Mutation, message: Message) {
    const rules = await tx.store.rules();
    const available = Math.max(0, (await tx.store.setting<number>('operating')) - rules.operatingReserve);
    const requested = dataOf(message).amount;
    const total = requested === undefined ? available : requested;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > available)
        throw new DomainError('分配金额超过可用运营收入');
    const previous = await getEffect<{
        sequence: number;
    }>(tx.store, 'operations:last');
    const contributions = (await tx.store.db.prepare(`SELECT body FROM messages WHERE "authorId"<>'system' AND id<>$1 ORDER BY "createdAt",id`).all(message.id)).map(r => JSON.parse(r.body as string) as Message);
    const qualityEffects = (await tx.store.db.prepare("SELECT body FROM effects WHERE key LIKE 'quality:%'").all()).map(row => JSON.parse(row.body as string) as QualityEffect);
    const excluded = new Set(qualityEffects.filter(e => e.active).map(e => e.messageId));
    const byId = new Map(contributions.map(m => [m.id, m]));
    const latestStances = new Map<string, {
        targetId: string;
        side: 'pro' | 'con';
    }>();
    const executedStances = await tx.store.db.prepare(`SELECT * FROM display_stances WHERE "wholeComponent"=1 ORDER BY sequence,"sourceId"`).all();
    for (const executed of executedStances) {
        const sourceId = String(executed.sourceId), targetId = String(executed.targetId), authorId = String(executed.authorId), target = byId.get(targetId);
        if (excluded.has(sourceId) || !target || target.revision !== executed.targetRevision || target.authorId === authorId)
            continue;
        latestStances.set(`${targetId}:${authorId}`, { targetId, side: executed.side as 'pro' | 'con' });
    }
    const recognition = new Map<string, number>();
    for (const stance of latestStances.values())
        if (stance.side === 'pro')
            recognition.set(stance.targetId, (recognition.get(stance.targetId) ?? 0) + 1);
    const parents = new Map((await tx.store.db.prepare(`SELECT "memberId","parentId" FROM memberships`).all()).map(row => [String(row.memberId), String(row.parentId)]));
    const scopePositions = new Map<string, number>(), firstContent = new Map<string, string>(), unrecognizedTotals = new Map<string, number>();
    const passive = new Set(['follow', 'unfollow', 'block', 'unblock', 'read', 'unread', 'notify', 'terminate', 'authorize', 'credit', 'recharge', 'distribute', 'distribution']);
    const attribution = contributions.filter(m => !excluded.has(m.id)).map(m => {
        const rel = relations(m);
        const recognized = recognition.get(m.id) ?? 0;
        const normalized = textOf(m).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
        const referenceTarget = rel.flatMap(p => p.roles.target ?? []).find(b => parents.has(b.reference.messageId))?.reference.messageId;
        const scope = parents.get(m.id) ?? (referenceTarget ? parents.get(referenceTarget) : undefined) ?? 'root';
        const contentKey = `${scope}:${normalized}`, duplicateOf = normalized ? firstContent.get(contentKey) : undefined;
        if (normalized && !duplicateOf)
            firstContent.set(contentKey, m.id);
        const passiveOnly = !normalized && rel.length > 0 && rel.every(r => passive.has(r.relation) || r.relation === 'member-of');
        const base = passiveOnly ? 0 : rel.some(r => r.relation === 'evidence') && recognized > 0 ? rules.contributionWeights.evidence : normalized ? rules.contributionWeights.content : rel.some(r => ['agree', 'disagree'].includes(r.relation)) ? rules.contributionWeights.agreement : rules.contributionWeights.relation;
        const position = (scopePositions.get(scope) ?? 0) + (base > 0 ? 1 : 0);
        scopePositions.set(scope, position);
        const earlyBonus = base > 0 && position <= rules.contributionWeights.earlyWindow ? rules.contributionWeights.earlyBonus : 0;
        const rawWeight = integer(duplicateOf && recognized === 0 ? rules.contributionWeights.duplicate : base + earlyBonus + recognized);
        const capKey = `${scope}:${m.authorId}`, used = unrecognizedTotals.get(capKey) ?? 0;
        const weight = recognized > 0 ? rawWeight : Math.min(rawWeight, Math.max(0, rules.contributionWeights.unrecognizedAuthorCap - used));
        if (recognized === 0)
            unrecognizedTotals.set(capKey, integer(used + weight));
        const reasons = [`基础 ${base}`, `早期 ${duplicateOf && recognized === 0 ? 0 : earlyBonus}`, `他人认可 ${recognized}`];
        if (duplicateOf)
            reasons.push(`重复来源 ${duplicateOf}${recognized === 0 ? '，按重复权重' : '，已有他人认可'}`);
        if (weight < rawWeight)
            reasons.push('同作者同讨论未获认可贡献达到上限');
        return { userId: m.authorId, weight, messageId: m.id, scope, position, base, earlyBonus, recognized, duplicateOf: duplicateOf ?? null, rawWeight, reason: reasons.join('；') };
    });
    const weights = attribution.filter(w => w.weight > 0);
    const byContribution = new Map(attribution.map(item => [item.messageId, item]));
    const allocations = allocate(total, weights, '按消息贡献权重分配').map(allocation => ({ ...allocation, reason: byContribution.get(allocation.messageIds[0]!)?.reason ?? allocation.reason }));
    const distributed = allocations.reduce((sum, a) => sum + a.amount, 0);
    const output = await distribution(tx, { messageId: message.id }, { source: 'operations', total: distributed, ruleVersion: rules.version, inputs: { available, requested: total, previousDistributionSequence: previous?.sequence ?? 0, toSequence: await tx.store.latestSequence(), parameters: rules.contributionWeights, attribution: attribution as unknown as Json, recognition: Object.fromEntries(recognition), excludedMessageIds: [...excluded] }, allocations });
    await tx.store.operating(-distributed);
    for (const allocation of allocations)
        await tx.store.ledger(allocation.userId, output.id, allocation.amount, 0, allocation.reason, true);
    if (distributed > 0)
        await markEffect(tx.store, 'operations:last', { sequence: await tx.store.latestSequence() });
}
export async function grant(tx: Mutation, proposal: Message, target: Reference | undefined) {
    const data = dataOf(proposal), amount = data.amount, userId = data.userId ?? data.recipientId ?? proposal.authorId;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0 || typeof userId !== 'string')
        throw new DomainError('发放金额和接收者无效');
    await tx.store.user(userId);
    const share = data.revenuePoolShare ?? 0;
    if (typeof share !== 'number' || !Number.isSafeInteger(share) || share < 0 || share > amount)
        throw new DomainError('运营分账数量无效');
    const credited = amount - share;
    const output = await distribution(tx, target ?? { messageId: proposal.id }, { source: 'grant', total: amount, ruleVersion: (await tx.store.rules()).version, inputs: { proposalId: proposal.id, revenuePoolShare: share, creditedAmount: credited }, allocations: [{ userId, amount: credited, reason: '公开发放贡献点', messageIds: [proposal.id] }] });
    await tx.store.ledger(userId, output.id, credited, 0, '公开发放贡献点', true);
    if (share)
        await tx.store.operating(share);
    await tx.store.set('minted', integer((await tx.store.setting<number>('minted')) + amount));
}
export async function injectRevenue(tx: Mutation, proposal: Message) {
    const data = dataOf(proposal), amount = data.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0 || typeof data.source !== 'string' || !data.source.trim())
        throw new DomainError('收入数量和来源无效');
    await distribution(tx, { messageId: proposal.id }, { source: 'grant', total: amount, ruleVersion: (await tx.store.rules()).version, inputs: { proposalId: proposal.id, operatingIncome: true, source: data.source }, allocations: [] });
    await tx.store.operating(amount);
    await tx.store.set('minted', integer((await tx.store.setting<number>('minted')) + amount));
}
