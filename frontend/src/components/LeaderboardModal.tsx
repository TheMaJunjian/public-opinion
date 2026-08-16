import { useMemo, useRef, useState } from 'react';
import type { Relation } from '../types';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { isContentKind } from '../utils/modelBridge';
import PopupOverlay from './PopupOverlay';

type UserSortKey =
  | 'rechargeIncome'
  | 'messageCount'
  | 'totalIncome'
  | 'receivedTruthStake'
  | 'receivedStanceStake'
  | 'netSupportRate'
  | 'referenceHeat'
  | 'settlementActivity';
type MessageSortKey =
  | 'stakeTotal'
  | 'sideGap'
  | 'bettors'
  | 'intensity'
  | 'truthStake'
  | 'stanceStake'
  | 'netSupportRate'
  | 'referenceHeat'
  | 'settlementActivity';

interface StakeCountItem {
  truth: { pro: number; con: number };
  value: { pro: number; con: number };
}

interface Props {
  open: boolean;
  onClose: () => void;
  messages: DemoMessage[];
  edges: DemoEdge[];
  relations: Relation[];
  stakeCounts: Record<string, StakeCountItem>;
  messageBettorCounts: Record<string, number>;
}

interface UserRow {
  userId: string;
  username: string;
  rechargeIncome: number;
  messageCount: number;
  totalIncome: number;
  receivedTruthStake: number;
  receivedStanceStake: number;
  receivedTruthPro: number;
  receivedTruthCon: number;
  netSupportRate: number;
  referenceHeat: number;
  settlementActivity: number;
}

interface MessageRow {
  messageId: string;
  author: string;
  preview: string;
  stakeTotal: number;
  truthStake: number;
  stanceStake: number;
  truthPro: number;
  truthCon: number;
  netSupportRate: number;
  referenceHeat: number;
  settlementActivity: number;
  sideGap: number;
  bettors: number;
  intensity: number;
}

function toNumber(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return value;
}

function getStakeTotal(stake: StakeCountItem | undefined): number {
  if (!stake) return 0;
  return stake.truth.pro + stake.truth.con + stake.value.pro + stake.value.con;
}

