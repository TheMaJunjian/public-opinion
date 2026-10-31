import { sendExport } from './export-response.js';
import { readingState, markReading, readingUpdateSchema } from './reading-state.js';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { relations, textOf, type Message } from '@gonglun/core';
import { z } from 'zod';
import { currentSession, requireCsrf, requireSession, rotateSigningKey, verifyDeviceSignature } from './auth.js';
import { DomainError, id, Store } from './db.js';
import { dataOf } from './economy.js';
import { executeBatch, executeCommand, previewBatch } from './ui-commands.js';
import { sendSnapshot } from './snapshot-response.js';
import { windowSnapshot } from './window-snapshot.js';
import {bodyVersionSchema} from './reference-schema.js';
import {validateBodyVersion} from './validation.js';
import { accountView, allUsers, attentionUsers, relationViewType, messageView, paginate, parentOf, roundView, scopeMessages, snapshot, stakesFor, tagCounts, tagCountsFor, scopeView, userView, viewsFor, type RecordData } from './ui-projections.js';
/** Transport views for the established interaction model. The domain contains messages only. */
export function createUiRouter(store: Store, publish: () => Promise<void>) {
    const router = Router();
    router.post('/body-versions/resolve',(req,res,next)=>{
        void store.read(async()=>{const version=bodyVersionSchema.parse(req.body);res.json({message:await validateBodyVersion(store,version)});}).catch(next);
    });
    const get=(path:string,handler:(req:Request,res:Response,next:NextFunction)=>Promise<unknown>)=>
        router.get(path,(req,res,next)=>{void store.read(()=>handler(req,res,next)).catch(next);});
    get('/reading-state',async(req,res)=>{
        const session=await requireSession(store,req);
        res.set('Cache-Control','private, no-store').json({marks:await readingState(store,session.user.id)});
    });
    router.post('/reading-state',async(req,res,next)=>{
        try {
            const session=await requireCsrf(store,req),{marks}=readingUpdateSchema.parse(req.body);
            const saved=await store.sessionTransaction(()=>markReading(store,session.user.id,marks));
            res.set('Cache-Control','private, no-store').json({marks:saved});
        } catch(error){next(error);}
    });
    router.post('/snapshot/query', (req, res, next) => {
        void store.read(async () => sendSnapshot(req, res, await windowSnapshot(store, req.body))).catch(next);
    });
    get('/snapshot', async (req, res, next) => { try {
        await sendSnapshot(req, res, await snapshot(store, String(req.query.parent ?? 'root'), req.query, (await currentSession(store, req))?.user.id));
    }
    catch (e) {
        next(e);
    } });
    get('/scope', async (req, res, next) => { try {
        res.json((await scopeView(store, String(req.query.parent ?? 'root'))));
    }
    catch (e) {
        next(e);
    } });
    get('/message-context', async (req, res, next) => { try {
        const ids = [...new Set(z.array(z.string().min(1).max(100)).min(1).max(50)
            .parse(Array.isArray(req.query.id) ? req.query.id : [req.query.id]))];
        const messages = await Promise.all(ids.map(id => store.message(id)));
        const views = await viewsFor(store, messages);
        res.json({ messages: views, relations: views.filter(view => view.relationType) });
    }
    catch (error) { next(error); } });
    get('/messages', async (req, res, next) => {
        try {
            let messages = (await scopeMessages(store, String(req.query.parent ?? 'root')));
            if (req.query.sinceUpdatedAt)
                messages = messages.filter(m => m.updatedAt > String(req.query.sinceUpdatedAt) || (m.updatedAt === String(req.query.sinceUpdatedAt) && m.id > String(req.query.sinceId ?? '')));
            const page = paginate(messages, req.query);
            res.json({ ...page, data: (await viewsFor(store, page.data, String(req.query.parent ?? 'root'))) });
        }
        catch (e) {
            next(e);
        }
    });
    get('/relations', async (req, res, next) => { try {
        const page = paginate((await scopeMessages(store, String(req.query.parent ?? 'root'))).filter(m => relations(m).some(r => r.relation !== 'member-of')), req.query);
        res.json({ ...page, data: (await viewsFor(store, page.data, String(req.query.parent ?? 'root'))) });
    }
    catch (e) {
        next(e);
    } });
    get('/attention-users', async (req, res, next) => { try {
        res.json({ data: (await attentionUsers(store, (await scopeMessages(store, String(req.query.parent ?? 'root'))).map(m => m.id))) });
    }
    catch (e) {
        next(e);
    } });
    get('/tag-counts', async (req, res, next) => { try {
        res.json({ counts: tagCounts((await viewsFor(store, (await scopeMessages(store, String(req.query.parent ?? 'root'))), String(req.query.parent ?? 'root')))) });
    }
    catch (e) {
        next(e);
    } });
    get('/export', async (req, res, next) => {
        try {
            const parent = z.string().min(1).max(100).parse(req.query.parent ?? 'root');
            const base = req.query.after === undefined ? undefined : {
                sequence: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(req.query.after),
                entryCount: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(req.query.baseCount),
                hash: z.string().regex(/^[a-f0-9]{64}$/).parse(req.query.baseHash),
                regionId: z.string().min(1).max(100).parse(req.query.regionId),
                ledgerId: z.string().min(1).max(100).parse(req.query.ledgerId),
            };
            await sendExport(store, req, res, parent, base);
        }
        catch (e) {
            next(e);
        }
    });
    get('/users', async (req, res) => res.json({ data: (await allUsers(store)) }));
    get('/users/:id', async (req, res, next) => { try {
        res.json((await userView(store, req.params.id)));
    }
    catch (e) {
        next(e);
    } });
    get('/users/:id/messages', async (req, res, next) => { try {
        (await store.user(req.params.id));
        const rows = (await store.db.prepare("SELECT body FROM messages WHERE \"authorId\"=$1 ORDER BY \"createdAt\",id").all(req.params.id)).map(r => JSON.parse(String(r.body)) as Message), page = paginate(rows, req.query);
        res.json({ ...page, data: (await viewsFor(store, page.data)) });
    }
    catch (e) {
        next(e);
    } });
    get('/users/:id/stances', async (req, res, next) => {
        try {
            (await store.user(req.params.id));
            const all = (await store.db.prepare("SELECT body FROM revisions WHERE revision=1 AND (body::jsonb #>> '{authorId}')=$1 ORDER BY position DESC").all(req.params.id)).map(r => JSON.parse(String(r.body)) as Message);
            const scoped = req.query.scopeMessageId ? new Set((await scopeMessages(store, String(req.query.scopeMessageId))).map(m => m.id)) : null;
            const rows = all.filter(m => !scoped || scoped.has(m.id)), stanceRows: RecordData[] = [], tagRows: RecordData[] = [], stakeRows: RecordData[] = [];
            for (const message of rows) {
                const view = (await messageView(store, message)), parent = (await parentOf(store, message.id)), scope = (await scopeView(store, parent)), targets = view.targetRefs.map((r: RecordData) => r.reference.messageId), target = targets[0] ? (await store.message(targets[0])) : null;
                const base = { id: message.id, relationMessageId: message.id, scopeMessageId: parent === 'root' ? null : parent, scopeTitle: scope.title, createdAt: message.createdAt, amount: message.spending.wager, targetMessageId: target?.id ?? null, content: target ? textOf(target) : textOf(message) };
                if (['AGREE', 'DISAGREE'].includes(view.relationType ?? ''))
                    stanceRows.push({ ...base, kind: 'relation', type: view.relationType, messageKind: target ? (await messageView(store, target)).kind : 'TEXT', targetRelationType: target ? relationViewType(target) : null });
                if (['TAG', 'RECOMMEND', 'ARCHIVE'].includes(view.relationType ?? ''))
                    tagRows.push({ ...base, kind: 'tag', relationType: view.relationType, label: view.payload.label ?? view.payload.title ?? view.relationType, subType: view.payload.subType ?? null, customLabel: view.payload.customLabel ?? null, amount: message.spending.recommendation });
                if (message.spending.wager)
                    stakeRows.push({ ...base, kind: 'stake', messageId: target?.id ?? message.id, messageKind: target ? (await messageView(store, target)).kind : view.kind });
            }
            const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(200, Math.max(1, Number(req.query.limit) || 30)), slice = (rows: RecordData[]) => rows.slice((page - 1) * limit, page * limit);
            res.json({ user: { id: req.params.id }, stances: { relations: slice(stanceRows), stakes: slice(stakeRows), tags: slice(tagRows) }, pagination: { page, limit, totalRelations: stanceRows.length, totalStakes: stakeRows.length, totalTags: tagRows.length } });
        }
        catch (e) {
            next(e);
        }
    });
    get('/points/balance', async (req, res, next) => { try {
        res.json((await accountView(store, (await requireSession(store, req)).user.id)));
    }
    catch (e) {
        next(e);
    } });
    get('/points/transactions', async (req, res, next) => {
        try {
            const session = (await requireSession(store, req)), rows = (await store.db.prepare("SELECT * FROM ledger WHERE \"userId\"=$1 ORDER BY position").all(session.user.id));
            let available = 0;
            const result = (await Promise.all(rows.map(async ({position:_position,...row}) => { available += Number(row.amount); return { ...row, type: Number(row.lockedDelta) > 0 ? 'LOCK' : Number(row.lockedDelta) < 0 ? 'UNLOCK' : Number(row.amount) < 0 ? 'SPEND' : 'TRANSFER', balanceAfter: available, data: { reason: row.reason, messageId: row.messageId, messageRevision: row.messageRevision, scopeMessageId: row.messageId ? (await parentOf(store, String(row.messageId))) : null, lockedDelta: row.lockedDelta, ruleVersion: row.ruleVersion } }; }))).reverse();
            res.json(paginate(result, req.query, 100));
        }
        catch (e) {
            next(e);
        }
    });
    get('/rules/current', async (_req, res) => { const rules = (await store.rules()), row = (await store.db.prepare("SELECT \"createdAt\" FROM rule_versions WHERE version=$1").get(rules.version)); res.json({ id: `rule-${rules.version}`, version: rules.version, status: 'ACTIVE', description: null, createdAt: row?.createdAt, parameters: { ...rules, protocolFee: rules.protocolFee, registrationBonus: rules.initialGrant, minStakeAmount: 0, relationMinStake: {} } }); });
    get('/messages/:id/stakes', async (req, res, next) => { try {
        (await store.message(req.params.id));
        const value = (await stakesFor(store, [req.params.id]))[req.params.id]!;
        const type = req.query.settlementType;
        if (type === 'TRUTH' || type === 'VALUE') {
            value.pool = value.pools[type];
            value.counts = value.countsByType[type];
            value.stakes = value.stakes.filter((stake: RecordData) => stake.settlementType === type);
        }
        res.json(value);
    }
    catch (e) {
        next(e);
    } });
    get('/messages/:id/rounds', async (req, res, next) => { try {
        (await store.message(req.params.id));
        const rows = (await store.db.prepare("SELECT id FROM rounds WHERE (body::jsonb #>> '{target,messageId}')=$1 OR (body::jsonb #>> '{subjectId}')=$2 ORDER BY position DESC").all(req.params.id, req.params.id)), user = (await currentSession(store, req))?.user.id;
        res.json({ data: (await Promise.all(rows.map(async (row) => (await roundView(store, String(row.id), user))))) });
    }
    catch (e) {
        next(e);
    } });
    get('/rounds/:id', async (req, res, next) => { try {
        res.json((await roundView(store, req.params.id, (await currentSession(store, req))?.user.id)));
    }
    catch (e) {
        next(e);
    } });
    get('/audit-logs', async (req, res, next) => {
        try {
            let messages = req.query.scopeMessageId ? (await scopeMessages(store, String(req.query.scopeMessageId))) : (await scopeMessages(store));
            if (req.query.actorId)
                messages = messages.filter(m => m.authorId === req.query.actorId);
            if (req.query.entityId)
                messages = messages.filter(m => m.id === req.query.entityId || m.parts.some(p => p.type === 'relation' && Object.values(p.roles).flat().some(b => b.reference.messageId === req.query.entityId)));
            let rows = (await Promise.all(messages.reverse().map(async (m) => { const type = relationViewType(m), signature = (await store.db.prepare("SELECT \"publicKey\",signature,payload,\"deviceId\" FROM signatures WHERE \"messageId\"=$1").get(m.id)); return { id: m.id, actorId: m.authorId, actor: (await userView(store, m.authorId)), action: type ? `${type}_CREATED` : 'MESSAGE_CREATED', entityType: 'Message', entityId: m.id, scopeMessageId: (await parentOf(store, m.id)) === 'root' ? null : (await parentOf(store, m.id)), createdAt: m.createdAt, signature, data: { summary: textOf(m) || type, details: { parts: m.parts, spending: m.spending, ruleVersion: m.ruleVersion, programVersion: m.programVersion, revision: m.revision } } }; })));
            if (req.query.action)
                rows = rows.filter(row => row.action === req.query.action);
            if (req.query.entityType)
                rows = rows.filter(row => row.entityType === req.query.entityType);
            res.json(paginate(rows, req.query));
        }
        catch (e) {
            next(e);
        }
    });
    get('/revenue/pool', async (_req, res) => {
        const distributed = (await store.db.prepare("SELECT COALESCE(SUM((p.value::jsonb #>> '{value,total}')::bigint),0) AS n FROM revisions m,jsonb_array_elements(m.body::jsonb -> 'parts') p WHERE m.revision=1 AND (p.value::jsonb #>> '{type}')='data' AND (p.value::jsonb #>> '{value,source}')='operations'").get())!;
        const balance = (await store.setting<number>('operating')), totalDistributed = Number(distributed.n);
        res.json({ id: 'local', balance, totalDistributed, totalReceived: balance + totalDistributed, updatedAt: new Date().toISOString() });
    });
    get('/revenue/distributions', async (req, res, next) => {
        try {
            const messages = (await store.db.prepare("SELECT body FROM revisions WHERE revision=1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(body::jsonb -> 'parts') p WHERE (p.value::jsonb #>> '{value,source}')='operations') ORDER BY position DESC").all()).map(r => JSON.parse(String(r.body)) as Message);
            const rows = ((await Promise.all(messages.map(async (m) => { const data = dataOf(m); return (await Promise.all((data.allocations as unknown as RecordData[] ?? []).map(async (a, index) => ({ id: `${m.id}:${index}`, messageId: m.id, userId: a.userId, user: (await userView(store, a.userId)), amount: a.amount, reason: a.reason, messageIds: a.messageIds, createdAt: m.createdAt })))); }))).flat());
            res.json(paginate(rows, req.query));
        }
        catch (e) {
            next(e);
        }
    });
    router.post('/auth/signing-key', async (req, res, next) => { try {
        const session = (await rotateSigningKey(store, req, res));
        res.json({ message: '设备签名密钥已更新', user: session.user, session });
    }
    catch (e) {
        next(e);
    } });
    router.post('/commands/preview', async (req, res, next) => { try {
        const session = await requireCsrf(store, req);
        await verifyDeviceSignature(store, req, session);
        const input = z.object({ batch: z.unknown(), parents: z.array(z.string().min(1).max(100)).max(20).optional() }).strict().parse(req.body);
        res.json(await previewBatch(store, session.user, input.batch, input.parents));
    } catch (error) { next(error); } });
    router.post('/commands', async (req, res, next) => { try {
        const session = (await requireCsrf(store, req)), signature = (await verifyDeviceSignature(store, req, session));
        const parsed = z.object({ requestId: z.string() }).passthrough().parse(req.body);
        if (req.get('x-request-id') && req.get('x-request-id') !== parsed.requestId)
            throw new DomainError('请求编号不一致');
        const result = (await executeBatch(store, session.user, req.body, signature));
        // The command is already committed. Event delivery can retry on the next
        // poll and must not turn a successful write into a failed command response.
        await publish().catch(error=>console.error('发布消息变更失败',error));
        res.status(201).json(result);
    }
    catch (e) {
        next(e);
    } });
    router.use(async (req, res, next) => { if (req.method !== 'POST' && req.method !== 'PATCH') {
        next();
        return;
    } try {
        const session = (await requireCsrf(store, req)), signature = (await verifyDeviceSignature(store, req, session)), requestId = req.get('x-request-id') ?? id();
        const result = (await executeCommand({ store, user: session.user, requestId, signature }, req.method, req.path, req.body));
        await publish().catch(error=>console.error('发布消息变更失败',error));
        res.status(req.method === 'POST' ? 201 : 200).json(result);
    }
    catch (e) {
        next(e);
    } });
    return router;
}
