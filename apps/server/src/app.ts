import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { DomainError, Store } from './db.js';
import { checkOrigin, currentSession, login, logout, register, requireCsrf, requireSession, verifyDeviceSignature } from './auth.js';
import { processDue, send } from './messages.js';
import { changes, context, listMessages } from './queries.js';
import { markedPage, notifications, personalMessages } from './personal.js';
import { createUiRouter } from './ui.js';
import { journalManifest } from './export-response.js';
const query = z.object({ parent: z.string().max(100).optional(), cursor: z.string().max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), q: z.string().max(200).optional(), relation: z.string().max(80).optional(), author: z.string().max(100).optional() }).strict();
const personalQuery = query.extend({ filter: z.enum(['normal', 'follow', 'read', 'unread', 'block', 'archive']).optional(), after: z.coerce.number().int().nonnegative().optional() });
export async function createApp(options: {
    databaseUrl?: string;
    databaseSchema?: string;
    settlementTickMs?: number;
} = {}) {
    const databaseUrl=options.databaseUrl??process.env.DATABASE_URL;
    if(!databaseUrl)throw new Error('请配置 DATABASE_URL 连接 PostgreSQL');
    const app = express(), store = await Store.open(databaseUrl,{schema:options.databaseSchema??process.env.DATABASE_SCHEMA});
    const migrationRow=await store.db.prepare("SELECT value FROM settings WHERE key='migration'").get();
    const readOnlyRehearsal=migrationRow&&JSON.parse(String(migrationRow.value)).mode==='read-only-rehearsal';
    if(readOnlyRehearsal) app.use((req,res,next)=>{
        if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&!['/api/login','/api/logout','/api/ui/snapshot/query'].includes(req.path)) {
            res.status(503).json({error:'真实数据只读迁移演练；阻断项尚未解决，业务写入和结算已禁用'});
            return;
        }
        next();
    });
    const get=(path:string,handler:(req:Request,res:Response,next:NextFunction)=>Promise<unknown>)=>
        app.get(path,(req,res,next)=>{void store.read(()=>handler(req,res,next)).catch(next);});
    const clients = new Map<Response, {
        after: number;
        cursorOnly: boolean;
    }>();
    let closed=false;
    let publishing:Promise<void>|undefined;
    const writeChange = (res: Response, state: {
        after: number;
        cursorOnly: boolean;
    }, change: {
        sequence: number;
    }) => {
        if (res.writableEnded || change.sequence <= state.after)
            return;
        state.after = change.sequence;
        if (!res.write(`id: ${change.sequence}\ndata: ${JSON.stringify(state.cursorOnly ? { sequence: change.sequence } : change)}\n\n`)) {
            // Finish the bounded queued frame, then let EventSource reconnect from its last complete ID.
            clients.delete(res);
            res.end();
        }
    };
    const publish = ():Promise<void> => {
        if(closed)return Promise.resolve();
        if(publishing)return publishing;
        publishing=(async()=>{
            // Each subscriber owns its cursor. Joining during a database read must
            // never skip earlier events already delivered to another subscriber.
            for(let batch=0;batch<100&&clients.size&&!closed;batch++) {
                const after=Math.min(...[...clients.values()].map(state=>state.after));
                const page=await changes(store,after,100);
                for(const change of page.changes)
                    for(const [res,state] of clients) {
                        if(state.after<after)continue;
                        writeChange(res,state,change);
                    }
                if(!page.hasMore&&![...clients.values()].some(state=>state.after<after))break;
            }
        })().finally(()=>{publishing=undefined;});
        return publishing;
    };
    app.locals.store = store;
    if (process.env.TRUST_PROXY === 'loopback')
        app.set('trust proxy', 'loopback');
    else if (process.env.TRUST_PROXY === '1')
        app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.path.startsWith('/api/'))
            res.setHeader('Cache-Control', 'no-store');
        try {
            if (['POST', 'PUT', 'PATCH', "DELETE"].includes(req.method))
                checkOrigin(req);
            next();
        }
        catch (error) {
            next(error);
        }
    });
    const attempts = new Map<string, {
        at: number;
        count: number;
    }>();
    const limitAuth = (req: Request) => {
        const key = req.ip ?? 'local', now = Date.now(), before = attempts.get(key);
        if (before && now - before.at < 60000) {
            if (++before.count > 30)
                throw new DomainError('尝试过于频繁，请稍后重试', 429);
        }
        else
            attempts.set(key, { at: now, count: 1 });
        if (attempts.size > 1000)
            for (const [key, item] of attempts)
                if (now - item.at > 60000)
                    attempts.delete(key);
    };
    app.use(['/api/register', '/api/login', '/api/ui/auth/signing-key'], (req, _res, next) => {
        try { if (req.method === 'POST') limitAuth(req); next(); } catch (error) { next(error); }
    });
    get('/api/session', async (req, res,next) => {try{res.json(await currentSession(store, req));}catch(error){next(error);}});
    get('/api/me/marks', async (req, res, next) => { try {
        const session = (await requireSession(store, req));
        const input = z.object({ ids: z.string().max(11000) }).strict().parse(req.query);
        res.json((await markedPage(store, session.user.id, input.ids.split(',').filter(Boolean))));
    }
    catch (error) {
        next(error);
    } });
    get('/api/me/messages', async (req, res, next) => { try {
        const session = (await requireSession(store, req));
        res.json((await personalMessages(store, session.user.id, personalQuery.parse(req.query))));
    }
    catch (error) {
        next(error);
    } });
    get('/api/me/notifications', async (req, res, next) => { try {
        const session = (await requireSession(store, req));
        res.json((await notifications(store, session.user.id, personalQuery.parse(req.query))));
    }
    catch (error) {
        next(error);
    } });
    get('/api/health', async (_req, res,next) => {try{await store.db.prepare('SELECT 1').get();res.json({ ok: true });}catch(error){next(error);}});
    get('/api/users/:id', async (req, res, next) => { try {
        res.json(req.params.id === 'system' ? { id: 'system', name: '公论规则', founder: false } : (await store.user(req.params.id!)));
    }
    catch (error) {
        next(error);
    } });
    get('/api/setup', async (_req, res,next) => {try { const initialized = !!(await store.db.prepare("SELECT 1 FROM users LIMIT 1").get()); res.json({ initialized, founderKeyRequired: !initialized && process.env.NODE_ENV === 'production' }); }catch(error){next(error);}});
    app.post('/api/register', async (req, res, next) => { try {
        res.status(201).json((await register(store, req.body, res)).session);
        await publish().catch(error=>console.error('发布消息变更失败',error));
    }
    catch (error) {
        next(error);
    } });
    app.post('/api/login', async (req, res, next) => { try {
        res.json((await login(store, req.body, res)));
    }
    catch (error) {
        next(error);
    } });
    app.post('/api/logout', async (req, res, next) => { try {
        (await logout(store, req, res));
        res.json({ ok: true });
    }
    catch (error) {
        next(error);
    } });
    app.use('/api/ui', createUiRouter(store, publish));
    get('/api/messages', async (req, res, next) => { try {
        res.json((await listMessages(store, query.parse(req.query))));
    }
    catch (error) {
        next(error);
    } });
    get('/api/messages/:id/context', async (req, res, next) => { try {
        res.json((await context(store, req.params.id!)));
    }
    catch (error) {
        next(error);
    } });
    get('/api/messages/:id', async (req, res, next) => { try {
        const revision = req.query.revision === undefined ? undefined : Number(req.query.revision);
        if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
            throw new DomainError('版本无效');
        res.json((await store.message(req.params.id!, revision)));
    }
    catch (error) {
        next(error);
    } });
    get('/api/messages/:id/history', async (req, res, next) => {
        try {
            (await store.message(req.params.id!));
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
            const before = req.query.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.cursor);
            if (!Number.isSafeInteger(before) || before < 1)
                throw new DomainError('版本游标无效');
            const rows = (await store.db.prepare("SELECT revision,body FROM revisions WHERE \"messageId\"=$1 AND revision<$2 ORDER BY revision DESC LIMIT $3").all(req.params.id!, before, limit + 1));
            res.json({ messages: rows.slice(0, limit).map(r => JSON.parse(r.body as string)), nextCursor: rows.length > limit ? String(rows[limit - 1]!.revision) : null });
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/messages', async (req, res, next) => { try {
        const session = (await requireCsrf(store, req)), signature = (await verifyDeviceSignature(store, req, session));
        res.status(201).json((await send(store, session.user, req.body, { signature })));
        await publish().catch(error=>console.error('发布消息变更失败',error));
    }
    catch (error) {
        next(error);
    } });
    get('/api/ledger', async (req, res, next) => {
        try {
            const session = (await requireSession(store, req)), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
            const before = req.query.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.cursor);
            if (!Number.isSafeInteger(before) || before < 1)
                throw new DomainError('账本游标无效');
            const rows = (await store.db.prepare("SELECT position AS cursor,* FROM ledger WHERE \"userId\"=$1 AND position<$2 ORDER BY position DESC LIMIT $3").all(session.user.id, before, limit + 1));
            res.json({ entries: rows.slice(0, limit).map(({ cursor: _cursor, position:_position, ...row }) => row), account: (await store.account(session.user.id)), nextCursor: rows.length > limit ? String(rows[limit - 1]!.cursor) : null });
        }
        catch (error) {
            next(error);
        }
    });
    get('/api/rules', async (req, res, next) => {
        try {
            if (req.query.version === undefined) {
                res.json((await store.rules()));
                return;
            }
            const version = Number(req.query.version);
            if (!Number.isSafeInteger(version) || version < 1)
                throw new DomainError('规则版本无效');
            const row = (await store.db.prepare("SELECT body FROM rule_versions WHERE version=$1").get(version));
            if (!row)
                throw new DomainError('规则版本不存在', 404);
            res.json(JSON.parse(row.body as string));
        }
        catch (error) {
            next(error);
        }
    });
    get('/api/rules/history', async (req, res, next) => {
        try {
            const before = Number(req.query.cursor ?? Number.MAX_SAFE_INTEGER);
            if (!Number.isSafeInteger(before) || before < 1)
                throw new DomainError('规则游标无效');
            const rows = (await store.db.prepare("SELECT * FROM rule_versions WHERE version<$1 ORDER BY version DESC LIMIT 101").all(before));
            res.json({ versions: rows.slice(0, 100).map(({ body, ...row }) => ({ ...row, rules: JSON.parse(body as string) })), nextCursor: rows.length > 100 ? String(rows[99]!.version) : null });
        }
        catch (error) {
            next(error);
        }
    });
    get('/api/changes', async (req, res, next) => { try {
        const after = Number(req.query.after ?? 0);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));
        res.json((await changes(store, after, limit)));
    }
    catch (error) {
        next(error);
    } });
    app.get('/api/events', async (req, res, next) => {
        try {
        let after = Number(req.get('Last-Event-ID') ?? req.query.after ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) {
            next(new DomainError('变更游标无效'));
            return;
        }
        res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const state = { after, cursorOnly: req.query.mode === 'cursor' };
        clients.set(res, state);
        res.write(': connected\n\n');
        req.on('close', () => clients.delete(res));
        await publish();
        }catch(error){clients.delete(res);if(res.headersSent)res.end();else next(error);}
    });
    get('/api/export', async (req, res, next) => {
        try {
            // The export consists only of public records; account authentication material is never selected.
            const after = Number(req.query.after ?? 0), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));
            const page = (await changes(store, after, limit));
            const versions = new Set<number>(page.changes.flatMap(change => change.messages.map((message: {
                ruleVersion: number;
            }) => message.ruleVersion)));
            const rules = (await Promise.all([...versions].map(async (version) => (await store.db.prepare("SELECT * FROM rule_versions WHERE version=$1").get(version))))).filter(Boolean).map(row => ({ ...row, body: undefined, rules: JSON.parse(row!.body as string) }));
            res.json({ format: 'gonglun-2', regionId: (await store.setting('region')), ledgerId: 'local', programVersion: '2.0.0', rules: (await store.rules()), ruleHistory: rules, journal: await journalManifest(store), ...page });
        }
        catch (error) {
            next(error);
        }
    });
    app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (res.headersSent)
            return;
        if (error instanceof ZodError) {
            res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') });
            return;
        }
        if (error instanceof DomainError) {
            res.status(error.status).json({ error: error.message });
            return;
        }
        if (error instanceof SyntaxError) {
            res.status(400).json({ error: '请求 JSON 无效' });
            return;
        }
        if ((error as {
            type?: string;
        })?.type === 'entity.too.large') {
            res.status(413).json({ error: '消息过大' });
            return;
        }
        console.error(error);
        res.status(500).json({ error: '操作失败，所有本次变更已回滚' });
    });
    let ticking:Promise<void>|undefined;
    const timer = setInterval(() => {
        if(closed||ticking||readOnlyRehearsal)return;
        ticking=(async()=>{try{await processDue(store);await publish();}catch(error){console.error('延时结算或同步失败',error);}})().finally(()=>{ticking=undefined;});
    }, options.settlementTickMs ?? 1000);
    timer.unref();
    const heartbeat = setInterval(() => { for (const [response] of clients)
        if (!response.write(': heartbeat\n\n')) {
            clients.delete(response);
            response.end();
        } }, 15000);
    heartbeat.unref();
    const stop=()=>{closed=true;clearInterval(timer);clearInterval(heartbeat);for(const [response] of clients)response.end();clients.clear();};
    let closing:Promise<void>|undefined;
    const close = ():Promise<void> => {
        if(closing)return closing;
        stop();
        closing=(async()=>{await Promise.allSettled([ticking,publishing]);await store.close();})();
        return closing;
    };
    app.locals.stop=stop;
    app.locals.close = close;
    return Object.assign(app, { store, close });
}
