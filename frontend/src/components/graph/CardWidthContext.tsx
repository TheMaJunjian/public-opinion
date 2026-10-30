import { createContext, useContext, useRef } from 'react';
import { CARD_W } from '../../utils/layout';
import { MAX_CARD_WIDTH } from '../../utils/cardWidth';

export const CardWidthContext = createContext<{
  widths: Record<string, number>;
  editing: { messageId: string; width: number; onChange: (width: number) => void } | null;
} | null>(null);

/** A draft-only resize handle. The composer sends the resulting correction. */
export function CardWidthHandle({ messageId }: { messageId: string }) {
  const context = useContext(CardWidthContext);
  const drag = useRef<{ x: number; width: number; scale: number } | null>(null);
  const editing = context?.editing;
  if (editing?.messageId !== messageId) return null;
  return <div role="separator" aria-label={`调整消息 ${messageId} 的宽度`} aria-orientation="vertical"
    aria-valuemin={CARD_W} aria-valuemax={MAX_CARD_WIDTH} aria-valuenow={editing.width} tabIndex={0}
    data-card-width-handle="true" data-rel-overlay="true" data-gesture-ignore="true"
    title="拖动调整宽度，左右方向键微调，双击恢复默认；发送更正后保存"
    style={{ position: 'absolute', right: -5, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', touchAction: 'none', zIndex: 20, borderRight: '2px solid var(--line-38bdf8)' }}
    onClick={event => event.stopPropagation()} onDoubleClick={event => { event.stopPropagation(); editing.onChange(CARD_W); }}
    onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      editing.onChange(event.key === 'Home' ? CARD_W : Math.max(CARD_W, Math.min(MAX_CARD_WIDTH, editing.width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10))));
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const card = event.currentTarget.parentElement!;
      const scale = card.offsetWidth ? card.getBoundingClientRect().width / card.offsetWidth : 1;
      drag.current = { x: event.clientX, width: card.offsetWidth || editing.width, scale: scale || 1 };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (!drag.current) return;
      event.stopPropagation();
      editing.onChange(Math.max(CARD_W, Math.min(MAX_CARD_WIDTH, Math.round(drag.current.width + (event.clientX - drag.current.x) / drag.current.scale))));
    }}
    onPointerUp={event => { event.stopPropagation(); drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} />;
}
