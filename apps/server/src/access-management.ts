import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AccessPage, ManagedAccount, RegistrationInvite } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { assertActiveAccount } from './account-access.js';

const hash = (code: string) => createHash('sha256').update(code).digest('hex');

async function requireAdministrator(store: Store, actorId: string) {
  await assertActiveAccount(store, actorId);
  if (!(await store.user(actorId)).founder) throw new DomainError('仅管理员可以执行此操作', 403);
}
async function audit(store: Store, actorId: string, action: string, targetId: string, at: string) {
  await store.db.prepare('INSERT INTO access_admin_actions VALUES($1,$2,$3,$4,$5)')
    .run(randomUUID(), actorId, action, targetId, at);
}

export async function createInvitation(store: Store, actorId: string, expiresInDays: number) {
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365)
    throw new DomainError('有效期须为 1 到 365 天');
  return store.transaction(async () => {
    await requireAdministrator(store, actorId);
    const code = randomBytes(24).toString('base64url'), id = randomUUID(), at = Date.now();
    const createdAt = new Date(at).toISOString(), expiresAt = new Date(at + expiresInDays * 86400000).toISOString();
    const hint = `…${code.slice(-6)}`;
    await store.db.prepare(`INSERT INTO registration_invites(id,"tokenHash",hint,"createdBy","createdAt","expiresAt")
      VALUES($1,$2,$3,$4,$5,$6)`).run(id, hash(code), hint, actorId, createdAt, expiresAt);
    await audit(store, actorId, 'invite-created', id, createdAt);
    const invite: RegistrationInvite = { id, hint, createdAt, expiresAt, usedAt: null, usedBy: null, usedByName: null, revokedAt: null, status: 'available' };
    return { code, invite };
  });
}

/** Called inside the registration transaction: a failed account creation restores the invitation. */
export async function consumeInvitation(store: Store, code: string | undefined, userId: string) {
  if (!code?.trim()) throw new DomainError('注册需要管理员提供的邀请码', 403);
  const at = new Date().toISOString();
  const consumed = await store.db.prepare(`UPDATE registration_invites SET "usedBy"=$2,"usedAt"=$3
    WHERE "tokenHash"=$1 AND "usedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt">$3 RETURNING id`)
    .get(hash(code.trim()), userId, at);
  if (!consumed) throw new DomainError('邀请码无效、已使用、已过期或已撤销', 403);
}

export async function revokeInvitation(store: Store, actorId: string, inviteId: string) {
  return store.transaction(async () => {
    await requireAdministrator(store, actorId);
    const invite = await store.db.prepare('SELECT "usedAt","revokedAt" FROM registration_invites WHERE id=$1').get(inviteId);
    if (!invite) throw new DomainError('邀请码不存在', 404);
    if (invite.usedAt) throw new DomainError('邀请码已使用，不能撤销；可在账号管理中停用该账号', 409);
    if (invite.revokedAt) return;
    const at = new Date().toISOString();
    await store.db.prepare('UPDATE registration_invites SET "revokedAt"=$2 WHERE id=$1').run(inviteId, at);
    await audit(store, actorId, 'invite-revoked', inviteId, at);
  });
}

export async function listInvitations(store: Store, actorId: string, before: number, limit: number): Promise<AccessPage<RegistrationInvite>> {
  await requireAdministrator(store, actorId);
  const rows = await store.db.prepare(`SELECT i.id,i.hint,i."createdAt",i."expiresAt",i."usedAt",i."usedBy",i."revokedAt",i.position,u.name AS "usedByName"
    FROM registration_invites i LEFT JOIN users u ON u.id=i."usedBy" WHERE i.position<$1 ORDER BY i.position DESC LIMIT $2`)
    .all<Omit<RegistrationInvite, 'status'> & { position: number }>(before, limit + 1);
  const at = new Date().toISOString();
  return { items: rows.slice(0, limit).map(({ position: _position, ...row }) => ({ ...row,
    status: row.usedAt ? 'used' : row.revokedAt ? 'revoked' : row.expiresAt <= at ? 'expired' : 'available' })),
    nextCursor: rows.length > limit ? String(rows[limit - 1]!.position) : null };
}

export async function listManagedAccounts(store: Store, actorId: string, before: number, limit: number, query = ''): Promise<AccessPage<ManagedAccount>> {
  await requireAdministrator(store, actorId);
  const rows = await store.db.prepare(`SELECT u.id,u.name,u.founder,u."createdAt",u.position,d."disabledAt"
    FROM users u LEFT JOIN disabled_accounts d ON d."userId"=u.id
    WHERE u.position<$1 AND strpos(lower(u.name),lower($3))>0 ORDER BY u.position DESC LIMIT $2`)
    .all<Omit<ManagedAccount, 'founder'> & { founder: number; position: number }>(before, limit + 1, query);
  return { items: rows.slice(0, limit).map(({ position: _position, ...row }) => ({ ...row, founder: !!row.founder })),
    nextCursor: rows.length > limit ? String(rows[limit - 1]!.position) : null };
}

export async function setAccountDisabled(store: Store, actorId: string, userId: string, disabled: boolean) {
  return store.transaction(async () => {
    await requireAdministrator(store, actorId);
    const user = await store.db.prepare('SELECT founder FROM users WHERE id=$1 FOR UPDATE').get(userId);
    if (!user) throw new DomainError('用户不存在', 404);
    if (user.founder || actorId === userId) throw new DomainError('不能停用管理员账号', 403);
    const at = new Date().toISOString();
    if (disabled) {
      const result = await store.db.prepare('INSERT INTO disabled_accounts VALUES($1,$2,$3) ON CONFLICT("userId") DO NOTHING').run(userId, at, actorId);
      await store.db.prepare('DELETE FROM sessions WHERE "userId"=$1').run(userId);
      // Stop the pending usage timer; restoring an account starts a new waiting round.
      await store.db.prepare('UPDATE usage_points SET "readyAt"=NULL WHERE "userId"=$1').run(userId);
      if (result.rowCount) await audit(store, actorId, 'account-disabled', userId, at);
    } else {
      const result = await store.db.prepare('DELETE FROM disabled_accounts WHERE "userId"=$1').run(userId);
      if (result.rowCount) await audit(store, actorId, 'account-restored', userId, at);
    }
  });
}
