import { useRef, useState } from 'react';
import PromptModal from '../components/PromptModal';
import { dialogStyles } from '../components/dialogStyles';
import { setTheme, useTheme, THEMES } from './theme';
import ThemeTierPreview from './ThemeTierPreview';

export default function ThemeSwitcher() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <>
    <button ref={trigger} type="button" className="theme-trigger" title="切换界面风格"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>风格</button>
    <PromptModal open={open} title="界面风格" hideActions onConfirm={close} onCancel={close}
      dialogProps={{ className: 'theme-dialog', onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } } }}
      message={<>
        <div role="radiogroup" aria-label="界面风格" className="theme-options">
          {THEMES.map(option => <label key={option.id} data-theme-option={option.id} data-selected={theme === option.id}>
            <input type="radio" name="interface-theme" value={option.id} checked={theme === option.id}
              aria-label={option.name} autoFocus={theme === option.id} onChange={() => setTheme(option.id)} />
            <span className="theme-option-swatch" aria-hidden="true" />
            <span className="theme-option-copy"><span>{option.name}</span><small>{option.description}</small></span>
          </label>)}
        </div>
        <div className="stake-tier-guide">
          <p>投入档位：真假押注＋价值押注，正反双方合计。</p>
          <ThemeTierPreview theme={theme} />
          <p>原版保留原外观。档位只表示投入规模，不代表正确或胜负；推荐投入另计。</p>
        </div>
        <div className="theme-actions"><button type="button" className="theme-close" style={dialogStyles.primaryButton} onClick={close}>关闭</button></div>
      </>} />
  </>;
}