export default function LeaderboardModal({
  open,
  onClose,
  messages,
  edges,
  relations,
  stakeCounts,
  messageBettorCounts,
}: Props) {
  const [tab, setTab] = useState<'user' | 'message'>('user');
  const [userSort, setUserSort] = useState<UserSortKey>('rechargeIncome');
  const [messageSort, setMessageSort] = useState<MessageSortKey>('stakeTotal');
  const [userSortDir, setUserSortDir] = useState<'desc' | 'asc'>('desc');
  const [messageSortDir, setMessageSortDir] = useState<'desc' | 'asc'>('desc');
  const [userMinTruthSample, setUserMinTruthSample] = useState(0);
  const [messageMinTruthSample, setMessageMinTruthSample] = useState(0);
  const [userKeyword, setUserKeyword] = useState('');
  const [messageKeyword, setMessageKeyword] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  const applyDir = (value: number, dir: 'desc' | 'asc'): number => {
    return dir === 'desc' ? value : -value;
  };

  const idToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const relation of relations) {
      if (relation.createdBy?.id && relation.createdBy?.username) {
        map.set(relation.createdBy.id, relation.createdBy.username);
      }
    }
    return map;
  }, [relations]);

  const nameToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const relation of relations) {
      if (relation.createdBy?.username && relation.createdBy?.id) {
        map.set(relation.createdBy.username, relation.createdBy.id);
      }
    }
    return map;
  }, [relations]);

  const userRows = useMemo(() => {
    const messageById = new Map(messages.map(m => [m.id, m]));
    const validMessageIds = new Set(messages.filter(m => isContentKind(m.kind)).map(m => m.id));

    const refInCount = new Map<string, number>();
    for (const edge of edges) {
      if (edge.relationType !== 'reference') continue;
      if (!validMessageIds.has(edge.to.messageId)) continue;
      refInCount.set(edge.to.messageId, (refInCount.get(edge.to.messageId) ?? 0) + 1);
    }

    const settlementCount = new Map<string, number>();
    for (const message of messages) {
      if (message.kind !== 'round' && message.kind !== 'round_result') continue;
      const target = message.settlementTargetId;
      if (!target || !validMessageIds.has(target)) continue;
      settlementCount.set(target, (settlementCount.get(target) ?? 0) + 1);
    }

    const byUser = new Map<string, UserRow>();
    const ensure = (username: string): UserRow => {
      const prev = byUser.get(username);
      if (prev) return prev;
      const knownId = nameToId.get(username) ?? '';
      const next: UserRow = {
        userId: knownId,
        username,
        rechargeIncome: 0,
        messageCount: 0,
        totalIncome: 0,
        receivedTruthStake: 0,
        receivedStanceStake: 0,
        receivedTruthPro: 0,
        receivedTruthCon: 0,
        netSupportRate: 0,
        referenceHeat: 0,
        settlementActivity: 0,
      };
      byUser.set(username, next);
      return next;
    };

    // 发送消息数量：只统计常规发言与业务卡片，不统计轮次和系统关系卡片。
    for (const message of messages) {
      if (!isContentKind(message.kind)) continue;
      if (message.kind === 'join' || message.kind === 'round' || message.kind === 'round_result') continue;
      ensure(message.author).messageCount += 1;
    }

    // 充值收入：从提案关系 payload.operationType=RECHARGE 汇总。
    for (const relation of relations) {
      if (relation.relationType.toUpperCase() !== 'PROPOSAL') continue;
      const payload = relation.payload as Record<string, unknown> | undefined;
      if (!payload || payload.operationType !== 'RECHARGE') continue;
      const amount = toNumber(payload.amount);
      const poolShare = toNumber(payload.revenuePoolShare) ?? 0;
      const recipientId = typeof payload.recipientUserId === 'string' ? payload.recipientUserId : null;
      if (amount === null || amount <= 0 || !recipientId) continue;
      const netIncome = Math.max(0, amount - poolShare);
      const recipientName = idToName.get(recipientId) ?? recipientId;
      ensure(recipientName).rechargeIncome += netIncome;
    }

    // 被表态贡献点：收到的 AGREE / DISAGREE 关系押注。
    for (const relation of relations) {
      const relType = relation.relationType.toUpperCase();
      if (relType !== 'AGREE' && relType !== 'DISAGREE') continue;
      const amount = toNumber((relation.payload as Record<string, unknown> | undefined)?.amount) ?? 0;
      if (amount <= 0) continue;
      for (const targetRef of relation.targetRefs) {
        if (targetRef.kind !== 'message' && targetRef.kind !== 'text-fragment') continue;
          const targetMessage = messageById.get(targetRef.messageId);
        if (!targetMessage || !isContentKind(targetMessage.kind)) continue;
        ensure(targetMessage.author).receivedStanceStake += amount;
      }
    }

    // 总收入（估算）：充值收入 + 该用户消息被押注总额。
    for (const message of messages) {
      if (!isContentKind(message.kind)) continue;
      const totalStake = getStakeTotal(stakeCounts[message.id]);
      const truthPro = stakeCounts[message.id]?.truth.pro ?? 0;
      const truthCon = stakeCounts[message.id]?.truth.con ?? 0;
      const truthStake = truthPro + truthCon;
      const row = ensure(message.author);
      row.totalIncome += totalStake;
      row.receivedTruthStake += truthStake;
      row.receivedTruthPro += truthPro;
      row.receivedTruthCon += truthCon;
      row.referenceHeat += refInCount.get(message.id) ?? 0;
      row.settlementActivity += settlementCount.get(message.id) ?? 0;
    }

    for (const row of byUser.values()) {
      row.totalIncome += row.rechargeIncome;
      const denom = row.receivedTruthPro + row.receivedTruthCon;
      row.netSupportRate = denom > 0 ? Number((((row.receivedTruthPro - row.receivedTruthCon) / denom) * 100).toFixed(2)) : 0;
    }

    const arr = Array.from(byUser.values());
    arr.sort((a, b) => {
      if (userSort === 'rechargeIncome') return applyDir(b.rechargeIncome - a.rechargeIncome, userSortDir);
      if (userSort === 'messageCount') return applyDir(b.messageCount - a.messageCount, userSortDir);
      if (userSort === 'receivedTruthStake') return applyDir(b.receivedTruthStake - a.receivedTruthStake, userSortDir);
      if (userSort === 'receivedStanceStake') return applyDir(b.receivedStanceStake - a.receivedStanceStake, userSortDir);
      if (userSort === 'netSupportRate') return applyDir(b.netSupportRate - a.netSupportRate, userSortDir);
      if (userSort === 'referenceHeat') return applyDir(b.referenceHeat - a.referenceHeat, userSortDir);
      if (userSort === 'settlementActivity') return applyDir(b.settlementActivity - a.settlementActivity, userSortDir);
      return applyDir(b.totalIncome - a.totalIncome, userSortDir);
    });
    return arr;
  }, [messages, relations, stakeCounts, userSort, userSortDir, idToName, nameToId, edges]);

  const filteredUserRows = useMemo(() => {
    const normalized = userKeyword.trim().toLowerCase();
    let rows = userRows;
    if (userSort === 'netSupportRate') {
      rows = rows.filter(row => row.receivedTruthStake >= userMinTruthSample);
    }
    if (!normalized) return rows;
    return rows.filter(row =>
      row.userId.toLowerCase().includes(normalized) ||
      row.username.toLowerCase().includes(normalized)
    );
  }, [userRows, userSort, userMinTruthSample, userKeyword]);

  const messageRows = useMemo(() => {
    const validMessageIds = new Set(messages.filter(m => isContentKind(m.kind)).map(m => m.id));
    const refInCount = new Map<string, number>();
    const refOutCount = new Map<string, number>();
    for (const edge of edges) {
      if (edge.relationType !== 'reference') continue;
      if (validMessageIds.has(edge.from.messageId)) {
        refOutCount.set(edge.from.messageId, (refOutCount.get(edge.from.messageId) ?? 0) + 1);
      }
      if (validMessageIds.has(edge.to.messageId)) {
        refInCount.set(edge.to.messageId, (refInCount.get(edge.to.messageId) ?? 0) + 1);
      }
    }

    const settlementCount = new Map<string, number>();
    for (const message of messages) {
      if (message.kind !== 'round' && message.kind !== 'round_result') continue;
      const target = message.settlementTargetId;
      if (!target || !validMessageIds.has(target)) continue;
      settlementCount.set(target, (settlementCount.get(target) ?? 0) + 1);
    }

    const stanceStakeMap = new Map<string, number>();
    for (const relation of relations) {
      const relType = relation.relationType.toUpperCase();
      if (relType !== 'AGREE' && relType !== 'DISAGREE') continue;
      const amount = toNumber((relation.payload as Record<string, unknown> | undefined)?.amount) ?? 0;
      if (amount <= 0) continue;
      for (const targetRef of relation.targetRefs) {
        if (targetRef.kind !== 'message' && targetRef.kind !== 'text-fragment') continue;
        stanceStakeMap.set(targetRef.messageId, (stanceStakeMap.get(targetRef.messageId) ?? 0) + amount);
      }
    }

    const rows: MessageRow[] = messages
      .filter(m => isContentKind(m.kind) && m.kind !== 'join')
      .map(message => {
        const stake = stakeCounts[message.id];
        const pro = (stake?.truth.pro ?? 0) + (stake?.value.pro ?? 0);
        const con = (stake?.truth.con ?? 0) + (stake?.value.con ?? 0);
        const truthPro = stake?.truth.pro ?? 0;
        const truthCon = stake?.truth.con ?? 0;
        const truthStake = truthPro + truthCon;
        const stakeTotal = pro + con;
        const sideGap = Math.abs(pro - con);
        const bettors = messageBettorCounts[message.id] ?? 0;
        const balanceFactor = stakeTotal > 0 ? (1 - sideGap / stakeTotal) : 0;
        const intensity = Number((stakeTotal * balanceFactor + bettors * 3).toFixed(2));
        const incomingRefs = refInCount.get(message.id) ?? 0;
        const outgoingRefs = refOutCount.get(message.id) ?? 0;
        const stanceStake = stanceStakeMap.get(message.id) ?? 0;
        const netSupportRate = truthStake > 0 ? Number((((truthPro - truthCon) / truthStake) * 100).toFixed(2)) : 0;

        return {
          messageId: message.id,
          author: message.author,
          preview: (message.content || '').replace(/\s+/g, ' ').slice(0, 60) || '(无内容)',
          stakeTotal,
          truthStake,
          stanceStake,
          truthPro,
          truthCon,
          netSupportRate,
          referenceHeat: incomingRefs,
          settlementActivity: settlementCount.get(message.id) ?? 0,
          sideGap,
          bettors,
          intensity: intensity + incomingRefs + outgoingRefs * 0.5,
        };
      });

    rows.sort((a, b) => {
      if (messageSort === 'stakeTotal') return applyDir(b.stakeTotal - a.stakeTotal, messageSortDir);
      if (messageSort === 'truthStake') return applyDir(b.truthStake - a.truthStake, messageSortDir);
      if (messageSort === 'stanceStake') return applyDir(b.stanceStake - a.stanceStake, messageSortDir);
      if (messageSort === 'netSupportRate') return applyDir(b.netSupportRate - a.netSupportRate, messageSortDir);
      if (messageSort === 'referenceHeat') return applyDir(b.referenceHeat - a.referenceHeat, messageSortDir);
      if (messageSort === 'settlementActivity') return applyDir(b.settlementActivity - a.settlementActivity, messageSortDir);
      if (messageSort === 'sideGap') return applyDir(b.sideGap - a.sideGap, messageSortDir);
      if (messageSort === 'bettors') return applyDir(b.bettors - a.bettors, messageSortDir);
      return applyDir(b.intensity - a.intensity, messageSortDir);
    });
    return rows;
  }, [messages, stakeCounts, messageBettorCounts, messageSort, messageSortDir, edges, relations]);

  const filteredMessageRows = useMemo(() => {
    const normalized = messageKeyword.trim().toLowerCase();
    let rows = messageRows;
    if (messageSort === 'netSupportRate') {
      rows = rows.filter(row => row.truthStake >= messageMinTruthSample);
    }
    if (!normalized) return rows;
    return rows.filter(row => row.messageId.toLowerCase().includes(normalized));
  }, [messageRows, messageSort, messageMinTruthSample, messageKeyword]);

  if (!open) return null;

  return (
    <PopupOverlay
      contentRef={dialogRef}
      zIndex={1500}
      background="rgba(0,0,0,0.65)"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        style={{
          width: 'min(980px, 100%)',
          maxHeight: '82vh',
          background: '#101216',
          border: '1px solid #2b3440',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #2b3440', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#e2e8f0' }}>排行榜</div>
          <button
            onClick={onClose}
            style={{
              border: '1px solid #475569',
              background: '#1e293b',
              color: '#e2e8f0',
              borderRadius: 6,
              padding: '2px 10px',
              cursor: 'pointer',
            }}
          >
            关闭
          </button>
        </div>

        <div style={{ padding: 12, display: 'flex', gap: 8, borderBottom: '1px solid #2b3440' }}>
          <button
            onClick={() => setTab('user')}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: tab === 'user' ? '1px solid #38bdf8' : '1px solid #475569',
              background: tab === 'user' ? 'rgba(56,189,248,0.15)' : '#0f172a',
              color: tab === 'user' ? '#7dd3fc' : '#cbd5e1',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            用户榜
          </button>
          <button
            onClick={() => setTab('message')}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: tab === 'message' ? '1px solid #f59e0b' : '1px solid #475569',
              background: tab === 'message' ? 'rgba(245,158,11,0.15)' : '#0f172a',
              color: tab === 'message' ? '#fcd34d' : '#cbd5e1',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            消息榜
          </button>
        </div>

        {tab === 'user' ? (
          <>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #2b3440', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>排序条件：</span>
              <select
                value={userSort}
                onChange={(e) => setUserSort(e.target.value as UserSortKey)}
                style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
              >
                <option value="rechargeIncome">按充值收入</option>
                <option value="messageCount">按发送消息数</option>
                <option value="receivedTruthStake">按被站队贡献点</option>
                <option value="receivedStanceStake">按被表态贡献点</option>
                <option value="netSupportRate">按净支持率</option>
                <option value="referenceHeat">按被引用热度</option>
                <option value="settlementActivity">按结算活跃度</option>
                <option value="totalIncome">按总收入（估算）</option>
              </select>
              <button
                onClick={() => setUserSortDir(prev => prev === 'desc' ? 'asc' : 'desc')}
                style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
                title="切换排序方向"
              >
                {userSortDir === 'desc' ? '降序' : '升序'}
              </button>
              <input
                type="text"
                value={userKeyword}
                onChange={(e) => setUserKeyword(e.target.value)}
                placeholder="搜索用户ID/用户名"
                style={{ minWidth: 180, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
              />
              {userSort === 'netSupportRate' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: 12 }}>
                  最小样本(被站队点)
                  <input
                    type="number"
                    min={0}
                    value={userMinTruthSample}
                    onChange={(e) => setUserMinTruthSample(Math.max(0, Number(e.target.value || 0)))}
                    style={{ width: 84, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '3px 6px', fontSize: 12 }}
                  />
                </label>
              )}
              <span style={{ fontSize: 11, color: '#64748b' }}>总收入（估算）= 充值收入 + 该用户消息被押注总额</span>
            </div>
            <div style={{ overflow: 'auto', padding: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>#</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>用户ID</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>用户</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>充值收入</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>发送消息数</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>被站队贡献点</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>被表态贡献点</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>净支持率%</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>被引用热度</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>结算活跃度</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>总收入（估算）</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUserRows.slice(0, 50).map((row, idx) => (
                    <tr key={`${row.userId || 'unknown'}::${row.username}`} style={{ color: '#e2e8f0' }}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{idx + 1}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b', color: '#94a3b8' }}>{row.userId || '-'}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b', fontWeight: 600 }}>{row.username}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.rechargeIncome}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.messageCount}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.receivedTruthStake}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.receivedStanceStake}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.netSupportRate.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.referenceHeat}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.settlementActivity}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{Math.round(row.totalIncome)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #2b3440', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>排序条件：</span>
              <select
                value={messageSort}
                onChange={(e) => setMessageSort(e.target.value as MessageSortKey)}
                style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
              >
                <option value="stakeTotal">按押注贡献点最多</option>
                <option value="truthStake">按被站队贡献点</option>
                <option value="stanceStake">按被表态贡献点</option>
                <option value="netSupportRate">按净支持率</option>
                <option value="referenceHeat">按被引用热度</option>
                <option value="settlementActivity">按结算活跃度</option>
                <option value="sideGap">按正反差距最大</option>
                <option value="bettors">按投注人数最多</option>
                <option value="intensity">按争论激烈程度</option>
              </select>
              <button
                onClick={() => setMessageSortDir(prev => prev === 'desc' ? 'asc' : 'desc')}
                style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
                title="切换排序方向"
              >
                {messageSortDir === 'desc' ? '降序' : '升序'}
              </button>
              <input
                type="text"
                value={messageKeyword}
                onChange={(e) => setMessageKeyword(e.target.value)}
                placeholder="搜索消息ID"
                style={{ minWidth: 180, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
              />
              {messageSort === 'netSupportRate' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: 12 }}>
                  最小样本(被站队点)
                  <input
                    type="number"
                    min={0}
                    value={messageMinTruthSample}
                    onChange={(e) => setMessageMinTruthSample(Math.max(0, Number(e.target.value || 0)))}
                    style={{ width: 84, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '3px 6px', fontSize: 12 }}
                  />
                </label>
              )}
              <span style={{ fontSize: 11, color: '#64748b' }}>激烈度综合押注规模、正反均衡度与投注人数</span>
            </div>
            <div style={{ overflow: 'auto', padding: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>#</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>作者</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>消息摘要</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>押注总点</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>被站队贡献点</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>被表态贡献点</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>净支持率%</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>被引用热度</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>结算活跃度</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>正反差</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>投注人数</th>
                    <th style={{ padding: '6px 8px', borderBottom: '1px solid #243041' }}>激烈度</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMessageRows.slice(0, 80).map((row, idx) => (
                    <tr key={row.messageId} style={{ color: '#e2e8f0' }}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{idx + 1}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.author}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b', maxWidth: 360, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.preview}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.stakeTotal}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.truthStake}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.stanceStake}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.netSupportRate.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.referenceHeat}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.settlementActivity}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.sideGap}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.bettors}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.intensity.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </PopupOverlay>
  );
}
