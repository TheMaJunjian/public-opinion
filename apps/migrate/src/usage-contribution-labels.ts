import { updateUsageRewardMessage, type Json, type Message } from '@gonglun/core';
import { Mutation, type Store } from '../../server/src/db.js';

/** Change current summary wording once; preserve the original committed history and all balances. */
export async function migrateUsageContributionLabels(store: Store) {
  const tx = new Mutation(store);
  const rows = await store.db.prepare('SELECT m.body,d.total FROM usage_reward_days d JOIN messages m ON m.id=d."messageId"').all();
  for (const row of rows) {
    const message = JSON.parse(String(row.body)) as Message;
    const allocation = message.parts.find(part => part.id === 'allocation' && part.type === 'data');
    const value = allocation?.type === 'data' ? allocation.value as Record<string,Json> : undefined;
    const inputs = value?.inputs as Record<string,Json> | undefined;
    if (!value || inputs?.reason !== 'usage-daily-summary' || inputs.terminology === 'contribution') continue;
    const parts = message.parts.map(part => part === allocation ? { ...part, value: {
      ...value, inputs: { ...inputs, terminology: 'contribution' },
      allocations: (value.allocations as Record<string,Json>[]).map(item => ({ ...item, reason: '使用贡献汇总' })),
    } as Json } : part);
    await tx.put(updateUsageRewardMessage({ ...message, parts }, Number(row.total), message.sequence, new Date().toISOString()));
  }
  if (tx.messages.size) await tx.commit();
}
