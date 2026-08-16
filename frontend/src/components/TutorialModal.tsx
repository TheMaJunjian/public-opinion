interface Props {
  open: boolean;
  onClose: () => void;
}

export default function TutorialModal({ open, onClose }: Props) {
  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={{
        width: '90vw', maxWidth: 500, minHeight: 280,
        background: '#101010', borderRadius: 12, border: '1px solid #333',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid #333',
          background: '#181818', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>教程</div>
          <button onClick={onClose} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 13, cursor: 'pointer',
            background: '#333', color: '#fff', border: '1px solid #666',
          }}>✕</button>
        </div>
        <div style={{
          flex: 1, minHeight: 220, maxHeight: '70vh', overflowY: 'auto',
          padding: '18px 20px', color: '#dbe4f0', fontSize: 13, lineHeight: 1.7,
        }}>
          <section>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>开始使用</h2>
            <p style={{ margin: 0 }}>
              登录后即可参与讨论。阅览导出的 JSON 文件不需要登录，但阅览模式不能发送消息、建立关系或结算。
            </p>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>发送文本消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>在消息输入框中填写内容。</li>
              <li>设置文本押注，普通文本消息最低为 10 点。</li>
              <li>点击“发送”。发送后系统会自动创建对应的结算轮次。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>发送引用消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>先选中要引用的消息，可以选择一条或多条。</li>
              <li>在右侧操作区选择关系类型“引用”；需要时填写自定义引用标签。</li>
              <li>填写引用说明，设置关系押注，然后点击“发送”。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>发送赞同消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>找到想要支持的消息。</li>
              <li>点击消息旁的“👍 赞同”图标，按提示设置押注。</li>
              <li>确认发送后，赞同记录会显示在该消息上。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>投票</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>打开目标消息的结算面板；没有轮次时先点击“发起结算”。</li>
              <li>选择支持的一方，输入投票押注点数，最低为 1 点。</li>
              <li>点击“投票”，等待投票记录更新。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>结算</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>确认本轮已经有投票押注。</li>
              <li>在结算面板点击“结算”。</li>
              <li>确认操作后，系统会根据双方投票权重判定结果并分配押注池；结算完成后不能撤销。</li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
