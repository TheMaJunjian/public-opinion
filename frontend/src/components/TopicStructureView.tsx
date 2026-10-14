import type { DemoEdge, DemoMessage, UnitSelection } from '../utils/modelBridge';
import { relationTypeName } from './GraphView';
import { useNavigate } from 'react-router-dom';

const INCOMING_OUTGOING_LIST_MAX_H = 120;

function fmtSel(u: UnitSelection) {
  if (u.selection.kind === 'whole') return `${u.messageId}（整条消息）`;
  if (u.selection.kind === 'edge') return `${u.messageId}（关系边 ${u.selection.edgeId}）`;
  const sel = u.selection;
  const preview = sel.text.slice(0, 12) + (sel.text.length > 12 ? '…' : '');
  return `${u.messageId}（文本片段 第${sel.start}位起 共${sel.len}字「${preview}」）`;
}

function notifyUsersForEdge(edge: DemoEdge, messages: DemoMessage[]) {
  const relationMessage = messages.find(message => message.id === edge.relationMessageId);
  return relationMessage?.relationPayload?.notifyUsers ?? [];
}

function notifyLabel(edge: DemoEdge, messages: DemoMessage[]) {
  const relationMessage = messages.find(message => message.id === edge.relationMessageId);
  const users = notifyUsersForEdge(edge, messages);
  const names = users.map(user => user.username);
  const legacyIds = relationMessage?.relationPayload?.notifyUserIds ?? [];
  return names.length > 0 ? names.join('、') : legacyIds.length > 0 ? legacyIds.join('、') : '与会者';
}

function notifyUserLinks(edge: DemoEdge, messages: DemoMessage[], navigate: (to: string) => void, topicId?: string) {
  const relationMessage = messages.find(message => message.id === edge.relationMessageId);
  const users = notifyUsersForEdge(edge, messages);
  const notifyUsers = users.length > 0 ? users : (relationMessage?.relationPayload?.notifyUserIds ?? []).map(id => ({ id, username: id }));
  if (notifyUsers.length === 0) return null;
  return (
    <span
      title="通知关系标签"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        border: '1px solid #60a5fa',
        borderRadius: 4,
        background: '#dbeafe',
        color: '#1e3a8a',
        fontWeight: 700,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      }}
    >
      {notifyUsers.map((notifyUser, index) => (
        <span key={notifyUser.id}>
          {index > 0 && '、'}
          <span
            role="link"
            tabIndex={0}
            onClick={(event) => { event.stopPropagation(); if (topicId) navigate(`/topics/${topicId}?sender=${encodeURIComponent(notifyUser.username)}`); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                if (topicId) navigate(`/topics/${topicId}?sender=${encodeURIComponent(notifyUser.username)}`);
              }
            }}
            title={`在清爽视图中查看 ${notifyUser.username} 的消息`}
            style={{ color: '#1d4ed8', textDecoration: 'underline' }}
          >
            {notifyUser.id}
          </span>
        </span>
      ))}
      <span aria-label="通知">：通知</span>
    </span>
  );
}

function IncomingOutgoingList(props: { focusIds: string[]; edges: DemoEdge[]; kind: 'in' | 'out'; messages: DemoMessage[]; navigate: (to: string) => void; topicId?: string; onNavigateToMessage?: (messageId: string) => void }) {
  const { focusIds, edges, kind, messages, navigate, topicId, onNavigateToMessage } = props;
  const rows = focusIds.map(id => {
    const m = messages.find(mm => mm.id === id);
    let arr: DemoEdge[] = [];
    if (m && m.kind === 'relation') {
      arr = edges.filter(e => e.relationMessageId === id);
    } else {
      arr = kind === 'in' ? edges.filter(e => e.to.messageId === id) : edges.filter(e => e.from.messageId === id);
    }
    return { focusId: id, entries: arr };
  });
  const hasAny = rows.some(r => r.entries.length > 0);
  if (!hasAny) return <div style={{ fontSize: 12, opacity: 0.6 }}>无</div>;
  return (
    <div style={{ fontSize: 12 }}>
      <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0, maxHeight: INCOMING_OUTGOING_LIST_MAX_H, overflow: 'auto' }}>
        {rows.map(r => (
          <li key={r.focusId} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{r.focusId}</div>
            {r.entries.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>无</div> : (
              <ul style={{ listStyle: 'none', paddingLeft: 10, margin: 0 }}>
                {r.entries.map(e => (
                  <li key={e.id} style={{ marginBottom: 4 }}>
                    {e.relationType.toLowerCase() === 'notify' ? (
                      <>
                        {notifyUserLinks(e, messages, navigate, topicId) ?? (
                          <span style={{ display: 'inline-flex', padding: '2px 7px', border: '1px solid #60a5fa', borderRadius: 4, background: '#dbeafe', color: '#1e3a8a', fontWeight: 700 }}>
                            {notifyLabel(e, messages)}：通知
                          </span>
                        )}
                        ：{fmtSel(e.from)} → {fmtSel(e.to)}
                      </>
                    ) : (
                      <>
                        {onNavigateToMessage ? (
                          <button
                            type="button"
                            onClick={event => { event.stopPropagation(); onNavigateToMessage(e.relationMessageId); }}
                            title={`跳转到${relationTypeName(e.relationType)}消息 ${e.relationMessageId}`}
                            style={{ padding: 0, border: 0, background: 'transparent', color: '#93c5fd', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2, font: 'inherit' }}
                          >{relationTypeName(e.relationType)}：{e.relationMessageId}</button>
                        ) : `${relationTypeName(e.relationType)}：${e.relationMessageId}`}
                        {`：${fmtSel(e.from)} → ${fmtSel(e.to)}`}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function TopicStructureView(props: { traceIds: string[]; messages: DemoMessage[]; edges: DemoEdge[]; topicId?: string; onNavigateToMessage?: (messageId: string) => void }) {
  const { traceIds, messages, edges, topicId, onNavigateToMessage } = props;
  const navigate = useNavigate();
  const msgMap = new Map(messages.map(m => [m.id, m]));
  if (!traceIds || traceIds.length === 0) {
    return (
      <div style={{ border: '1px solid #444', borderRadius: 6, padding: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>结构视图（全局模式·简化）</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>（进入追溯后显示：左侧指向我 / 右侧我指向）</div>
      </div>
    );
  }
  return (
    <div style={{ border: '1px solid #444', borderRadius: 6, padding: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>结构视图（追溯模式 · 多消息）</div>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
        当前追溯消息：
        {traceIds.map((id, idx) => {
          const m = msgMap.get(id);
          return <span key={id} style={{ marginLeft: idx === 0 ? 4 : 8 }}>{m ? `${m.id} · ${m.author}` : id}</span>;
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, border: '1px solid #333', borderRadius: 6, padding: 6, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>左侧（Incoming：指向追溯集合）</div>
          <IncomingOutgoingList focusIds={traceIds} edges={edges} kind="in" messages={messages} navigate={navigate} topicId={topicId} onNavigateToMessage={onNavigateToMessage} />
        </div>
        <div style={{ flex: 1, border: '1px solid #333', borderRadius: 6, padding: 6, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>右侧（Outgoing：追溯集合指向）</div>
          <IncomingOutgoingList focusIds={traceIds} edges={edges} kind="out" messages={messages} navigate={navigate} topicId={topicId} onNavigateToMessage={onNavigateToMessage} />
        </div>
      </div>
    </div>
  );
}
