import type { Account, Change, Membership, Message, MessageState } from './types.js';

export interface Archive {
  format: 'gonglun-2'; regionId: string; ledgerId: string; programVersion: string;
  changes: Change[];
}
export interface Replay {
  messages: Message[]; memberships: Membership[];
  states: MessageState[]; revisions: Map<string, Message[]>;
  accounts: Map<string, Account>; operating: number; issued: number; sequence: number;
}

/** Replays committed results, never re-executes old transactions using today's rules. */
export function replayArchive(input: unknown): Replay {
  if (!input || typeof input !== 'object') throw new Error('不是公论导出文件');
  const archive = input as Archive;
  if (archive.format !== 'gonglun-2' || !Array.isArray(archive.changes)) throw new Error('导出文件格式不正确');
  const messages = new Map<string, Message>();
  const memberships = new Map<string, Membership>();
  const states = new Map<string, MessageState>();
  const revisions = new Map<string, Message[]>();
  const accounts = new Map<string, Account>();
  const ledgerIds = new Set<string>();
  let sequence = 0, operating = 0, issued = 0;
  const safe = (value: number) => {
    if (!Number.isSafeInteger(value)) throw new Error('账本包含无效金额');
    return value;
  };
  for (const change of archive.changes) {
    if (change.sequence !== sequence + 1) throw new Error(`记录不连续：缺少第 ${sequence + 1} 次变更`);
    if (!Array.isArray(change.messages) || !Array.isArray(change.ledger) || !Array.isArray(change.memberships) || !Array.isArray(change.removedMemberships) || !Array.isArray(change.states)) throw new Error('变更记录不完整');
    for (const message of change.messages) {
      if (!message || typeof message.id !== 'string' || !message.id || !Number.isSafeInteger(message.revision) || message.revision < 1 || !Array.isArray(message.parts)) throw new Error('消息版本不正确');
      for (const part of message.parts) {
        if (!part || typeof part.id !== 'string') throw new Error('消息部件不正确');
        if (part.type === 'text' && typeof part.text === 'string' || part.type === 'web' && typeof part.url === 'string' && typeof part.excerpt === 'string' || part.type === 'code' && typeof part.source === 'string' && typeof part.language === 'string' || part.type === 'data' && 'value' in part) continue;
        if (part.type === 'display' && ['flow', 'columns', 'row', 'summary'].includes(part.layout)) continue;
        if (part.type === 'relation' && typeof part.relation === 'string' && part.roles && typeof part.roles === 'object' && Object.values(part.roles).every(bindings => Array.isArray(bindings) && bindings.every(binding => binding && typeof binding.id === 'string' && binding.reference && typeof binding.reference.messageId === 'string'))) continue;
        throw new Error('消息部件不正确');
      }
      const previous = messages.get(message.id);
      if (previous && message.revision < previous.revision) throw new Error('消息版本倒退');
      messages.set(message.id, message);
      if (!previous || message.revision > previous.revision) {
        const history = revisions.get(message.id) ?? [];
        history.push(message); revisions.set(message.id, history);
      }
    }
    for (const state of change.states) {
      if (!state || !messages.has(state.messageId) || !Number.isSafeInteger(state.revision) || typeof state.suppressed !== 'boolean') throw new Error('显示状态不正确');
      safe(state.supportCount); safe(state.oppositionCount); safe(state.recommendationTotal);
      states.set(state.messageId, state);
    }
    for (const id of change.removedMemberships) memberships.delete(id);
    for (const membership of change.memberships) memberships.set(membership.memberId, membership);
    for (const entry of change.ledger) {
      if (ledgerIds.has(entry.id)) throw new Error('同一笔资金变动被重复记录');
      if (!revisions.get(entry.messageId)?.some(message => message.revision === entry.messageRevision)) throw new Error('资金变动缺少对应消息版本');
      ledgerIds.add(entry.id);
      const account = accounts.get(entry.userId) ?? { available: 0, locked: 0, earned: 0, spent: 0 };
      const net = safe(safe(entry.amount) + safe(entry.lockedDelta));
      account.available = safe(account.available + entry.amount);
      account.locked = safe(account.locked + entry.lockedDelta);
      account.earned = safe(account.earned + Math.max(0, net));
      account.spent = safe(account.spent + Math.max(0, -net));
      accounts.set(entry.userId, account);
    }
    if (!change.treasury) throw new Error('缺少运营资金记录');
    operating = safe(change.treasury.operating); issued = safe(change.treasury.issued);
    let total = BigInt(operating);
    for (const account of accounts.values()) {
      if (account.locked < 0) throw new Error('锁定金额小于零');
      total += BigInt(account.available) + BigInt(account.locked);
    }
    if (total !== BigInt(issued)) throw new Error(`第 ${change.sequence} 次变更资金不守恒`);
    sequence = change.sequence;
  }
  return { messages: [...messages.values()], memberships: [...memberships.values()], states: [...states.values()], revisions, accounts, operating, issued, sequence };
}
