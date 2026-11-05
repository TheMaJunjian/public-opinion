import type { Distribution, Json, Message } from './types.js';

/** A compact journal update changes only the cumulative, system-authored daily reward. */
export function updateUsageRewardMessage(message: Message, total: number, sequence: number, updatedAt: string): Message {
  const allocation = message.parts.find(part => part.id === 'allocation' && part.type === 'data');
  const value = allocation?.type === 'data' ? allocation.value as unknown as Distribution : undefined;
  const inputs = value?.inputs;
  if (message.authorId !== 'system' || !Number.isSafeInteger(total) || total < 1 || !value || value.source !== 'grant'
    || !inputs || typeof inputs !== 'object' || Array.isArray(inputs) || inputs.reason !== 'usage-daily-summary'
    || typeof inputs.day !== 'string' || value.allocations.length !== 1 || total < value.total) throw new Error('每日使用贡献更新无效');
  // Old committed updates retain their original wording when replayed.
  const label = inputs.terminology === 'contribution' ? '使用贡献' : '使用奖励';
  return { ...message, sequence, updatedAt, parts: message.parts.map(part =>
    part.id === 'body' && part.type === 'text' ? { ...part, text: `${inputs.day} ${label}：累计 ${total} 贡献点。` }
    : part.id === 'allocation' && part.type === 'data' ? { ...part, value: { ...value, total, allocations: [{ ...value.allocations[0], amount: total }] } as unknown as Json }
    : part) };
}
