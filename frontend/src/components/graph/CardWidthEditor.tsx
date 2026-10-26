import { useEffect, useState } from 'react';
import { CARD_W } from '../../utils/layout';
import { isCardWidth, MAX_CARD_WIDTH } from '../../utils/cardWidth';

export default function CardWidthEditor({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const [input, setInput] = useState(String(width));
  useEffect(() => setInput(String(width)), [width]);
  return <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
    消息卡宽度
    <input type="range" aria-label="消息卡宽度滑块" min={CARD_W} max={MAX_CARD_WIDTH} step={10} value={width}
      onChange={event => onChange(Number(event.target.value))} />
    <input type="number" aria-label="消息卡宽度" min={CARD_W} max={MAX_CARD_WIDTH} step={1} value={input}
      style={{ width: 76 }} onChange={event => {
        setInput(event.target.value);
        const value = Number(event.target.value);
        if (isCardWidth(value)) onChange(value);
      }} onBlur={() => {
        const value = input.trim() ? Math.max(CARD_W, Math.min(MAX_CARD_WIDTH, Math.round(Number(input)))) : width;
        const next = Number.isFinite(value) ? value : width;
        setInput(String(next)); onChange(next);
      }} /> px
    <span>选择一条完整消息，可拖动卡片右侧边缘；发送后保存，ID 所需空间会自动保留。</span>
  </label>;
}
