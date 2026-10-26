import { organization, relations, replaceReference, textOf, type Message, type Reference, type Change, type MessageState, type UserView, type TargetRef, type NativeMessageView, type NativeMessageStakes, type ScopeView, type WorkbenchSnapshot, isRelationView } from '@gonglun/core';
import { DomainError, Store } from './db.js';
import { dataOf } from './economy.js';
import { statesFor } from './projections.js';
import { personalMarks } from './personal.js';
import { messageDisplayDependency } from '@gonglun/core';
import { displayAttachmentSql } from './display-dependencies.js';
export type RecordData = Record<string, any>;
export const userView = async (store: Store, userId: string) => {
    if(userId==='system') return {id:'system',username:'公论规则',name:'公论规则',founder:false,createdAt:''};
    const user=await store.user(userId);
    return {...user,username:user.name,createdAt:user.createdAt??String((await store.db.prepare('SELECT MIN("createdAt") AS at FROM ledger WHERE "userId"=$1').get(userId))?.at??'')};
};
interface ViewContext {
    users: Map<string, UserView>;
    messages: Map<string, Message>;
    members: Map<string, string[]>;
    rounds: Map<string, RecordData>;
    recipients: Map<string, string[]>;
}
const cachedMessage = async (store: Store, id: string, revision?: number, context?: ViewContext): Promise<Message> => {
    const cached = context?.messages.get(`${id}:${revision ?? 'current'}`);
    if (cached) return cached;
    try { return await store.message(id, revision); }
    catch (error) {
        if (revision !== undefined || !(error instanceof DomainError) || error.status !== 404) throw error;
        const historical = await store.db.prepare('SELECT body FROM revisions WHERE "messageId"=$1 ORDER BY revision DESC LIMIT 1').get(id);
        if (!historical) throw error;
        return JSON.parse(String(historical.body)) as Message;
    }
};
const cachedUser = async (store: Store, id: string, context?: ViewContext) => context?.users.get(id) ?? (await userView(store, id));
export const primaryRelation = (message: Message) => relations(message).find(part =>
    !((part.id === 'self-stance' || part.id.startsWith('minimum-self-stance-'))
      && ['agree','disagree'].includes(part.relation) && part.roles.target?.length === 1 && part.roles.target[0]!.reference.messageId === message.id)
    && (part.relation !== 'member-of'||!!part.roles.member?.length));
const relationViewTypes: Record<string, string> = { follow: 'ATTENTION', amend: 'CORRECT', 'rule-change': 'PROPOSAL', recharge: 'PROPOSAL', 'revenue-injection': 'PROPOSAL', delegate: 'DELEGATION', fulfill: 'DELEGATION', 'member-of': 'JOIN', 'low-quality': 'ARCHIVE', 'open-settlement': 'ROUND', settlement: 'ROUND', distribution: 'ROUND_RESULT', terminate: 'OPERATIONS', release: 'CODE_CHANGE' };
export function relationViewType(message: Message): string | null { const relation = primaryRelation(message); return String(dataOf(message).uiType ?? (relation ? (relationViewTypes[relation.relation] ?? relation.relation.toUpperCase()) : '')) || null; }
export async function referenceView(store: Store, reference: Reference, context?: ViewContext): Promise<TargetRef & { reference: Reference }> {
    const target = (await cachedMessage(store, reference.messageId, reference.revision, context)), relation = primaryRelation(target);
    if (reference.range) {
        const part = target.parts.find(p => p.id === reference.partId);
        const text = part?.type === 'text' ? part.text : part?.type === 'code' ? part.source : part?.type === 'web' ? part.excerpt : '';
        const quoted=reference.context&&'version' in reference.context&&reference.context.version?await readReference(store,reference):text.slice(reference.range.start,reference.range.end);
        return { kind: 'text-fragment', messageId: target.id, text:String(quoted), hash: `${target.id}:${target.revision}:${reference.partId}:${reference.range.start}:${reference.range.end}`, reference };
    }
    return relation ? { kind: 'relation', relationId: target.id, part: reference.partId === relation.id ? 'decoration' : reference.partId ? 'label' : 'whole', reference } : { kind: 'message', messageId: target.id, reference };
}
export function scopeSql(parent: string): {
    cte: string;
    predicate: string;
    params: string[];
} {
    if (parent === 'root')
        return { cte: '', predicate: '1=1', params: [] };
    return { cte: `WITH RECURSIVE descendants(id) AS (
        SELECT $1::text UNION SELECT m."memberId" FROM memberships m JOIN descendants d ON m."parentId"=d.id
    ), scoped(id) AS (
        SELECT id FROM descendants UNION SELECT r."sourceId" FROM refs r JOIN descendants d ON r."targetId"=d.id JOIN messages source ON source.id=r."sourceId"
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(source.body::jsonb->'parts') part,jsonb_each(part.value->'roles') role,jsonb_array_elements(role.value) binding
            WHERE (part.value->>'relation'<>'member-of' OR part.value->'roles' ? 'member') AND binding.value #>> '{reference,messageId}'=r."targetId")
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(source.body::jsonb->'parts') part WHERE part.value->>'type'='display' AND part.value #>> '{target,messageId}'=r."targetId")
    ), attached(id) AS (
        SELECT id FROM scoped UNION SELECT source.id FROM attached host JOIN refs r ON r."targetId"=host.id
        JOIN messages source ON source.id=r."sourceId" WHERE source.id<>host.id AND ${displayAttachmentSql('source','host.id')}
    )`, predicate: 'm.id IN (SELECT id FROM attached) AND m.id<>$1', params: [parent] };
}
export async function scopeMessages(store: Store, parent = 'root'): Promise<Message[]> {
    if (parent !== 'root')
        (await store.message(parent));
    const scope = scopeSql(parent);
    return (await store.db.prepare(`${scope.cte} SELECT m.body FROM messages m WHERE ${scope.predicate} ORDER BY m."createdAt",m.id`).all(...scope.params)).map(row => JSON.parse(String(row.body)) as Message);
}
export async function parentOf(store: Store, messageId: string): Promise<string> {
    const visited = new Set<string>();
    while (!visited.has(messageId)) {
        visited.add(messageId);
        const dependency = messageDisplayDependency(await store.message(messageId));
        if (dependency !== null) {
            const host = dependency.find(ref => ref.messageId !== messageId)?.messageId;
            if (!host) return 'root';
            messageId = host;
            continue;
        }
        return String((await store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get(messageId))?.parentId ?? 'root');
    }
    return 'root';
}
/** Organization titles are saved independently from their descriptive bodies.
 * Use the same saved name for cards, scope headers, deltas and archives. */
