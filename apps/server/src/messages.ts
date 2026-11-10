import { relations, replaceReference, targetInvestmentDimension, type Change, type Membership, type Message, type Part, type RelationPart, type SendResult, type User } from '@gonglun/core';
import { DomainError, Mutation, now, Store } from './db.js';
import { applyOrganization, reconcileOrganizationEffects, reconcileOrganizationRevision } from './organizations.js';
import { dataOf, distributeOperations, grant, hasEffect, injectRevenue, lockDelegation, markEffect, oneTarget, openSettlement, placeMessageValueWager, placeValueWager, placeWager, relationTarget, settleDue, terminate } from './economy.js';
import { parseSend, partsSchema, readReference, rulesSchema, validateReferences } from './validation.js';
import { recordPersonal } from './personal-actions.js';
import { notificationRecipients } from './notifications.js';
import { normalizeAnnotationStance } from './annotation-stances.js';
import {chargeMessage} from './message-spending.js';
import {bindCommandContexts} from './reference-contexts.js';
import { assertActiveAccount } from './account-access.js';
import { REVIEW_RELATIONS } from '@gonglun/core';
import { enrollModeration, normalizeReviewStance, processModerationAction, moderationCase, moderationPolicy } from './moderation.js';
import { assertReferenceAllowed } from './moderation-visibility.js';
import { normalizeReviewDiscussion } from './review-discussion.js';
import { hasReviewContext, reviewContextOf, sameReviewContext } from '@gonglun/core';

