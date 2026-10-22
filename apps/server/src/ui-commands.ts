import { bindRoles, organization, relations, replaceReference, textOf, type Json, type Part, type Reference, type User } from '@gonglun/core';
import { z } from 'zod';
import { DomainError, id, Store } from './db.js';
import { send } from './messages.js';
import { dataOf } from './economy.js';
import { legacyType, messageView, parentOf, primaryRelation, roundView, snapshot, type RecordData } from './ui-projections.js';
import { readReference } from './validation.js';
export type Signature = {
    deviceId: string;
    publicKey: string;
    payload: string;
    signature: string;
};
export interface CommandContext {
    store: Store;
    user: User;
    requestId: string;
    messageId?: string;
    signature?: Signature;
}
const object = z.record(z.unknown());
const stanceCorrectionsSchema = z.record(z.string().max(100), z.array(z.string().max(100)).max(200));
const number = (value: unknown) => { if (value === undefined)
    return 0; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new DomainError('贡献点数量须为非负整数'); return value; };
const text = (value: unknown, max = 50000) => { if (value === undefined)
    return ''; if (typeof value !== 'string' || value.length > max)
    throw new DomainError('文本内容无效'); return value; };
const relation = (name: string, roles: Record<string, Reference[]>, partId = 'relation'): Part => ({ id: partId, type: 'relation', relation: name, roles: bindRoles(roles) });
export async function referenceFrom(store: Store, raw: RecordData): Promise<Reference> {
    if (raw.reference) {
        const ref = raw.reference as Reference;
        (await readReference(store, ref));
        return ref;
    }
    const messageId = raw.messageId ?? raw.relationId;
    if (typeof messageId !== 'string')
        throw new DomainError('引用缺少消息编号');
    const message = (await store.message(messageId)), ref: Reference = { messageId };
    if (raw.kind === 'text-fragment') {
        const quote = text(raw.text), parts = message.parts.filter(p => p.type === 'text' || p.type === 'web' || p.type === 'code');
        const matches = parts.flatMap(p => { const value = p.type === 'text' ? p.text : p.type === 'web' ? p.excerpt : p.source; const start = value.indexOf(quote); return start < 0 ? [] : [{ partId: p.id, start, value }]; });
        if (!quote || matches.length !== 1 || matches[0]!.value.indexOf(quote, matches[0]!.start + 1) !== -1)
            throw new DomainError('片段已变化或存在多个位置，请重新选择文本');
        return { ...ref, revision: message.revision, partId: matches[0]!.partId, range: { start: matches[0]!.start, end: matches[0]!.start + quote.length } };
    }
    if (raw.kind === 'relation' && raw.part && raw.part !== 'whole') {
        const part = raw.part === 'label' ? message.parts.find(p => p.type === 'text') : primaryRelation(message);
        if (part)
            ref.partId = part.id;
    }
    return ref;
}
function membership(parent: string): Part[] { return parent === 'root' ? [] : [relation('member-of', { parent: [{ messageId: parent }] }, 'placement')]; }
async function submit(context: CommandContext, parts: Part[], body: RecordData) {
    return send(context.store, context.user, { requestId: context.requestId, parts, recommendation: number(body.recommendation), wager: number(body.wager), ...(body.selfAgree ? { selfStance: 'pro' } : {}) }, { messageId: context.messageId, signature: context.signature });
}
async function publish(context: CommandContext, parts: Part[], body: RecordData) {
    return (await submit(context, parts, body)).message;
}
async function publishView(context: CommandContext, parts: Part[], body: RecordData, parent: string) {
    const result = await submit(context, parts, body);
    return messageView(context.store, result.message, parent, result.change.states.find(state => state.messageId === result.message.id));
}
async function validateParent(store: Store, parent: string) { if (parent === 'root')
    return; if (!organization((await store.message(parent))))
    throw new DomainError('只有组织消息可以接收成员'); }
