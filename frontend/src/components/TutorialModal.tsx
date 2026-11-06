import { useRef, type MouseEvent } from 'react';
import PopupOverlay from './PopupOverlay';
import { DIALOG_BACKDROP, dialogStyles } from './dialogStyles';
import { getThemeSettings, useTheme } from '../theme/theme';
import AboutLink from './AboutLink';

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
  const isOpus = getThemeSettings(useTheme()).base === 'opus';
  const openDocument = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    onClose();
  };
  const documentLinks = <p style={{ margin: isOpus ? 0 : '18px 0 0' }}><AboutLink href="/about.html#quick-start" onClick={openDocument} style={{ color: 'var(--ink-dbe4f0)', textUnderlineOffset: 3 }}>上手与界面导览</AboutLink> · <AboutLink href="/docs/usage.html" onClick={openDocument} style={{ color: 'var(--ink-dbe4f0)', textUnderlineOffset: 3 }}>阅读完整收费与操作规则</AboutLink> · <AboutLink href="/about.html#documents" onClick={openDocument} style={{ color: 'var(--ink-dbe4f0)', textUnderlineOffset: 3 }}>查看完整文档</AboutLink></p>;

  return (
    <PopupOverlay
      contentRef={contentRef}
      zIndex={1000}
      background={DIALOG_BACKDROP}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 12, boxSizing: 'border-box', overflow: 'auto',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={contentRef} role="dialog" aria-modal="true" aria-label="教程"
      style={{
        ...dialogStyles.panel,
        width: '100%', maxWidth: 500, maxHeight: '100%',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div data-dialog-header="true" style={{
          ...dialogStyles.header, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>教程</div>
          <button data-dialog-close="true" data-shortcut-cancel="true" aria-label="关闭教程" onClick={onClose} style={dialogStyles.button}>✕</button>
        </div>
        <div data-dialog-body="true" style={{
          flex: 1, minHeight: 0, maxHeight: '70vh', overflowY: 'auto',
          padding: '18px 20px', color: 'var(--ink-dbe4f0)', fontSize: 13, lineHeight: 1.7,
        }}>
          <section>
            <h2 style={{ margin: '0 0 6px', color: 'var(--ink-fff)', fontSize: 15 }}>发送按钮可以点击时，世界已经准备好聆听你的声音。</h2>
            <h2 style={{ margin: '0 0 6px', color: 'var(--ink-fff)', fontSize: 15 }}>对世界作出指示</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>登录后即可参与讨论。</li>
              <li>左侧为消息显示视图，右侧为消息操作面板。</li>
              <li>按 Alt + Enter 切换进入／退出全屏；也可按 Esc 退出全屏。工作台和其中打开的介绍文档均可使用。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: 'var(--ink-fff)', fontSize: 15 }}>发送文本消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>在“输入框（消息与关系设置）”中填写内容。</li>
              <li>设置文本的真假、价值投入，两项均为非负整数，至少一项大于 0。</li>
              <li>检查发送前预览。每条付费消息另收当前协议费，复合操作按实际生成的文本、关系和加入消息合计。</li>
              <li>确认后点击“发送”，在消息卡查看投入和相关记录。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: 'var(--ink-fff)', fontSize: 15 }}>发送关系消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>在消息操作面板区域选择关系类型。</li>
              <li>通过单击消息，切换消息选中状态，被选中的消息进入选择暂存区。</li>
              <li>通过选择暂存区右下角加入来源集合、加入目标集合按钮，将选择暂存区中的消息设为来源集合或目标集合。</li>
              <li>目标集合为空时，可直接使用选择暂存区作为目标；两处不能同时有内容，同一消息不能同时作为来源和目标。</li>
              <li>不同关系类型对来源、目标和正文有各自要求，发送按钮旁会提示缺失条件。</li>
              <li>检查本次新建消息数量、投入和协议费，确认“发送”按钮可用后发送。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: 'var(--ink-fff)', fontSize: 15 }}>发送文本消息并引用目标消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>先选中要引用的消息，可以选择一条或多条。</li>
              <li>在消息操作面板区域选择关系类型“引用”，需要时填写自定义引用标签作为引用说明。</li>
              <li>在“输入框（消息与关系设置）”中填写内容，设置文本与关系的投入；预览会合计需要新建的消息费用，确认后发送。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: 'var(--ink-fff)', fontSize: 15 }}>对目标消息发送赞同消息</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>选中想要支持的消息。</li>
              <li>在消息操作面板区域选择关系类型“赞同”。</li>
              <li>点击“发送”，赞同记录会显示在该消息上。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: 'var(--ink-fff)', fontSize: 15 }}>投票</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>点击消息卡上的“真假仲裁”或“价值仲裁”入口；没有进行中轮次时可点击“发起结算”，请求需投入价值 1 点并另付协议费。</li>
              <li>按相应维度选择赞同或反对，输入正整数投票点数。</li>
              <li>检查费用后点击“投票”，按投入点数计算权重。</li>
              <li>真假投票对应赞同、反对立场；价值投票对应推荐、冷藏评价。</li>
            </ol>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 6px', color: 'var(--ink-fff)', fontSize: 15 }}>结算</h2>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>使用消息卡的“真假仲裁”或“价值仲裁”入口打开对应面板。</li>
              <li>在结算面板找到并点击“结算”按钮。</li>
              <li>确认终止请求的价值投入 1 点和协议费；规则若设有等待时间，在截止后计算。</li>
              <li>系统累计相关押注比较双方权重，胜方收回本金并按比例分配败方本金；平局退还押注本金，协议费不退。</li>
              <li>后续轮次可以改变结果：撤回先前分配、恢复相关本金，再按累计押注重新分配，历史记录保留。</li>
            </ol>
          </section>

          {!isOpus && documentLinks}
        </div>
        {isOpus && <div data-dialog-footer="true" style={{ flexShrink: 0, padding: '14px 20px', borderTop: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 }}>{documentLinks}</div>}
      </div>
    </PopupOverlay>
  );
}
