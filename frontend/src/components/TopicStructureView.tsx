import type { DemoEdge, DemoMessage, UnitSelection } from '../utils/modelBridge';
import { relationTypeName } from './GraphView';

const INCOMING_OUTGOING_LIST_MAX_H = 120;

function fmtSel(u: UnitSelection) {
  if (u.selection.kind === 'whole') return `${u.messageId}（整条消息）`;
  if (u.selection.kind === 'edge') return `${u.messageId}（关系边 ${u.selection.edgeId}）`;
  const sel = u.selection;
  const preview = sel.text.slice(0, 12) + (sel.text.length > 12 ? '…' : '');
  return `${u.messageId}（文本片段 第${sel.start}位起 共${sel.len}字「${preview}」）`;
}

function IncomingOutgoingList(props: { focusIds: string[]; edges: DemoEdge[]; kind: 'in' | 'out'; messages: DemoMessage[] }) {
  const { focusIds, edges, kind, messages } = props;
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
                    {relationTypeName(e.relationType)}：{fmtSel(e.from)} → {fmtSel(e.to)}
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

export default function TopicStructureView(props: { focusIds: string[]; messages: DemoMessage[]; edges: DemoEdge[] }) {
  const { focusIds, messages, edges } = props;
  const msgMap = new Map(messages.map(m => [m.id, m]));
  if (!focusIds || focusIds.length === 0) {
    return (
      <div style={{ border: '1px solid #444', borderRadius: 6, padding: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>结构视图（全局模式·简化）</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>（进入焦点后显示：左侧指向我 / 右侧我指向）</div>
      </div>
    );
  }
  return (
    <div style={{ border: '1px solid #444', borderRadius: 6, padding: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>结构视图（焦点模式 · 多焦点）</div>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
        当前焦点消息：
        {focusIds.map((id, idx) => {
          const m = msgMap.get(id);
          return <span key={id} style={{ marginLeft: idx === 0 ? 4 : 8 }}>{m ? `${m.id} · ${m.author}` : id}</span>;
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, border: '1px solid #333', borderRadius: 6, padding: 6, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>左侧（Incoming：指向焦点集合）</div>
          <IncomingOutgoingList focusIds={focusIds} edges={edges} kind="in" messages={messages} />
        </div>
        <div style={{ flex: 1, border: '1px solid #333', borderRadius: 6, padding: 6, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>右侧（Outgoing：焦点集合指向）</div>
          <IncomingOutgoingList focusIds={focusIds} edges={edges} kind="out" messages={messages} />
        </div>
      </div>
    </div>
  );
}
