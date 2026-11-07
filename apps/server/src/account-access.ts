import { DomainError, type Store } from './db.js';

/** Session writers share the user lock; disabling takes it exclusively. */
export async function assertActiveAccount(store: Store, userId: string, lock = false) {
  if (lock && !await store.db.prepare('SELECT id FROM users WHERE id=$1 FOR SHARE').get(userId))
    throw new DomainError('用户不存在', 404);
  if (await store.db.prepare('SELECT 1 FROM disabled_accounts WHERE "userId"=$1').get(userId))
    throw new DomainError('账号已停用，请联系管理员', 403, 'ACCOUNT_DISABLED');
}