const actions=new Set(['agree','disagree','terminate','authorize','delegate','distribute','credit',...REVIEW_RELATIONS]);
async function authorize(tx: Mutation, message: Message, user: User) {
    if (!user.founder)
        throw new DomainError('当前版本需要项目发起人授权', 403);
    const ref = oneTarget(message, 'authorize');
    if (ref.partId || ref.memberId || ref.path?.length || ref.range)
        throw new DomainError('授权须指向完整提案');
    const proposal = await tx.store.message(ref.messageId, ref.revision), key = `authorized:${proposal.id}:${proposal.revision}`;
    if((await moderationPolicy(tx.store)).enabled){const review=await moderationCase(tx.store,proposal.id,proposal.revision);if(review&&review.status!=='approved')throw new DomainError('提案须先通过传播审核',409);}
    if ((await hasEffect(tx.store, key)))
        throw new DomainError('提案已生效', 409);
    const kinds = relations(proposal).filter(r => ['amend', 'rule-change', 'recharge', 'revenue-injection'].includes(r.relation));
    if (kinds.length !== 1)
        throw new DomainError('目标不是可授权提案');
    const data = dataOf(proposal);
    if (kinds[0]!.relation === 'amend') {
        const target = oneTarget(proposal, 'amend');
        const current = await tx.store.message(target.messageId);
        if(relations(current).some(p=>REVIEW_RELATIONS.has(p.relation)||['review-record','review-enrollment'].includes(p.relation)))throw new DomainError('审核记录不可改写，请追加新的关系消息',409);
        if (data.expectedRevision !== current.revision || (target.revision !== undefined && target.revision !== current.revision))
            throw new DomainError('目标内容已变更，请重新提交修改', 409);
        const replacement = data.parts ?? data.value;
        if (replacement === undefined)
            throw new DomainError('缺少修改内容');
        let parts: Part[];
        try {
            parts = partsSchema.parse(replaceReference(current, target, replacement)) as Part[];
        }
        catch (error) {
            throw new DomainError(error instanceof Error ? error.message : '修改内容无效');
        }
        if(parts.some(p=>p.type==='relation'&&(REVIEW_RELATIONS.has(p.relation)||['review-record','review-enrollment'].includes(p.relation))))
            throw new DomainError('审核记录只能通过审核操作新增，不能由修改消息生成',409);
        for(const part of parts){
            const refs=part.type==='relation'?Object.values(part.roles).flatMap(bindings=>bindings.map(b=>b.reference)):part.type==='display'&&part.target?[part.target]:[];
            for(const ref of refs)await assertReferenceAllowed(tx.store,ref,user.id);
        }
        if (hasReviewContext(current) && !sameReviewContext(reviewContextOf(current), reviewContextOf({parts})))
            throw new DomainError('审核讨论不能改为其他审核范围或移出审核临时分类',409);
        await validateReferences(tx.store, parts);
        // Placement execution history is immutable even when the message is edited.
        const reserved = new Set(['membership-history', 'organization-memberships']);
        parts = [...parts.filter(part => !reserved.has(part.id)), ...current.parts.filter(part => reserved.has(part.id))];
        const updated = { ...current, parts, revision: current.revision + 1, updatedAt: now(), ruleVersion: (await tx.store.rules()).version };
        await tx.put(updated);
        // Only organization structure changes are executed when an edit becomes effective.
        // A historical wager, credit, or authorization is never replayed by editing its content.
        await enrollModeration(tx,updated);
        await reconcileMemberships(tx, current, updated);
    }
    else if (kinds[0]!.relation === 'rule-change') {
        const proposed = data.rules ?? data;
        if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed))
            throw new DomainError('规则提案内容无效');
        const currentRules = await tx.store.rules();
        const proposedWeights = proposed.contributionWeights;
        if (proposedWeights !== undefined && (!proposedWeights || typeof proposedWeights !== 'object' || Array.isArray(proposedWeights)))
            throw new DomainError('贡献权重规则无效');
        const next = rulesSchema.parse({ ...currentRules, ...proposed, contributionWeights: { ...currentRules.contributionWeights, ...(proposedWeights ?? {}) }, version: currentRules.version + 1 });
        await tx.store.set('rules', next);
        await tx.store.db.prepare(`INSERT INTO rule_versions(version,body,"authorizationId","createdAt") VALUES ($1,$2,$3,$4)`).run(next.version, JSON.stringify(next), message.id, now());
    }
    else if (kinds[0]!.relation === 'revenue-injection')
        await injectRevenue(tx, proposal);
    else
        await grant(tx, proposal, { messageId: message.id });
    await markEffect(tx.store, key, { authorizationId: message.id, at: now() });
}
async function reconcileMemberships(tx: Mutation, before: Message, after: Message) {
    const previous = relations(before).filter(p => ['classify', 'merge', 'summary', 'arrange', 'members', 'member-of'].includes(p.relation));
    const next = relations(after).filter(p => ['classify', 'merge', 'summary', 'arrange', 'members', 'member-of'].includes(p.relation));
    if (JSON.stringify(previous) === JSON.stringify(next))
        return;
    if (await reconcileOrganizationRevision(tx, before, after)) return;
    const ownMembership = (await tx.store.db.prepare(`SELECT * FROM memberships WHERE "memberId"=$1`).get(before.id)) as unknown as Membership | undefined;
    const oldMembers = (await tx.store.db.prepare(`SELECT * FROM memberships WHERE "sourceId"=$1`).all(before.id)) as unknown as Membership[];
    for (const row of oldMembers) {
        const memberOfOwned = previous.some(part => part.relation === 'member-of' && part.id === row.sourcePartId);
        if (row.parentId !== before.id && row.memberId !== before.id && !memberOfOwned)
            continue;
        const memberId = row.memberId;
        // Editing an organization's member list releases old children into its containing
        // organization before regrouping. The organization itself keeps its placement.
        if (memberId === before.id && row.bindingId === 'inherited-parent')
            continue;
        await tx.store.db.prepare(`DELETE FROM memberships WHERE "memberId"=$1`).run(memberId);
        tx.removed.add(memberId);
        tx.memberships.delete(memberId);
        if (row.parentId === before.id && ownMembership) {
            const released: Membership = { memberId, parentId: ownMembership.parentId, sourceId: after.id, sourcePartId: row.sourcePartId, bindingId: row.bindingId, sourceRevision: after.revision };
            await tx.store.db.prepare(`INSERT INTO memberships("memberId","parentId","sourceId","sourcePartId","bindingId","sourceRevision") VALUES ($1,$2,$3,$4,$5,$6)`).run(memberId, released.parentId, released.sourceId, released.sourcePartId ?? null, released.bindingId ?? null, released.sourceRevision ?? null);
            tx.memberships.set(memberId, released);
            tx.removed.delete(memberId);
        }
    }
    await applyOrganization(tx, after);
}
export async function send(store: Store, user: User, raw: unknown, options: {
    messageId?: string;
    signature?: {
        deviceId: string;
        publicKey: string;
        payload: string;
        signature: string;
    };
} = {}): Promise<SendResult> {
    const supplied = parseSend(raw), serialized = JSON.stringify(supplied);
    return await store.transaction(async () => {
        await assertActiveAccount(store, user.id);
        const previous = (await store.db.prepare(`SELECT input,result FROM requests WHERE "userId"=$1 AND "requestId"=$2`).get(user.id, supplied.requestId)) as {
            input: string;
            result: string;
        } | undefined;
        if (previous) {
            if (previous.input !== serialized)
                throw new DomainError('相同请求编号不能用于不同内容', 409);
            return JSON.parse(previous.result) as SendResult;
        }
        const input=await normalizeReviewDiscussion(store,await normalizeReviewStance(store,supplied),user.id);
        for(const part of input.parts){
            // Review operations address identity and status, never permit reusing the body.
            const refs=part.type==='relation'?Object.entries(part.roles).filter(([role])=>role!=='target'||!REVIEW_RELATIONS.has(part.relation)&&part.relation!=='review-context').flatMap(([,bindings])=>bindings.map(b=>b.reference)):part.type==='display'&&part.target?[part.target]:[];
            for(const ref of refs)await assertReferenceAllowed(store,ref,user.id);
        }
        await validateReferences(store, input.parts);
        const actionParts = input.parts.filter(p => p.type === 'relation' && actions.has(p.relation));
        if (actionParts.length > 1)
            throw new DomainError('一条消息只能执行一个资金或授权操作');
        const wager = input.wager ?? 0, recommendation = input.recommendation ?? 0;
        const reviewAction=actionParts.some(p=>p.type==='relation'&&REVIEW_RELATIONS.has(p.relation));
        if(reviewAction&&input.parts.some(p=>p.type==='relation'&&!REVIEW_RELATIONS.has(p.relation)&&p.relation!=='member-of'))
            throw new DomainError('审核记录不能同时执行其他关系操作');
        if(reviewAction&&(wager||recommendation||input.selfStance))throw new DomainError('审核押注与真假、价值投入须分开记账');
        if (wager === 0 && recommendation === 0 && !reviewAction)
            throw new DomainError('真假和价值至少一项须大于 0');
        if (input.selfStance && actionParts.some(p => p.type === 'relation' && ['agree', 'disagree'].includes(p.relation)))
            throw new DomainError('自我表态不能同时执行其他资金操作');
        const normalized = await bindCommandContexts(store,await normalizeAnnotationStance(store, input));
        if(normalized.parts.some(part=>part.type==='relation'&&['read','unread'].includes(part.relation.toLowerCase())))
            throw new DomainError('已读是个人查看状态，请使用标记已读操作');
        const annotations = normalized.parts.filter((part): part is RelationPart => part.type === 'relation' && targetInvestmentDimension(part.relation) === 'VALUE');
        const valueVote = annotations.length === 1 && annotations[0]!.roles.target?.length === 1
            && !normalized.parts.some(part => part.type === 'relation' && actions.has(part.relation)) ? annotations[0] : undefined;
        if (annotations.length && !valueVote) throw new DomainError('标注投入必须对应一个明确目标，且不能同时执行其他资金操作');
        if (valueVote && wager !== 0) throw new DomainError('标注的真假投入必须为 0，请使用价值投入');
        const truthVote = normalized.parts.some(part => part.type === 'relation' && ['agree','disagree'].includes(part.relation));
        if (truthVote && recommendation !== 0) throw new DomainError('赞同、反对的价值投入必须为 0，请使用真假投入');
        if (valueVote && normalized.selfStance) throw new DomainError('标注投入属于目标消息，不能同时对标注自身押注');
        if (wager > 0 && annotations.length && !valueVote && !actionParts.length)
            throw new DomainError('价值投票押注必须对应一个明确目标');
        if (normalized.selfStance && normalized.parts.some(part => part.id === 'self-stance'))
            throw new DomainError('自我表态的部件编号已被占用，请更换该部件编号');
        if (normalized !== input) {
            partsSchema.parse(normalized.parts);
            await validateReferences(store, normalized.parts);
        }
        if (wager > 0 && !input.selfStance && !valueVote && !actionParts.some(p => p.type === 'relation' && ['agree', 'disagree'].includes(p.relation)))
            throw new DomainError('押注须选择赞同、反对、推荐或冷藏');
        const tx = new Mutation(store,{authorId:user.id,joinContribution:input.joinContribution??{wager,recommendation}});
        const notifyTargets = normalized.parts.flatMap(part=>part.type==='relation'&&part.relation==='notify'?(part.roles.target??[]).map(binding=>binding.reference.messageId):[]);
        if(notifyTargets.length&&!(await notificationRecipients(store,[...new Set(notifyTargets)],user.id)).length)
            throw new DomainError('通知目标没有其他作者或关注者，请重新选择目标');
        // Finish elapsed rounds before accepting an incoming wager at the new cutoff.
        await settleDue(tx);
        const protocol = (await store.rules()).protocolFee;
        const message = await tx.create(user.id, normalized.parts, { protocol, recommendation, wager }, options.messageId);
        // A value annotation's wager belongs to its subject, so it needs no self-agreement message.
        if (normalized.selfStance && !valueVote) {
            message.parts.push({ id: 'self-stance', type: 'relation', relation: normalized.selfStance === 'pro' ? 'agree' : 'disagree', roles: { target: [{ id: 'self', reference: { messageId: message.id,revision:message.revision,context:{kind:'MESSAGE'} } }] } });
            await tx.put(message);
        }
        // Releasing existing escrows may record protocol debt; new reviews and appeals must be funded.
        const reviewAdministration=reviewAction&&actionParts.some(p=>p.type==='relation'&&['review-settle','review-finalize'].includes(p.relation));
        await chargeMessage(store,message,true,reviewAdministration);
        await enrollModeration(tx,message);
        await processModerationAction(tx,message,input.reviewWager??0);
        if (!valueVote) await placeMessageValueWager(tx, message);
        await applyOrganization(tx, message);
        if (valueVote) await placeValueWager(tx, message, valueVote, recommendation);
        for (const part of relations(message)) {
            if (part.relation === 'agree' || part.relation === 'disagree')
                await placeWager(tx, message, wager);
            if (part.relation === 'terminate')
                await terminate(tx, message);
            if (part.relation === 'open-settlement' || part.relation === 'open-value-settlement')
                await openSettlement(tx, message);
            if (part.relation === 'delegate')
                await lockDelegation(tx, message);
            if (part.relation === 'fulfill') {
                const ref = relationTarget(part);
                if (!(await store.db.prepare(`SELECT 1 FROM escrows WHERE "messageId"=$1`).get(ref.messageId)))
                    throw new DomainError('目标不是委托');
            }
            if (part.relation === 'low-quality' || part.relation === 'amend') {
                const ref = relationTarget(part);
                await readReference(store, ref);
            }
            if (part.relation === 'authorize')
                await authorize(tx, message, user);
            if (part.relation === 'distribute')
                await distributeOperations(tx, message);
            if (part.relation === 'credit') {
                if (!user.founder)
                    throw new DomainError('仅项目发起人可以公开发放', 403);
                await grant(tx, message, undefined);
            }
        }
        await reconcileOrganizationEffects(tx);
        const change = await tx.commit();
        await recordPersonal(store, message);
        if (options.signature) {
            const signature = options.signature;
            await store.db.prepare(`INSERT INTO signatures("messageId","userId","deviceId","publicKey",payload,signature,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`).run(message.id, user.id, signature.deviceId, signature.publicKey, signature.payload, signature.signature, now());
        }
        const result: SendResult = { message: await store.message(message.id), change, account: await store.account(user.id) };
        await store.db.prepare(`INSERT INTO requests("userId","requestId",input,result) VALUES ($1,$2,$3,$4)`).run(user.id, input.requestId, serialized, JSON.stringify(result));
        return result;
    });
}
export async function processDue(store: Store): Promise<Change | null> {
    // Most ticks are idle. Recheck under the ledger lock only when work exists;
    // concurrent workers still settle each due round exactly once.
    if (!await store.db.prepare("SELECT 1 FROM rounds WHERE (body::jsonb #>> '{status}')='waiting' AND (body::jsonb #>> '{endsAt}')<=$1 LIMIT 1").get(now())) return null;
    return await store.transaction(async () => { const tx = new Mutation(store); if (!(await settleDue(tx)))
        return null; return await tx.commit(); });
}
