import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Relation, User } from '../types';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { buildLeaderboardMetrics } from '../utils/leaderboardMetrics';
import LeaderboardWindow from './LeaderboardWindow';
import { buildLeaderboardRows } from '../utils/leaderboardRows';
import { readLeaderboardPreferences, saveLeaderboardPreferences } from '../utils/leaderboardPreferences';
import type { LeaderboardWindowSize } from '../utils/leaderboardPreferences';
import LeaderboardTable from './LeaderboardTable';
import LeaderboardRefreshButton from './LeaderboardRefreshButton';
import { dialogStyles } from './dialogStyles';

const USER_COLUMNS = [
  { label: '#', width: 48 }, { label: '与会者ID', width: 180 }, { label: '与会者', width: 120 },
  { label: '充值收入', width: 100 }, { label: '发送消息总数', width: 112 }, { label: '文本消息数', width: 100 },
  { label: '关系消息数', width: 100 }, { label: '被站队贡献点', width: 112 }, { label: '被表态贡献点', width: 112 },
  { label: '净支持率%', width: 100 }, { label: '被引用热度', width: 100 }, { label: '结算活跃度', width: 100 },
  { label: '充值及受押总点', width: 128 },
];
const MESSAGE_COLUMNS = [
  { label: '#', width: 48 }, { label: '消息ID', width: 180 }, { label: '消息摘要', width: 280 },
  { label: '议事人', width: 120 }, { label: '被押注总点', width: 100 }, { label: '被站队贡献点', width: 112 },
  { label: '被表态贡献点', width: 112 }, { label: '净支持率%', width: 100 }, { label: '被引用热度', width: 100 },
  { label: '结算活跃度', width: 100 }, { label: '正反差', width: 80 }, { label: '押注人数', width: 88 },
  { label: '激烈度', width: 88 }, { label: '议事人ID', width: 180 },
];

type UserSortKey =
  | 'rechargeIncome'
  | 'messageCount'
  | 'textMessageCount'
  | 'relationMessageCount'
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

export interface LeaderboardModalProps {
  globalRows?: ReturnType<typeof buildLeaderboardRows>;
  open: boolean;
  onClose: () => void;
  messages: DemoMessage[];
  edges: DemoEdge[];
  relations: Relation[];
  users: User[];
  onRefresh: () => void | Promise<boolean>;
  stakeCounts: Record<string, StakeCountItem>;
  messageBettorCounts: Record<string, number>;
}

