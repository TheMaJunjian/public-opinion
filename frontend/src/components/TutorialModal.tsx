import { useRef } from 'react';
import PopupOverlay from './PopupOverlay';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function TutorialModal({ open, onClose }: Props) {
  if (!open) return null;

  return <TutorialModalContent onClose={onClose} />;
}

function TutorialModalContent({ onClose }: { onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <PopupOverlay
      contentRef={contentRef}
      zIndex={1000}
      background="rgba(0,0,0,0.85)"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 12, boxSizing: 'border-box', overflow: 'auto',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={contentRef}
      style={{
        width: '90vw', maxWidth: 500, minHeight: 280,
        background: '#101010', borderRadius: 12, border: '1px solid #333',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid #333',
          background: '#181818', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>教程</div>
          <button data-shortcut-cancel="true" onClick={onClose} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 13, cursor: 'pointer',
            background: '#333', color: '#fff', border: '1px solid #666',
          }}>✕</button>
        </div>
        <div style={{
          flex: 1, minHeight: 220, maxHeight: '70vh', overflowY: 'auto',
          padding: '18px 20px', color: '#dbe4f0', fontSize: 13, lineHeight: 1.7,
        }}>
          <section>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>发送按钮可以点击时，世界已经准备好聆听你的声音。</h2>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>对世界作出指示</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>登录后即可参与讨论。</li>
              <li>左侧为消息显示视图，右侧为消息操作面板。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>发送文本消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>在“输入框（消息与关系设置）”中填写内容。</li>
              <li>设置文本押注，普通文本消息最低为 10 点。</li>
              <li>点击“发送”。</li>
              <li>发送后系统会自动创建对应的结算消息。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>发送关系消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>在消息操作面板区域选择关系类型。</li>
              <li>通过单击消息，切换消息选中状态，被选中的消息进入选择暂存区。</li>
              <li>通过选择暂存区右下角加入来源集合、加入目标集合按钮，将选择暂存区中的消息设为来源集合或目标集合。</li>
              <li>不同关系类型对选择暂存区、来源集合、目标集合、输入框（消息与关系设置）中的内容不同的要求。</li>
              <li>确认“发送”按钮可用后点击它。发送后系统会自动创建对应的结算轮次。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>发送文本消息并引用目标消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>先选中要引用的消息，可以选择一条或多条。</li>
              <li>在消息操作面板区域选择关系类型“引用”，需要时填写自定义引用标签作为引用说明。</li>
              <li>在“输入框（消息与关系设置）”中填写内容，设置关系押注，然后点击“发送”。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>对目标消息发送赞同消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>选中想要支持的消息。</li>
              <li>在消息操作面板区域选择关系类型“赞同”。</li>
              <li>点击“发送”，赞同记录会显示在该消息上。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>投票</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>点击消息卡右上角天平图标（真假仲裁按钮）打开目标消息的结算面板；没有轮次时先点击“发起结算”。</li>
              <li>选择TRUE（赞同）、FALSE（反对），输入投票押注点数，最低为 1 点。</li>
              <li>点击“投票”。</li>
              <li>等价于对目标消息发送赞同、反对消息。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: '#fff', fontSize: 15 }}>结算</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>点击消息卡右上角天平图标（真假仲裁按钮）打开目标消息的结算面板。</li>
              <li>在结算面板找到并点击“结算”按钮。</li>
              <li>在弹出窗口中进行操作确认。</li>
              <li>系统会根据双方投票权重判定结果并分配押注池。</li>
              <li>结算面板中可以发起结算，并推翻上次结算结果，使所有相关押注重新分配。</li>
            </ol>
          </section>
        </div>
      </div>
    </PopupOverlay>
  );
}