export async function createContent(context: CommandContext, parent: string, body: RecordData) {
    (await validateParent(context.store, parent));
    if (body.kind === 'ROUND') {
        if (!body.targetMessageId)
            throw new DomainError('结算缺少目标');
        return (await createRound(context, String(body.targetMessageId), body));
    }
    const content = text(body.content), kind = text(body.kind) || 'TEXT';
    if (!content.trim() && !Array.isArray(body.parts))
        throw new DomainError('消息内容不能为空');
    const parts: Part[] = Array.isArray(body.parts) ? body.parts : [{ id: 'body', type: kind === 'CODE' ? 'code' : 'text', ...(kind === 'CODE' ? { language: 'text', source: content } : { text: content }) } as Part];
    const meta: RecordData = { contentType: body.contentType === 'MARKDOWN' ? 'MARKDOWN' : 'TEXT', kind };
    if (kind === 'GOVERNANCE')
        parts.push(relation('proposal', {}));
    if (kind === 'OPERATIONS')
        parts.push(relation('operations', {}));
    parts.push({ id: 'data', type: 'data', value: meta }, ...membership(parent));
    const recommendation = body.recommendation ?? (!body.selfAgree ? body.stakeAmount : 0), wager = body.wager ?? (body.selfAgree ? body.stakeAmount : 0);
    return publishView(context, parts, { ...body, recommendation, wager }, parent);
}
const names: Record<string, string> = { ATTENTION: 'follow', CORRECT: 'amend', PROPOSAL: 'proposal', CODE_CHANGE: 'code-change', JOIN: 'member-of' };
export async function createRelation(context: CommandContext, parent: string, body: RecordData) {
    (await validateParent(context.store, parent));
    const store = context.store, type = text(body.relationType, 80).toUpperCase();
    if (!type)
        throw new DomainError('缺少关系类型');
    const payload = body.payload === undefined ? {} : object.parse(body.payload) as RecordData;
    const refs = (await Promise.all(z.array(object).max(200).parse(body.targetRefs ?? []).map(async (raw) => (await referenceFrom(store, raw)))));
    if (payload.operationType === 'TERMINATE_SETTLEMENT' && !refs.length && Array.isArray(payload.targetMessageIds))
        for (const target of payload.targetMessageIds) {
            if (typeof target !== 'string')
                throw new DomainError('终止目标无效');
            const round = (await store.db.prepare("SELECT body FROM rounds WHERE id=$1").get(target));
            refs.push(round ? JSON.parse(String(round.body)).target : { messageId: target });
        }
    const sourceRefs: Array<Reference> = body.sourceRefs ? (await Promise.all(z.array(object).max(100).parse(body.sourceRefs).map(async (raw) => { (await readReference(store, raw as unknown as Reference)); return raw as unknown as Reference; }))) : body.sourceMessageId ? [{ messageId: text(body.sourceMessageId, 100) }] : [];
    for (const ref of sourceRefs)
        (await readReference(store, ref));
    let name = names[type] ?? type.toLowerCase(), roles: Record<string, Reference[]> = { target: refs };
    if (sourceRefs.length)
        roles.source = sourceRefs;
    if (['CLASSIFY', 'MERGE', 'SUMMARY', 'ARRANGE'].includes(type)) {
        if (refs.some(ref => ref.revision !== undefined || ref.partId || ref.memberId || ref.range || ref.path?.length))
            throw new DomainError('组织成员需选择当前完整消息，部件和历史版本可用于引用或讨论');
        roles = { members: refs };
    }
    if (type === 'JOIN') {
        if (!body.sourceMessageId || refs.length !== 1)
            throw new DomainError('加入需要一个组织和一个成员');
        if (refs.some(ref => ref.revision !== undefined || ref.partId || ref.memberId || ref.range || ref.path?.length))
            throw new DomainError('组织成员须指向当前完整消息');
        roles = { parent: [{ messageId: body.sourceMessageId }], member: [{ messageId: refs[0]!.messageId }] };
    }
    if (type === 'DELEGATION')
        name = payload.delegationKind === 'FULFILL' ? 'fulfill' : 'delegate';
    if (type === 'PROPOSAL' || type === 'OPERATIONS') {
        const actions: Record<string, string> = { DISTRIBUTE_REVENUE: 'distribute', RECHARGE: 'recharge', REVENUE_INJECTION: 'revenue-injection', TERMINATE_SETTLEMENT: 'terminate', UPDATE_RULES: 'rule-change' };
        name = actions[String(payload.operationType)] ?? (payload.proposedParameters ? 'rule-change' : name);
    }
    if (type === 'ARCHIVE' && ['SPAM', 'OFFTOPIC', 'LOWVALUE'].includes(payload.subType))
        name = 'low-quality';
    const parts: Part[] = [relation(name, roles)];
    const content = text(payload.content ?? payload.title ?? payload.label);
    if (content && type !== 'CORRECT')
        parts.unshift({ id: 'body', type: 'text', text: content });
    const data: RecordData = { ...payload, uiType: type };
    if (payload.stanceCorrections !== undefined) data.stanceCorrections = stanceCorrectionsSchema.parse(payload.stanceCorrections);
    if (type === 'CORRECT') data.correctionKind = z.enum(['TEXT', 'MEANING']).parse(payload.correctionKind ?? 'TEXT');
    delete data.membershipHistory;
    if (['CLASSIFY', 'MERGE', 'SUMMARY', 'ARRANGE'].includes(type)) data.independentMemberships = true;
    if (name === 'amend') {
        if (refs.length !== 1)
            throw new DomainError('修改需要一个明确目标');
        const target = await store.message(refs[0]!.messageId, refs[0]!.revision);
        data.expectedRevision = target.revision;
        data.value = Object.hasOwn(payload, 'correctionValue') ? payload.correctionValue : text(payload.correctionContent);
        const reference = refs[0]!, part = target.parts.find(part => part.id === reference.partId);
        let before: string | undefined, after: string | undefined;
        if (part && ['text', 'code', 'web'].includes(part.type) && !reference.memberId
            && (!reference.path?.length || reference.path.length === 1 && ['text', 'source', 'excerpt'].includes(String(reference.path[0])))) {
            if (relations(target).some(part => part.relation === 'correct' || part.relation === 'amend'))
                throw new DomainError('请基于原消息的正文发送更正');
            reference.revision ??= target.revision;
            let replacement: Part[];
            try { replacement = replaceReference(target, reference, data.value); }
            catch (error) { throw new DomainError(error instanceof Error ? error.message : '修改内容无效'); }
            before = textOf(target); after = textOf({ ...target, parts: replacement });
        }
        if (part && before !== undefined && after !== undefined) {
            // A text correction records a suggested edit without changing the original message.
            const correction = parts.find(part => part.type === 'relation' && part.relation === 'amend');
            if (correction?.type === 'relation') correction.relation = 'correct';
            data.correctionBeforeContent = before;
            parts.unshift({ id: 'corrected-body', type: 'text', text: after });
            // The correction keeps its own content and uses the existing vote/settlement flow.
            delete data.correctionContent; delete data.correctionAfterContent; delete data.correctionValue;
        } else delete data.correctionKind;
    }
    if (name === 'delegate')
        data.reward = number(payload.rewardAmount);
    if (name === 'rule-change')
        data.rules = payload.rules ?? payload.proposedParameters ?? {};
    if (name === 'recharge')
        data.userId = payload.recipientUserId ?? context.user.id;
    if (type === 'ARCHIVE' && name === 'low-quality')
        parts.push(relation('archive', { target: refs }, 'personal-archive'));
    if (['CLASSIFY', 'MERGE', 'SUMMARY', 'ARRANGE'].includes(type))
        parts.push({ id: 'display', type: 'display', relationPartId: 'relation', layout: type === 'SUMMARY' ? 'summary' : payload.targetLayout === 'single-row' ? 'row' : payload.targetLayout === 'multi-column' ? 'columns' : 'flow' });
    parts.push({ id: 'data', type: 'data', value: data });
    // Grouping inherits the common parent atomically; explicit placement only applies to a new empty organization.
    if (!['JOIN', 'CLASSIFY', 'MERGE', 'SUMMARY', 'ARRANGE'].includes(type) || refs.length === 0)
        parts.push(...membership(parent));
    if (body.supersedesRelationId) {
        const previous = (await store.message(text(body.supersedesRelationId, 100)));
        const amendment = (await publish(context, [relation('amend', { target: [{ messageId: previous.id, revision: previous.revision }] }), { id: 'data', type: 'data', value: { parts: parts as unknown as Json, expectedRevision: previous.revision, uiType: 'CORRECT' } }, ...membership(parent)], body));
        return (await messageView(store, amendment, parent));
    }
    const stance = name === 'agree' || name === 'disagree';
    const wager = body.wager ?? (stance ? body.stakeAmount : 0), recommendation = body.recommendation ?? (!stance ? body.stakeAmount : 0);
    return publishView(context, parts, { ...body, wager, recommendation }, parent);
}
export async function createRound(context: CommandContext, target: string, body: RecordData) {
    const value = body.settlementType === 'VALUE';
    const original = (await context.store.message(target));
    const previousValue = value ? (await context.store.db.prepare("SELECT body FROM rounds WHERE (body::jsonb #>> '{subjectId}')=$1 AND (body::jsonb #>> '{settlementType}')='VALUE' ORDER BY position DESC LIMIT 1").get(target)) : undefined;
    const previous = previousValue ? JSON.parse(String(previousValue.body)) : undefined;
    const previousClaim = previous ? (await context.store.message(previous.target.messageId, previous.target.revision)) : undefined;
    const basis = previousClaim && relations(previousClaim).find(p => p.relation === 'open-value-settlement')?.roles.target?.[0]?.reference;
    const reuse = value && basis?.revision === original.revision ? previous?.target as Reference : undefined;
    const message = (await publish(context, [...(value && !reuse ? [{ id: 'body', type: 'text', text: '这条消息具有讨论价值。' } as Part] : []), relation(value && !reuse ? 'open-value-settlement' : 'open-settlement', { target: [reuse ?? { messageId: target, revision: original.revision }] }), { id: 'data', type: 'data', value: { note: text(body.note), uiType: 'ROUND', settlementType: value ? 'VALUE' : 'TRUTH' } }, ...membership((await parentOf(context.store, target)))], {}));
    const row = (await context.store.db.prepare("SELECT id FROM rounds WHERE (body::jsonb #>> '{target,messageId}')=$1 AND (body::jsonb #>> '{status}')<>'settled' ORDER BY position DESC LIMIT 1").get(reuse?.messageId ?? (value ? message.id : target)));
    if (!row)
        throw new DomainError('结算创建失败');
    return { ...(await roundView(context.store, String(row.id), context.user.id)), requestMessageId: message.id };
}
export async function executeCommand(context: CommandContext, method: string, path: string, input: unknown): Promise<any> {
    return context.store.transaction(()=>executeWithinTransaction(context,method,path,input));
}
async function executeWithinTransaction(context: CommandContext, method: string, path: string, input: unknown): Promise<any> {
    const body = object.parse(input ?? {}) as RecordData, store = context.store;
    let match: RegExpMatchArray | null;
    const parent = body.parentMessageId === undefined ? 'root' : text(body.parentMessageId, 100);
    if (path === '/messages' && method === 'POST')
        return (await createContent(context, parent, body));
    if (path === '/relations' && method === 'POST')
        return (await createRelation(context, parent, body));
    if ((match = path.match(/^\/relations\/([^/]+)$/)) && method === 'PATCH') {
        const message = (await store.message(match[1]!)), org = organization(message);
        if (!org)
            throw new DomainError('目标不是组织关系');
        const refs = (await Promise.all(z.array(object).max(200).parse(body.targetRefs).map(async (raw) => (await referenceFrom(store, raw)))));
        const parts = message.parts.map(p => p.id === org.id ? { ...org, roles: { ...org.roles, members: bindRoles({ members: refs.map(r => ({ messageId: r.messageId })) }).members! } } : p);
        return (await messageView(store, (await publish(context, [relation('amend', { target: [{ messageId: message.id, revision: message.revision }] }), { id: 'data', type: 'data', value: { parts: parts as any, expectedRevision: message.revision, uiType: 'CORRECT' } }, ...membership(parent)], {})), parent));
    }
    if ((match = path.match(/^\/messages\/([^/]+)\/rounds$/)) && method === 'POST')
        return (await createRound(context, match[1]!, body));
    if ((match = path.match(/^\/rounds\/([^/]+)\/votes$/)) && method === 'POST') {
        if (body.vote !== 'TRUE' && body.vote !== 'FALSE')
            throw new DomainError('立场无效');
        const round = (await roundView(store, match[1]!, context.user.id));
        if (round.status === 'SETTLED')
            throw new DomainError('该轮已结束', 409);
        const stanceCorrections=body.stanceCorrections===undefined?undefined:stanceCorrectionsSchema.parse(body.stanceCorrections);
        return (await messageView(store, (await publish(context, [relation(body.vote === 'TRUE' ? 'agree' : 'disagree', { target: [round.reference] }), { id: 'data', type: 'data', value: { roundId: round.id,...(stanceCorrections?{stanceCorrections}:{}) } }], { wager: number(body.amount) }))));
    }
    if ((match = path.match(/^\/rounds\/([^/]+)\/close-and-settle$/)) && method === 'POST') {
        const round = (await roundView(store, match[1]!, context.user.id));
        const message = (await publish(context, [relation('terminate', { target: [round.reference] }), { id: 'data', type: 'data', value: { roundId: round.id } }], {})), settled = (await roundView(store, round.id, context.user.id));
        const output = settled.distributionId ? (await store.message(settled.distributionId)) : null;
        return { message: settled.status === 'SETTLED' ? '结算已完成' : '已请求终止，等待规则规定的截止时间', status: settled.status, endsAt: settled.endsAt, roundId: round.id, messageId: round.messageId, result: settled.result, weights: settled.weights, totalPro: settled.weights.TRUE, totalCon: settled.weights.FALSE, settlementType: settled.settlementType, resultMessage: output ? (await messageView(store, output)) : undefined, requestMessage: (await messageView(store, message)), affectedUsers: new Set((settled.votes ?? []).map((v: RecordData) => v.user.id)).size };
    }
    throw new DomainError('不支持的操作', 404);
}
export const batchSchema = z.object({ requestId: z.string().min(1).max(100), commands: z.array(z.object({ id: z.string().uuid(), method: z.enum(['POST', 'PATCH']), path: z.string().startsWith('/').max(300), body: object })).min(1).max(100) }).strict();
export async function executeBatch(store: Store, user: User, input: unknown, signature?: Signature) {
    const body = batchSchema.parse(input), serialized = JSON.stringify(body);
    if (new Set(body.commands.map(c => c.id)).size !== body.commands.length)
        throw new DomainError('命令编号不可重复');
    const receipt = await store.transaction(async () => {
        const before = (await store.db.prepare("SELECT input,result FROM command_requests WHERE \"userId\"=$1 AND \"requestId\"=$2").get(user.id, body.requestId));
        if (before) {
            if (before.input !== serialized)
                throw new DomainError('请求编号已经用于其他内容', 409);
            return JSON.parse(String(before.result));
        }
        const after = await store.latestSequence();
        // Later commands may reference messages created earlier in this batch.
        const results=[];
        // The batch owns rollback. Individual commands need no extra savepoint
        // around their existing send transaction; any failure aborts the batch.
        for(const command of body.commands)results.push(await executeWithinTransaction({store,user,requestId:command.id,messageId:command.id,signature},command.method,command.path,command.body));
        const parents = new Set(body.commands.map(command => typeof command.body.parentMessageId === 'string' ? command.body.parentMessageId : 'root'));
        // Persist the command outcome before doing transport-only projection work.
        const result = { results, sequence: (await store.latestSequence()), projection: { after, parents: [...parents] } };
        (await store.db.prepare("INSERT INTO command_requests VALUES ($1,$2,$3,$4)").run(user.id, body.requestId, serialized, JSON.stringify(result)));
        return result;
    });
    // Receipts written before this boundary was introduced already contain snapshots.
    if (!receipt.projection) return receipt;
    const { projection, ...result } = receipt;
    try {
        const snapshots = await store.read(() => Promise.all((projection.parents as string[])
            .map(parent => snapshot(store, parent, { after: projection.after }, user.id))));
        return { ...result, snapshots };
    } catch (error) {
        console.error('命令已提交，工作台快照将在增量同步时恢复', error);
        return result;
    }
}