function LeaderboardModal({
  globalRows,
  open,
  onClose,
  messages,
  edges,
  relations,
  users,
  onRefresh,
  stakeCounts,
  messageBettorCounts,
}: LeaderboardModalProps) {
  const [tab, setTab] = useState<'user' | 'message'>('user');
  const [userSort, setUserSort] = useState<UserSortKey>('messageCount');
  const [messageSort, setMessageSort] = useState<MessageSortKey>('stakeTotal');
  const [userSortDir, setUserSortDir] = useState<'desc' | 'asc'>('desc');
  const [messageSortDir, setMessageSortDir] = useState<'desc' | 'asc'>('desc');
  const [userMinTruthSample, setUserMinTruthSample] = useState(0);
  const [messageMinTruthSample, setMessageMinTruthSample] = useState(0);
  const [userKeyword, setUserKeyword] = useState('');
  const [messageKeyword, setMessageKeyword] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [messagePage, setMessagePage] = useState(1);
  const [savedPreferences] = useState(readLeaderboardPreferences);
  const [pageSize, setPageSize] = useState(savedPreferences.pageSize);
  const [windowSize, setWindowSize] = useState<LeaderboardWindowSize | null>(savedPreferences.windowSize);
  const [columnWidths, setColumnWidths] = useState(() => ({
    user: USER_COLUMNS.map(column => savedPreferences.columnWidths.user[column.label] ?? column.width),
    message: MESSAGE_COLUMNS.map(column => savedPreferences.columnWidths.message[column.label] ?? column.width),
  }));
  const persistedSettings = useRef({ pageSize, windowSize, columnWidths });
  const tableScrollRef = useRef<HTMLDivElement>(null);

  const { userRows, messageRows } = useMemo(() => globalRows ?? buildLeaderboardRows(
    buildLeaderboardMetrics(messages, edges, relations, users), users, stakeCounts, messageBettorCounts),
    [globalRows, messages, edges, relations, users, stakeCounts, messageBettorCounts]);

  const sortedUserRows = useMemo(() => [...userRows].sort((a, b) =>
    (b[userSort] - a[userSort]) * (userSortDir === 'desc' ? 1 : -1)), [userRows, userSort, userSortDir]);

  const filteredUserRows = useMemo(() => {
    const normalized = userKeyword.trim().toLowerCase();
    let rows = sortedUserRows;
    if (userSort === 'netSupportRate') {
      rows = rows.filter(row => row.receivedTruthStake >= userMinTruthSample);
    }
    if (!normalized) return rows;
    return rows.filter(row =>
      row.userId.toLowerCase().includes(normalized) ||
      row.username.toLowerCase().includes(normalized)
    );
  }, [sortedUserRows, userSort, userMinTruthSample, userKeyword]);

  const sortedMessageRows = useMemo(() => [...messageRows].sort((a, b) =>
    (b[messageSort] - a[messageSort]) * (messageSortDir === 'desc' ? 1 : -1)), [messageRows, messageSort, messageSortDir]);

  const filteredMessageRows = useMemo(() => {
    const normalized = messageKeyword.trim().toLowerCase();
    let rows = sortedMessageRows;
    if (messageSort === 'netSupportRate') {
      rows = rows.filter(row => row.truthStake >= messageMinTruthSample);
    }
    if (!normalized) return rows;
    return rows.filter(row => row.messageId.toLowerCase().includes(normalized)
      || row.userId.toLowerCase().includes(normalized) || row.username.toLowerCase().includes(normalized));
  }, [sortedMessageRows, messageSort, messageMinTruthSample, messageKeyword]);

  const userPageCount = Math.max(1, Math.ceil(filteredUserRows.length / pageSize));
  const messagePageCount = Math.max(1, Math.ceil(filteredMessageRows.length / pageSize));
  const currentUserPage = Math.min(userPage, userPageCount);
  const currentMessagePage = Math.min(messagePage, messagePageCount);
  const currentPage = tab === 'user' ? currentUserPage : currentMessagePage;
  const pageCount = tab === 'user' ? userPageCount : messagePageCount;
  const totalRows = tab === 'user' ? filteredUserRows.length : filteredMessageRows.length;
  const userOffset = (currentUserPage - 1) * pageSize;
  const messageOffset = (currentMessagePage - 1) * pageSize;
  const offset = tab === 'user' ? userOffset : messageOffset;
  const setPage = tab === 'user' ? setUserPage : setMessagePage;
  const columns = tab === 'user' ? USER_COLUMNS : MESSAGE_COLUMNS;
  const resizeColumn = (index: number, width: number) => setColumnWidths(previous => previous[tab][index] === width ? previous : ({
    ...previous,
    [tab]: previous[tab].map((value, columnIndex) => columnIndex === index ? width : value),
  }));

  useEffect(() => {
    const previous = persistedSettings.current;
    if (previous.pageSize === pageSize && previous.windowSize === windowSize && previous.columnWidths === columnWidths) return;
    persistedSettings.current = { pageSize, windowSize, columnWidths };
    saveLeaderboardPreferences({
      pageSize, windowSize, columnWidths: {
        user: Object.fromEntries(USER_COLUMNS.map((column, index) => [column.label, columnWidths.user[index]])),
        message: Object.fromEntries(MESSAGE_COLUMNS.map((column, index) => [column.label, columnWidths.message[index]])),
      },
    });
  }, [pageSize, windowSize, columnWidths]);

  useEffect(() => { setUserPage(page => Math.min(page, userPageCount)); }, [userPageCount]);
  useEffect(() => { setMessagePage(page => Math.min(page, messagePageCount)); }, [messagePageCount]);
  useEffect(() => {
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0;
  }, [tab, currentPage, pageSize, filteredUserRows, filteredMessageRows]);

  if (!open) return null;

  return (
    <LeaderboardWindow
      size={windowSize}
      contentWidth={columnWidths[tab].reduce((total, width) => total + width, 0) + 26}
      onSizeChange={setWindowSize}
      onClose={onClose}
      scrollResetKey={`${tab}:${currentPage}:${pageSize}:${userSort}:${messageSort}:${userSortDir}:${messageSortDir}:${userKeyword}:${messageKeyword}:${userMinTruthSample}:${messageMinTruthSample}`}
      header={(
        <div style={{ ...dialogStyles.header, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#e2e8f0' }}>排行榜</div>
            <LeaderboardRefreshButton onRefresh={onRefresh} />
            <button
              onClick={() => setWindowSize(null)}
              style={{ border: '1px solid #475569', background: '#1e293b', color: '#cbd5e1', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}
              title="按当前列宽和本页内容自动调整窗口大小"
            >
              自适应窗口
            </button>
            <button
              onClick={() => setColumnWidths(previous => columns.every((column, index) => previous[tab][index] === column.width)
                ? previous : ({ ...previous, [tab]: columns.map(column => column.width) }))}
              style={{ border: '1px solid #475569', background: '#1e293b', color: '#cbd5e1', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}
              title="恢复当前榜单的默认列宽"
            >
              重置列宽
            </button>
          </div>
          <button
            onClick={onClose}
            style={{
              ...dialogStyles.button,
              flexShrink: 0,
            }}
          >
            关闭
          </button>
        </div>
      )}
      footer={(<>
        <nav aria-label="排行榜分页" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '8px 12px', borderTop: '1px solid #2b3440', color: '#cbd5e1', fontSize: 12 }}>
          <span role="status">共 {totalRows} 条 · 第 {totalRows === 0 ? 0 : offset + 1}–{Math.min(offset + pageSize, totalRows)} 条</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            每页
            <select aria-label="每页条数" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setUserPage(1); setMessagePage(1); }} style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '3px 6px' }}>
              {[20, 50, 100].map(size => <option key={size} value={size}>{size} 条</option>)}
            </select>
          </label>
          {[
            { label: '首页', page: 1, disabled: currentPage <= 1 },
            { label: '上一页', page: currentPage - 1, disabled: currentPage <= 1 },
          ].map(item => <button key={item.label} disabled={item.disabled} onClick={() => setPage(item.page)} style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '3px 8px', cursor: item.disabled ? 'default' : 'pointer', opacity: item.disabled ? 0.4 : 1 }}>{item.label}</button>)}
          <span>第 {currentPage} / {pageCount} 页</span>
          {[
            { label: '下一页', page: currentPage + 1, disabled: currentPage >= pageCount },
            { label: '末页', page: pageCount, disabled: currentPage >= pageCount },
          ].map(item => <button key={item.label} disabled={item.disabled} onClick={() => setPage(item.page)} style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '3px 8px', cursor: item.disabled ? 'default' : 'pointer', opacity: item.disabled ? 0.4 : 1 }}>{item.label}</button>)}
        </nav>
        <div style={{ flexShrink: 0, padding: '4px 24px 6px 12px', borderTop: '1px solid #2b3440', color: '#94a3b8', fontSize: 11, textAlign: 'right' }}>
          设置自动保存 · 拖动右下角调整宽高，松开后居中
        </div>
      </>)}
    >
        <div style={{ flex: 'var(--leaderboard-body-flex, 0 1 auto)', minHeight: 0, overflow: 'var(--leaderboard-body-overflow, visible)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 12, display: 'flex', gap: 8, borderBottom: '1px solid #2b3440', flexShrink: 0 }}>
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
            人榜
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

        <div style={{ padding: '8px 12px', color: '#94a3b8', fontSize: 11, flexShrink: 0 }}>
          统计当前讨论范围，总数 = 文本消息数 + 关系消息数；加入、发起结算和结算结果均计入关系消息，系统生成的结算记录按已记录的发起人或触发人归属。被引用热度按引用消息去重，结算活跃度按轮次去重。
        </div>

        {tab === 'user' ? (
          <>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #2b3440', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>排序条件：</span>
              <select
                aria-label="排序条件"
                value={userSort}
                onChange={(e) => { setUserSort(e.target.value as UserSortKey); setUserPage(1); }}
                style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
              >
                <option value="rechargeIncome">按充值收入</option>
                <option value="messageCount">按发送消息总数</option>
                <option value="textMessageCount">按文本消息数</option>
                <option value="relationMessageCount">按关系消息数</option>
                <option value="receivedTruthStake">按被站队贡献点</option>
                <option value="receivedStanceStake">按被表态贡献点</option>
                <option value="netSupportRate">按净支持率</option>
                <option value="referenceHeat">按被引用热度</option>
                <option value="settlementActivity">按结算活跃度</option>
                <option value="totalIncome">按充值及受押总点</option>
              </select>
              <button
                onClick={() => { setUserSortDir(prev => prev === 'desc' ? 'asc' : 'desc'); setUserPage(1); }}
                style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
                title="切换排序方向"
              >
                {userSortDir === 'desc' ? '降序' : '升序'}
              </button>
              <input
                type="text"
                value={userKeyword}
                onChange={(e) => { setUserKeyword(e.target.value); setUserPage(1); }}
                placeholder="搜索与会者ID/与会者"
                style={{ minWidth: 180, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
              />
              {userSort === 'netSupportRate' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: 12 }}>
                  最小样本(被站队点)
                  <input
                    type="number"
                    min={0}
                    value={userMinTruthSample}
                    onChange={(e) => { setUserMinTruthSample(Math.max(0, Number(e.target.value || 0))); setUserPage(1); }}
                    style={{ width: 84, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '3px 6px', fontSize: 12 }}
                  />
                </label>
              )}
              <span style={{ fontSize: 11, color: '#64748b' }}>充值及受押总点 = 已执行充值到账点数 + 消息被押注总额</span>
            </div>
            <div ref={tableScrollRef} style={{ overflow: 'var(--leaderboard-table-overflow, visible)', padding: 12, flex: 'var(--leaderboard-table-flex, 0 0 auto)', minHeight: 'var(--leaderboard-table-min-height, 0px)' }}>
              <LeaderboardTable key="user" columns={USER_COLUMNS} widths={columnWidths.user} onResize={resizeColumn} stickyTop="var(--leaderboard-table-sticky-top, var(--leaderboard-header-height, 0px))">
                  {filteredUserRows.slice(userOffset, userOffset + pageSize).map((row, idx) => (
                    <tr key={`${row.userId || 'unknown'}::${row.username}`} style={{ color: '#e2e8f0' }}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{userOffset + idx + 1}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b', color: '#94a3b8' }}>{row.userId || '-'}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b', fontWeight: 600 }}>{row.username}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.rechargeIncome}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.messageCount}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.textMessageCount}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.relationMessageCount}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.receivedTruthStake}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.receivedStanceStake}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.netSupportRate.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.referenceHeat}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.settlementActivity}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{Math.round(row.totalIncome)}</td>
                    </tr>
                  ))}
              </LeaderboardTable>
              {filteredUserRows.length === 0 && <p style={{ color: '#94a3b8', fontSize: 12 }}>未找到符合条件的记录</p>}
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #2b3440', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>排序条件：</span>
              <select
                aria-label="排序条件"
                value={messageSort}
                onChange={(e) => { setMessageSort(e.target.value as MessageSortKey); setMessagePage(1); }}
                style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
              >
                <option value="stakeTotal">按被押注总点</option>
                <option value="truthStake">按被站队贡献点</option>
                <option value="stanceStake">按被表态贡献点</option>
                <option value="netSupportRate">按净支持率</option>
                <option value="referenceHeat">按被引用热度</option>
                <option value="settlementActivity">按结算活跃度</option>
                <option value="sideGap">按正反差距最大</option>
                <option value="bettors">按押注人数</option>
                <option value="intensity">按争论激烈程度</option>
              </select>
              <button
                onClick={() => { setMessageSortDir(prev => prev === 'desc' ? 'asc' : 'desc'); setMessagePage(1); }}
                style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
                title="切换排序方向"
              >
                {messageSortDir === 'desc' ? '降序' : '升序'}
              </button>
              <input
                type="text"
                value={messageKeyword}
                onChange={(e) => { setMessageKeyword(e.target.value); setMessagePage(1); }}
                placeholder="搜索消息ID/议事人ID/议事人"
                style={{ minWidth: 180, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
              />
              {messageSort === 'netSupportRate' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: 12 }}>
                  最小样本(被站队点)
                  <input
                    type="number"
                    min={0}
                    value={messageMinTruthSample}
                    onChange={(e) => { setMessageMinTruthSample(Math.max(0, Number(e.target.value || 0))); setMessagePage(1); }}
                    style={{ width: 84, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '3px 6px', fontSize: 12 }}
                  />
                </label>
              )}
              <span style={{ fontSize: 11, color: '#64748b' }}>激烈度综合被押注规模、正反均衡度与押注人数</span>
            </div>
            <div ref={tableScrollRef} style={{ overflow: 'var(--leaderboard-table-overflow, visible)', padding: 12, flex: 'var(--leaderboard-table-flex, 0 0 auto)', minHeight: 'var(--leaderboard-table-min-height, 0px)' }}>
              <LeaderboardTable key="message" columns={MESSAGE_COLUMNS} widths={columnWidths.message} onResize={resizeColumn} stickyTop="var(--leaderboard-table-sticky-top, var(--leaderboard-header-height, 0px))">
                  {filteredMessageRows.slice(messageOffset, messageOffset + pageSize).map((row, idx) => (
                    <tr key={row.messageId} style={{ color: '#e2e8f0' }}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{messageOffset + idx + 1}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b', maxWidth: 180, wordBreak: 'break-all', color: '#94a3b8' }}>{row.messageId}</td>
                      <td title={row.preview} style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.preview}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.username}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.stakeTotal}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.truthStake}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.stanceStake}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.netSupportRate.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.referenceHeat}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.settlementActivity}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.sideGap}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.bettors}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>{row.intensity.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b', maxWidth: 180, wordBreak: 'break-all', color: '#94a3b8' }}>{row.userId || '-'}</td>
                    </tr>
                  ))}
              </LeaderboardTable>
              {filteredMessageRows.length === 0 && <p style={{ color: '#94a3b8', fontSize: 12 }}>未找到符合条件的记录</p>}
            </div>
          </>
        )}
        </div>
    </LeaderboardWindow>
  );
}

// Keep one cached snapshot after closing, without reacting to background workbench updates.
// Reopening always accepts the latest props; the window DOM and observers only exist while open.
export default memo(LeaderboardModal, (previous, next) =>
  (!previous.open && !next.open) || (Object.keys(previous) as (keyof LeaderboardModalProps)[]).every(key => previous[key] === next[key]));
