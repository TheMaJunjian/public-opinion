import type { Message } from '@gonglun/core';
import type { Postgres } from '../../server/src/postgres.js';
import { restoreDelegationBody } from './delegation-format.js';

export async function delegationBodyRepairPlan(db: Postgres) {
  const ids: string[] = [];
  for (const row of await db.prepare('SELECT body FROM messages').all()) {
    const message = JSON.parse(String(row.body)) as Message;
    if (restoreDelegationBody(message)) ids.push(message.id);
  }
  return { pending: ids.length, sampleIds: ids.slice(0, 10) };
}
