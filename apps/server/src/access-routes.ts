import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Store } from './db.js';
import { requireCsrf, requireSession } from './auth.js';
import { createInvitation, listInvitations, listManagedAccounts, revokeInvitation, setAccountDisabled } from './access-management.js';

const pageSchema = z.object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(Number.MAX_SAFE_INTEGER),
  limit: z.coerce.number().int().min(1).max(100).default(30), q: z.string().trim().max(40).default('') }).strict();

export function createAccessRouter(store: Store) {
  const router = Router();
  const read = (path: string, run: (req: Request, res: Response) => Promise<void>) =>
    router.get(path, (req, res, next) => { void store.read(() => run(req, res)).catch(next); });
  const write = (path: string, run: (req: Request, actorId: string) => Promise<unknown>) =>
    router.post(path, async (req, res, next) => {
      try { const session = await requireCsrf(store, req); res.json(await run(req, session.user.id)); }
      catch (error) { next(error); }
    });
  read('/invites', async (req, res) => {
    const session = await requireSession(store, req), page = pageSchema.parse(req.query);
    res.json(await listInvitations(store, session.user.id, page.before, page.limit));
  });
  read('/accounts', async (req, res) => {
    const session = await requireSession(store, req), page = pageSchema.parse(req.query);
    res.json(await listManagedAccounts(store, session.user.id, page.before, page.limit, page.q));
  });
  write('/invites', async (req, actorId) => {
    const { expiresInDays } = z.object({ expiresInDays: z.number().int().min(1).max(365) }).strict().parse(req.body);
    return createInvitation(store, actorId, expiresInDays);
  });
  write('/invites/:id/revoke', async (req, actorId) => {
    await revokeInvitation(store, actorId, z.string().uuid().parse(req.params.id)); return { ok: true };
  });
  write('/accounts/:id/status', async (req, actorId) => {
    const { disabled } = z.object({ disabled: z.boolean() }).strict().parse(req.body);
    await setAccountDisabled(store, actorId, z.string().min(1).max(100).parse(req.params.id), disabled); return { ok: true };
  });
  return router;
}