function organizationTitle(message: Message): string {
    const relation = primaryRelation(message), data = dataOf(message);
    if (relation && ['classify', 'summary'].includes(relation.relation) && typeof data.title === 'string')
        return data.title;
    return textOf(message);
}
export async function scopeView(store: Store, messageId: string): Promise<ScopeView> {
    if (messageId === 'root')
        return { messageId: null, title: '公论' };
    const message = (await store.message(messageId));
    return { messageId, title: organizationTitle(message) || '消息' };
}
async function contentView(store: Store, message: Message, context?: ViewContext): Promise<string> {
    const content = textOf(message);
    if (content)
        return content;
    const data = dataOf(message), relation = primaryRelation(message);
    if (typeof data.content === 'string' && data.content)
        return data.content;
    if (relation?.relation === 'distribution') {
        const labels: Record<string, string> = { wager: '对赌分配', operations: '运营收入分配', delegation: '委托报酬', penalty: '低质量处罚', reversal: '分配调整', grant: '贡献点发放' };
        const allocations = Array.isArray(data.allocations) ? data.allocations as unknown as RecordData[] : [];
        return `${labels[String(data.source)] ?? '分配'}：${Number(data.total ?? 0)} 贡献点${allocations.length ? '；' + (await Promise.all(allocations.map(async (a) => `${(await cachedUser(store, String(a.userId), context)).username} ${Number(a.amount) > 0 ? '+' : ''}${a.amount}`))).join('，') : ''}。`;
    }
    const target = relation?.roles.target?.[0]?.reference;
    const targetMessage = target ? (await cachedMessage(store, target.messageId, target.revision, context)) : undefined;
    if (relation?.relation === 'follow' || relation?.relation === 'block') return `${relation.relation === 'follow' ? '关注' : '拉黑'}－${relation.reason === 'YES' ? '是' : '否'}${targetMessage ? `：「${textOf(targetMessage).slice(0,120)}」` : ''}`;
    const labels: Record<string, string> = { settlement: '发起结算', 'open-settlement': '请求发起结算', terminate: '请求终止结算', agree: '赞同', disagree: '反对', amend: '提出修改', authorize: '授权生效', follow: '关注', read: '标记已读', unread: '标记未读', recommend: '推荐', archive: '冷藏', 'low-quality': '低质量评价', 'rule-change': '规则修改', distribute: '请求分配运营收入', recharge: '充值分账申请', 'member-of': '加入组织' };
    return `${relation ? labels[relation.relation] ?? relationViewType(message) ?? relation.relation : '消息'}${targetMessage ? `：「${textOf(targetMessage).slice(0, 120) || relationViewType(targetMessage) || '消息'}」` : ''}`;
}
export async function messageView(store: Store, message: Message, parent?: string, state?: MessageState, context?: ViewContext): Promise<NativeMessageView> {
    const relation = primaryRelation(message), data = dataOf(message), type = relationViewType(message) ?? (['ROUND','ROUND_RESULT'].includes(String(data.kind))?String(data.kind):null);
    const sources = relation?.roles.source ?? relation?.roles.reason ?? (relation?.relation==='member-of'?relation.roles.parent:undefined) ?? [];
    let references = (relation?.roles.target ?? relation?.roles.members ?? relation?.roles.member ?? []).map(b => b.reference);
    const declaredTargetRefs = references;
    if (relation && ['classify', 'summary', 'merge', 'arrange'].includes(relation.relation)) {
        const members=context ? context.members.get(message.id) ?? [] : (await store.db.prepare("SELECT \"memberId\" FROM memberships WHERE \"parentId\"=$1 ORDER BY position").all(message.id)).map(row=>String(row.memberId));
        const current=new Set(members),ordered=[...new Set(declaredTargetRefs.map(ref=>ref.messageId).filter(id=>current.has(id)))],declared=new Set(ordered);
        references=[...ordered,...members.filter(id=>!declared.has(id))].map(messageId=>({messageId}));
    }
    let kind = String(data.kind ?? (type === 'ROUND' ? 'ROUND' : type === 'ROUND_RESULT' ? 'ROUND_RESULT' : type === 'PROPOSAL' ? 'GOVERNANCE' : type === 'CODE_CHANGE' ? 'CODE' : type === 'OPERATIONS' ? 'OPERATIONS' : relation ? 'RELATION' : 'TEXT'));
    const payload: RecordData = { ...data };
    if (relation?.relation === 'follow' || relation?.relation === 'block') payload.subType = relation.reason;
    if (message.parts.some(part => part.id === 'organization-memberships')) payload.independentMemberships = true;
    const history = message.parts.find(part => part.id === 'membership-history' && part.type === 'data');
    if (history?.type === 'data' && history.value && typeof history.value === 'object' && !Array.isArray(history.value))
        payload.membershipHistory = history.value.membershipHistory;
    delete payload.uiType;
    delete payload.kind;
    delete payload.contentType;
    if (type === 'CORRECT') {
        payload.correctionKind = data.correctionKind === 'WIDTH' ? 'WIDTH' : data.correctionKind === 'MEANING' ? 'MEANING' : 'TEXT';
        const body = message.parts.find(part => part.id === 'corrected-body' && part.type === 'text');
        if (body?.type === 'text') {
            payload.correctionAfterContent = body.text; payload.correctionContent = body.text;
            if (data.value !== undefined) payload.correctionValue = data.value;
        } else if (relation?.relation === 'amend' && typeof data.value === 'string' && !relation.roles.target?.[0]?.reference.partId) {
            const reference = relation.roles.target?.[0]?.reference;
            if (reference) payload.correctionBeforeContent = textOf(await cachedMessage(store, reference.messageId, reference.revision ?? (typeof data.expectedRevision === 'number' ? data.expectedRevision : undefined), context));
            payload.correctionAfterContent = data.value; payload.correctionContent = data.value;
        }
    }
    if (relation && ['classify', 'summary'].includes(relation.relation))
        payload.title = organizationTitle(message);
    if (relation?.relation === 'amend' && data.value !== undefined) {
        payload.correctionContent = data.value;
        const reference = relation.roles.target?.[0]?.reference;
        if (reference?.partId) {
            const target = await cachedMessage(store, reference.messageId, reference.revision ?? (typeof data.expectedRevision === 'number' ? data.expectedRevision : undefined), context);
            const part = target.parts.find(part => part.id === reference.partId);
            if (part && ['text', 'code', 'web'].includes(part.type) && !reference.memberId
                && (!reference.path?.length || reference.path.length === 1 && ['text', 'source', 'excerpt'].includes(String(reference.path[0])))) {
                // Preview the immutable proposal against its original revision.
                // Invalid proposals remain readable and can still be rejected.
                try {
                    const parts = replaceReference(target, reference, data.value);
                    payload.correctionBeforeContent = textOf(target);
                    payload.correctionAfterContent = textOf({ ...target, parts });
                } catch { /* Authorization validates the proposed replacement. */ }
            }
        }
    }
    if (relation?.relation === 'delegate') {
        payload.delegationKind = 'CREATE';
        payload.rewardAmount = data.reward;
    }
    if (relation?.relation === 'fulfill')
        payload.delegationKind = 'FULFILL';
    const display = message.parts.find(p => p.type === 'display');
    if (display?.type === 'display')
        payload.targetLayout = display.layout === 'row' ? 'single-row' : display.layout === 'columns' ? 'multi-column' : 'single-column';
    if (relation?.relation === 'settlement' || ['ROUND','ROUND_RESULT'].includes(kind)) {
        const roundId=typeof data.roundId==='string'?data.roundId:message.id;
        const row = context ? undefined : (await store.db.prepare("SELECT body FROM rounds WHERE id=$1").get(roundId)), round = context?.rounds.get(roundId) ?? (row ? JSON.parse(String(row.body)) : undefined);
        if (round) {
            payload.roundId = roundId;
            payload.targetMessageId = round.target.messageId;
            payload.settlementType=round.settlementType??'TRUTH';
            if(!references.length) references=[{messageId:round.subjectId??round.target.messageId}];
        }
    }
    if (relation?.relation === 'notify') {
        payload.notifyUserIds = context ? context.recipients.get(message.id) ?? [] : (await store.db.prepare("SELECT DISTINCT \"userId\" FROM notification_receipts WHERE \"sourceId\"=$1").all(message.id)).map(r => String(r.userId));
        payload.notifyUsers = (await Promise.all(payload.notifyUserIds.map(async (id: string) => (await cachedUser(store, id, context)))));
    }
    const stateValue = state ?? (await statesFor(store, [message.id]))[0];
    const projectRef = (ref:Reference) => referenceView(store,ref,context);
    return { id: message.id, kind, contentType: data.contentType === 'MARKDOWN' ? 'MARKDOWN' : 'TEXT', content: (await contentView(store, message, context)), createdAt: message.createdAt, updatedAt: message.updatedAt, createdBy: (await cachedUser(store, message.authorId, context)), relationType: type, relSourceId: sources[0]?.reference.messageId ?? null, sourceMessageId: sources[0]?.reference.messageId ?? null, sourceRefs: sources.map(b => b.reference), targetRefs: (await Promise.all(references.map(projectRef))), declaredTargetRefs: (await Promise.all(declaredTargetRefs.map(projectRef))), relationPayload: payload, payload, revision: message.revision, parts: message.parts, sequence: message.sequence, spending: message.spending, state: stateValue, executedStance: stateValue?.executedStance, supersededBy: typeof data.supersededBy === 'string' ? data.supersededBy : null };
}
export async function viewsFor(store: Store, messages: Message[], parent?: string, knownUsers?: UserView[]) {
    const ids = messages.map(m => m.id), states = new Map((await statesFor(store, ids)).map(s => [s.messageId, s])), context: ViewContext = { users: new Map((knownUsers ?? await usersFor(store, messages.map(message => message.authorId))).map(user => [user.id, user])), messages: new Map(), members: new Map(), rounds: new Map(), recipients: new Map() };
    context.users.set('system', (await userView(store, 'system')));
    const refs = new Map<string, Reference>();
    for (const message of messages) {
        context.messages.set(`${message.id}:current`, message);
        context.messages.set(`${message.id}:${message.revision}`, message);
        for (const part of relations(message))
            for (const binding of Object.values(part.roles).flat())
                refs.set(`${binding.reference.messageId}:${binding.reference.revision ?? 'current'}`, binding.reference);
    }
    for (let offset = 0; offset < ids.length; offset += 200) {
        const batch = ids.slice(offset, offset + 200), placeholders = batch.map((_,index) => `$${index+1}`).join(',');
        for (const row of (await store.db.prepare(`SELECT "parentId","memberId" FROM memberships WHERE "parentId" IN (${placeholders}) ORDER BY position`).all(...batch))) {
            const parentId = String(row.parentId), memberId = String(row.memberId);
            (context.members.get(parentId) ?? (context.members.set(parentId, []), context.members.get(parentId)!)).push(memberId);
            refs.set(`${memberId}:current`, { messageId: memberId });
        }
        for (const row of (await store.db.prepare(`SELECT id,body FROM rounds WHERE id IN (${placeholders})`).all(...batch)))
            context.rounds.set(String(row.id), JSON.parse(String(row.body)));
        for (const row of (await store.db.prepare(`SELECT DISTINCT "sourceId","userId" FROM notification_receipts WHERE "sourceId" IN (${placeholders})`).all(...batch))) {
            const key = String(row.sourceId);
            (context.recipients.get(key) ?? (context.recipients.set(key, []), context.recipients.get(key)!)).push(String(row.userId));
        }
    }
    const roundIds=[...new Set(messages.map(message=>dataOf(message).roundId).filter((id):id is string=>typeof id==='string'&&!context.rounds.has(id)))];
    for(let offset=0;offset<roundIds.length;offset+=200) for(const row of await store.db.prepare('SELECT id,body FROM rounds WHERE id=ANY($1::text[])').all(roundIds.slice(offset,offset+200))) context.rounds.set(String(row.id),JSON.parse(String(row.body)));
    for(const round of context.rounds.values()) refs.set(`${round.target.messageId}:current`,{messageId:round.target.messageId});
    const missing = [...refs].filter(([key]) => !context.messages.has(key));
    for (let i = 0; i < missing.length; i += 150) {
        const batch = missing.slice(i, i + 150), current = batch.filter(([, ref]) => ref.revision === undefined), historical = batch.filter(([, ref]) => ref.revision !== undefined);
        if (current.length)
            for (const row of (await store.db.prepare('SELECT body FROM messages WHERE id=ANY($1::text[])').all(current.map(([, ref]) => ref.messageId)))) {
                const message = JSON.parse(String(row.body)) as Message;
                context.messages.set(`${message.id}:current`, message);
            }
        if (historical.length)
            for (const row of (await store.db.prepare(`SELECT body FROM revisions WHERE ("messageId",revision) IN (${historical.map((_,index) => `($${index*2+1},$${index*2+2}::integer)`).join(',')})`).all(...historical.flatMap(([, ref]) => [ref.messageId, ref.revision!])))) {
                const message = JSON.parse(String(row.body)) as Message;
                context.messages.set(`${message.id}:${message.revision}`, message);
            }
    }
    return (await Promise.all(messages.map(async (m) => (await messageView(store, m, parent, states.get(m.id), context)))));
}
export function paginate<T>(data: T[], query: RecordData, max = 200) { const page = Math.max(1, Number(query.page) || 1), limit = Math.min(max, Math.max(1, Number(query.limit) || 50)); return { data: data.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: data.length, totalPages: Math.ceil(data.length / limit) } }; }
async function queryUsers(store: Store, ids?: string[]): Promise<UserView[]> {
    if (ids && !ids.length) return [];
    return (await store.db.prepare('SELECT u.id,u.name,u.founder,u."createdAt" FROM users u' + (ids ? ' WHERE u.id=ANY($1::text[])' : '') + ' ORDER BY u.position').all(...(ids ? [ids] : [])))
        .map(row => ({ id: String(row.id), name: String(row.name), username: String(row.name), founder: !!row.founder, createdAt: String(row.createdAt ?? '') }));
}
export const allUsers = (store: Store) => queryUsers(store);
export const usersFor = (store: Store, ids: string[]) => queryUsers(store, [...new Set(ids)]);
export async function accountView(store: Store, userId: string) {
    const account = (await store.account(userId)), rows = (await store.db.prepare("SELECT amount,\"lockedDelta\",reason FROM ledger WHERE \"userId\"=$1 ORDER BY position").all(userId));
    const sum = (fn: (row: RecordData) => number) => rows.reduce((total, row) => total + fn(row), 0);
    const bets = new Map((await store.db.prepare("SELECT id,amount FROM bets WHERE \"userId\"=$1").all(userId)).map(row => [String(row.id), Number(row.amount)])), latest = new Map<string, RecordData>();
    for (const row of (await store.db.prepare("SELECT body FROM rounds WHERE (body::jsonb #>> '{status}')='settled' ORDER BY position").all())) {
        const round = JSON.parse(String(row.body));
        latest.set(round.targetKey, round);
    }
    let totalEarned = 0, totalLost = 0;
    const baseline=await store.db.prepare('SELECT earned,lost FROM account_baselines WHERE "userId"=$1').get(userId);
    totalEarned=Number(baseline?.earned??0);totalLost=Number(baseline?.lost??0);
    for (const round of latest.values()) {
        const principal = (round.betIds as string[]).reduce((sum, id) => sum + (bets.get(id) ?? 0), 0), payout = (round.payouts as RecordData[]).filter(a => a.userId === userId).reduce((sum, a) => sum + Number(a.amount), 0), net = payout - principal;
        totalEarned += Math.max(0, net);
        totalLost += Math.max(0, -net);
    }
    return { points: { available: account.available, locked: account.locked }, balance: { amount: account.available, debtFrozen: account.available < 0 }, breakdown: { initialMinted: sum(r => r.reason === '初始发放' ? Number(r.amount) : 0), totalEarned, totalLost, totalProtocolFees: sum(r => r.reason === '协议费' ? -Number(r.amount) : 0) } };
}
export async function stakesFor(store: Store, ids: string[], knownUsers?: UserView[]): Promise<Record<string, NativeMessageStakes>> {
  const users=new Map((knownUsers??[]).map(user=>[user.id,user])),result:Record<string,NativeMessageStakes>={};
  const claims=new Map<string,Reference>();
  const scopeFor=async(reference:Reference|undefined,type:string)=>{
    if(type==='VALUE'&&reference){
      let subject=claims.get(reference.messageId);
      if(!subject){const claim=await store.message(reference.messageId,reference.revision);subject=relations(claim).find(part=>part.relation==='open-value-settlement')?.roles.target?.[0]?.reference??reference;claims.set(reference.messageId,subject);}
      reference=subject;
    }
    return contextKey(reference?.context??{kind:'UNKNOWN'});
  };
  const scopeValue=(value:NativeMessageStakes,key:string)=>{
    const contexts=value.contexts??={};
    return contexts[key]??={messageId:value.messageId,pool:{lockedPro:0,lockedCon:0},pools:{TRUTH:{lockedPro:0,lockedCon:0},VALUE:{lockedPro:0,lockedCon:0}},stakes:[],counts:{pro:0,con:0},countsByType:{TRUTH:{pro:0,con:0},VALUE:{pro:0,con:0}}};
  };
  for(const id of ids)result[id]={messageId:id,contexts:{},pool:{lockedPro:0,lockedCon:0},pools:{TRUTH:{lockedPro:0,lockedCon:0},VALUE:{lockedPro:0,lockedCon:0}},
    stakes:[],counts:{pro:0,con:0},countsByType:{TRUTH:{pro:0,con:0},VALUE:{pro:0,con:0}}};
  for(let offset=0;offset<ids.length;offset+=200){
    const batch=ids.slice(offset,offset+200);
    const positions=await store.db.prepare('SELECT * FROM stake_positions WHERE "subjectId"=ANY($1::text[]) ORDER BY "createdAt",id').all(batch);
    for(const user of await usersFor(store,[...new Set(positions.map(row=>String(row.userId)).filter(id=>!users.has(id)))]))users.set(user.id,user);
    for(const row of positions){
      const value=result[row.subjectId],type=row.settlementType==='VALUE'?'VALUE':'TRUTH',side=row.side==='pro'?'pro':'con';
      value.counts[side]+=Number(row.amount);value.countsByType[type][side]+=Number(row.amount);
      value.stakes.push({id:row.id,side:side==='pro'?'PRO':'CON',amount:row.amount,createdAt:row.createdAt,roundId:row.roundId,
        settlementType:type,user:users.get(row.userId)!,...(row.reference?{reference:row.reference}:{})});
      const scoped=scopeValue(value,await scopeFor(row.reference,type));scoped.stakes.push(value.stakes.at(-1)!);scoped.counts[side]+=Number(row.amount);scoped.countsByType![type][side]+=Number(row.amount);
    }
    const pools=await store.db.prepare(`SELECT COALESCE(r.body::jsonb->>'subjectId',r.body::jsonb #>> '{target,messageId}') AS subject,
      COALESCE(r.body::jsonb->>'settlementType','TRUTH') AS type,b.side,r.body::jsonb->'target' AS reference,SUM(b.amount) AS amount FROM bets b JOIN rounds r ON r.id=b."roundId"
      WHERE COALESCE(r.body::jsonb->>'subjectId',r.body::jsonb #>> '{target,messageId}')=ANY($1::text[])
      AND r.body::jsonb->>'status'<>'settled' GROUP BY subject,type,b.side,reference`).all(batch);
    for(const row of pools){
      const value=result[row.subject],type=String(row.type),key=row.side==='pro'?'lockedPro':'lockedCon';
      value.pools[type]??={lockedPro:0,lockedCon:0};value.pools[type][key]+=Number(row.amount);value.pool[key]+=Number(row.amount);
      const scoped=scopeValue(value,await scopeFor(row.reference,type));scoped.pools![type]??={lockedPro:0,lockedCon:0};scoped.pools![type][key]+=Number(row.amount);scoped.pool[key]+=Number(row.amount);
    }
    for(const row of await store.db.prepare('SELECT "messageId",amount FROM escrows WHERE "messageId"=ANY($1::text[]) AND "recipientId" IS NULL').all(batch)){
      const value=result[row.messageId];value.pools.DELEGATION??={lockedPro:0,lockedCon:0};
      value.pools.DELEGATION.lockedPro+=Number(row.amount);value.pool.lockedPro+=Number(row.amount);
    }
    for(const row of await store.db.prepare('SELECT * FROM pool_checkpoints WHERE "messageId"=ANY($1::text[])').all(batch)){
      const value=result[row.messageId],type=String(row.settlementType);value.pools[type]??={lockedPro:0,lockedCon:0};
      for(const key of ['lockedPro','lockedCon'] as const){value.pools[type][key]+=Number(row[key]);value.pool[key]+=Number(row[key]);}
    }
  }
  return result;
}
export async function roundView(store: Store, id: string, userId?: string): Promise<RecordData> {
    const row = (await store.db.prepare("SELECT body FROM rounds WHERE id=$1").get(id));
    if (!row)
        throw new DomainError('结算不存在', 404);
    const round = JSON.parse(String(row.body)), declaration = (await store.message(id)), basis = dataOf(declaration), authorId = String(basis.openedBy ?? declaration.authorId);
    const published = await store.db.prepare('SELECT body FROM published_round_reports WHERE id=$1').get(id);
    if (published) return published.body;
    const bets = (await store.db.prepare("SELECT b.*,m.\"createdAt\",m.body FROM bets b JOIN messages m ON m.id=b.\"messageId\" WHERE b.\"targetKey\"=$1 ORDER BY b.position").all(round.targetKey)).filter(b => round.status !== 'settled' || round.betIds.includes(b.id));
    const active = bets.filter(b => b.roundId === id), sum = (side: string, rows = bets) => rows.filter(b => b.side === side).reduce((s, b) => s + Number(b.amount), 0);
    let personalSettlement: RecordData | undefined;
    if (userId) {
        const own = bets.filter(b => b.userId === userId), principal = own.reduce((s, b) => s + Number(b.amount), 0), protocolFee = own.reduce((s, b) => s + (JSON.parse(String(b.body)) as Message).spending.protocol, 0);
        const payout = (round.payouts ?? []).filter((a: RecordData) => a.userId === userId).reduce((s: number, a: RecordData) => s + a.amount, 0);
        if (principal) {
            let previousAfter: number | undefined;
            const previousRow = round.previousRoundId ? (await store.db.prepare("SELECT body FROM rounds WHERE id=$1").get(round.previousRoundId)) : undefined;
            if (previousRow) {
                const previous = JSON.parse(String(previousRow.body)), prior = own.filter(b => previous.betIds.includes(b.id));
                previousAfter = previous.payouts.filter((a: RecordData) => a.userId === userId).reduce((s: number, a: RecordData) => s + a.amount, 0) - prior.reduce((s, b) => s + Number(b.amount) + (JSON.parse(String(b.body)) as Message).spending.protocol, 0);
            }
            const after = payout - principal - protocolFee;
            personalSettlement = { principal: principal + protocolFee, stakePrincipal: principal, protocolFee, after, change: after - (previousAfter ?? 0), ...(previousAfter === undefined ? {} : { previousAfter }) };
        }
    }
    const evaluated=await store.message(round.target.messageId,round.target.revision);
    const subjectReference=relations(evaluated).find(part=>part.relation==='open-value-settlement')?.roles.target?.[0]?.reference??round.target;
    return { id, roundMessageId: id, messageId: round.subjectId ?? round.target.messageId, reference: round.target,subjectReference, createdByUserId: authorId, createdBy: (await userView(store, authorId)), status: round.status === 'settled' ? 'SETTLED' : round.status === 'waiting' ? 'VOTING' : 'OPEN', settlementType: round.settlementType ?? 'TRUTH', result: round.result === 'pro' ? 'TRUE' : round.result === 'con' ? 'FALSE' : round.result === 'tie' ? 'UNKNOWN' : null, previousRoundId: round.previousRoundId, openedAt: round.createdAt, closedAt: round.status === 'settled' ? round.endsAt : null, endsAt: round.endsAt, note: null, settlementPro: round.pro, settlementCon: round.con, totalProAtSettlement: round.pro, totalConAtSettlement: round.con, weights: { TRUE: sum('pro'), FALSE: sum('con'), UNKNOWN: 0 }, roundWeights: { TRUE: sum('pro', active), FALSE: sum('con', active), UNKNOWN: 0 }, totalWeight: sum('pro') + sum('con'), votes: (await Promise.all(active.map(async (b) => ({ id: b.messageId, vote: b.side === 'pro' ? 'TRUE' : 'FALSE', amount: b.amount, createdAt: b.createdAt, user: (await userView(store, String(b.userId))) })))), _count: { votes: active.length }, personalSettlement, distributionId: round.distributionId };
}
export function tagCounts(views: RecordData[]) { const counts: Record<string, Record<string, number>> = {}; for (const message of views) {
    if (!['TAG', 'RECOMMEND', 'ARCHIVE'].includes(message.relationType))
        continue;
    for (const ref of message.targetRefs ?? []) {
        const id = ref.reference?.messageId ?? ref.messageId ?? ref.relationId;
        const value = counts[id] ??= {};
        const type = message.relationType;
        value[type] = (value[type] ?? 0) + 1;
        const subtype = message.payload?.subType ?? message.payload?.label;
        if (subtype)
            value[subtype] = (value[subtype] ?? 0) + 1;
    }
} return counts; }
export async function tagCountsFor(store: Store, ids: string[]) {
    const counts: Record<string, Record<string, number>> = Object.fromEntries(ids.map(id => [id, {}])), sources = new Map<string, Message>();
    for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        if (!batch.length)
            continue;
        for (const row of (await store.db.prepare(`SELECT DISTINCT m.body FROM messages m JOIN refs r ON r."sourceId"=m.id WHERE r."targetId"=ANY($1::text[]) AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.body::jsonb -> 'parts') p WHERE (p.value::jsonb #>> '{relation}') IN ('tag','recommend','archive','low-quality'))`).all(batch))) {
            const message = JSON.parse(String(row.body)) as Message;
            sources.set(message.id, message);
        }
    }
    for (const source of sources.values()) {
        const type = relationViewType(source);
        if (!type || !['TAG', 'RECOMMEND', 'ARCHIVE'].includes(type))
            continue;
        const data = dataOf(source), targets = new Set((primaryRelation(source)?.roles.target ?? []).map(b => b.reference.messageId));
        for (const id of targets) {
            const value = counts[id];
            if (!value)
                continue;
            value[type] = (value[type] ?? 0) + 1;
            const sub = String(data.subType ?? data.label ?? '');
            if (sub)
                value[sub] = (value[sub] ?? 0) + 1;
        }
    }
    return counts;
}
export async function attentionUsers(store: Store, ids?: string[]): Promise<Record<string, string[]>> {
    // Empty arrays clear previous followers on clients that merge incremental records.
    const result: Record<string, string[]> = Object.fromEntries((ids ?? []).map(id => [id, []]));
    if (ids && !ids.length) return result;
    const rows = await store.db.prepare("SELECT \"targetId\",\"authorId\" FROM personal_marks WHERE family='follow' AND action='follow'" + (ids ? ' AND "targetId"=ANY($1::text[])' : '')).all(...(ids ? [ids] : []));
    for (const row of rows) (result[String(row.targetId)] ??= []).push(String(row.authorId));
    return result;
}
export async function snapshot(store: Store, parent: string, query: RecordData, userId?: string): Promise<WorkbenchSnapshot> {
    const batch = Number(query.batch ?? 1);
    if (!Number.isInteger(batch) || batch < 1 || batch > 4) throw new DomainError('快照批次数必须为 1 到 4');
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 200)) * batch, after = Number(query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
        throw new DomainError('变更游标无效');
    const regionId = await store.setting<string>('region');
    if (query.after !== undefined) {
        if ((query.regionId !== undefined && query.regionId !== regionId) || after > await store.latestSequence())
            throw new DomainError('本地消息缓存已失效，请重新加载', 409);
        const changeRows = (await store.db.prepare("SELECT sequence,body FROM changes WHERE sequence>$1 ORDER BY sequence LIMIT 101").all(after)), selected = changeRows.slice(0, 100), changes = selected.map(r => JSON.parse(String(r.body)) as Change), changedIds = [...new Set<string>(changes.flatMap(change => [...change.messages.map((m: Message) => m.id), ...change.states.map((s: RecordData) => s.messageId), ...change.memberships.flatMap((m: RecordData) => [m.memberId, m.parentId]), ...change.removedMemberships, ...(change.removedMessageIds ?? [])]))];
        const scope = scopeSql(parent), messages: Message[] = [], present = new Set<string>();
        for (let i = 0; i < changedIds.length; i += 200) {
            const batch = changedIds.slice(i, i + 200);
            if (!batch.length)
                continue;
            for (const row of (await store.db.prepare(`${scope.cte} SELECT m.body FROM messages m WHERE ${scope.predicate} AND m.id=ANY($${scope.params.length+1}::text[])`).all(...scope.params, batch))) {
                const message = JSON.parse(String(row.body)) as Message;
                messages.push(message);
                present.add(message.id);
            }
        }
        const users = await usersFor(store, [...messages.map(message => message.authorId), ...changes.flatMap(change => change.ledger.map(entry => entry.userId))]), views = (await viewsFor(store, messages, parent, users)), ids = messages.map(m => m.id), marks = [];
        if (userId)
            for (let i = 0; i < ids.length; i += 100)
                marks.push(...(await personalMarks(store, userId, ids.slice(i, i + 100))));
        return { regionId, scope: (await scopeView(store, parent)), messages: views, relations: views.filter(isRelationView), users, stakes: (await stakesFor(store, ids, users)), tagCounts: (await tagCountsFor(store, ids)), attentionUsers: (await attentionUsers(store, ids)), personalStates: marks, sequence: selected.length ? Number(selected.at(-1)!.sequence) : after, hasMore: changeRows.length > 100, nextCursor: null, removedMemberships: [...new Set(changes.flatMap(c => c.removedMemberships))], removedMessageIds: changedIds.filter(id => id !== parent && !present.has(id)) };
    }
    const scope = scopeSql(parent), params: (string | number)[] = [...scope.params], extra: string[] = [];
    const parameter=(value:string|number)=>{params.push(value);return `$${params.length}`;};
    if (query.cursor) {
        let cursor: {
            sequence: number;
            id: string;
        };
        try {
            cursor = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString());
        }
        catch {
            throw new DomainError('分页游标无效');
        }
        if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence<0 || typeof cursor.id !== 'string'||cursor.id.length>100)
            throw new DomainError('分页游标无效');
        const sequence=parameter(cursor.sequence),id=parameter(cursor.id);
        extra.push(`(m.sequence<${sequence} OR (m.sequence=${sequence} AND m.id<${id}))`);
    }
    const bound=parameter(limit+1);
    const rows = (await store.db.prepare(`${scope.cte} SELECT m.body FROM messages m WHERE ${scope.predicate}${extra.length ? ' AND ' + extra.join(' AND ') : ''} ORDER BY m.sequence DESC,m.id DESC LIMIT ${bound}`).all(...params)), messages = rows.slice(0, limit).map(r => JSON.parse(String(r.body)) as Message), last = messages.at(-1), users = query.cursor ? await usersFor(store, messages.map(message => message.authorId)) : await allUsers(store), views = (await viewsFor(store, messages, parent, users)), ids = messages.map(m => m.id);
    const removedMemberships: string[] = [], removedMessageIds: string[] = [];
    if (after) {
        for (const row of (await store.db.prepare("SELECT body FROM changes WHERE sequence>$1").all(after))) {
            const change = JSON.parse(String(row.body));
            removedMemberships.push(...change.removedMemberships);
            removedMessageIds.push(...(change.removedMessageIds ?? []));
            if (parent !== 'root')
                for (const membership of change.memberships)
                    if (membership.parentId !== parent)
                        removedMessageIds.push(membership.memberId);
        }
    }
    const marks = [];
    if (userId)
        for (let i = 0; i < ids.length; i += 100)
            marks.push(...(await personalMarks(store, userId, ids.slice(i, i + 100))));
    return { regionId, scope: (await scopeView(store, parent)), messages: views, relations: views.filter(isRelationView), users, stakes: (await stakesFor(store, ids, users)), tagCounts: (await tagCountsFor(store, ids)), attentionUsers: (await attentionUsers(store, ids)), personalStates: marks, sequence: (await store.latestSequence()), hasMore: false, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ sequence: last.sequence, id: last.id })).toString('base64url') : null, removedMemberships: [...new Set(removedMemberships)], removedMessageIds: [...new Set(removedMessageIds)] };
}
import {readReference} from './validation.js';
import {contextKey} from '@gonglun/core';
