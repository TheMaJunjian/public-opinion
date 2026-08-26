import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface GuideTargetDetail {
  messageId: string;
  title?: string;
}

type BubblePlacement = 'right' | 'left' | 'top' | 'bottom';
type BubblePosition = {
  top: number;
  left: number;
  height: number;
  placement: BubblePlacement;
  tailOffset: number;
  tailVisible: boolean;
  diagonalTail?: { path: string; outlinePath: string };
};
type GuideStage = 'message' | 'staging' | 'stance' | 'contribution';
type TailSegment = [{ x: number; y: number }, { x: number; y: number }];
const BUBBLE_MAX_WIDTH = 460;
function getBubblePosition(rect: DOMRect, height = 340): BubblePosition {
  const width = Math.min(BUBBLE_MAX_WIDTH, window.innerWidth - 32);
  const gap = 24;
  const margin = 16;
  const tailLength = 31;
  const tailHalfWidth = 12;
  const tailLandingHalfWidth = 16;
  const tailCornerInset = 52;
  const tailLandingOverlap = 1;
  const boundaryRatios = [0.12, 0.24, 0.36, 0.5, 0.64, 0.76, 0.88];
  const candidates: Array<{ left: number; top: number; placement: BubblePlacement; tailOffset: number; targetPoint: { x: number; y: number }; tail: { left: number; top: number; right: number; bottom: number } }> = [];
  for (const ratio of boundaryRatios) {
    const y = rect.top + rect.height * ratio;
    const x = rect.left + rect.width * ratio;
    candidates.push(
      { left: rect.right + gap, top: y - height / 2, placement: 'right', tailOffset: 0, targetPoint: { x: rect.right, y }, tail: { left: rect.right + gap - tailLength, top: y - tailHalfWidth, right: rect.right + gap, bottom: y + tailHalfWidth } },
      { left: rect.left - width - gap, top: y - height / 2, placement: 'left', tailOffset: 0, targetPoint: { x: rect.left, y }, tail: { left: rect.left - gap, top: y - tailHalfWidth, right: rect.left - gap + tailLength, bottom: y + tailHalfWidth } },
      { left: x - width / 2, top: rect.top - height - gap, placement: 'top', tailOffset: 0, targetPoint: { x, y: rect.top }, tail: { left: x - tailHalfWidth, top: rect.top - gap, right: x + tailHalfWidth, bottom: rect.top - gap + tailLength } },
      { left: x - width / 2, top: rect.bottom + gap, placement: 'bottom', tailOffset: 0, targetPoint: { x, y: rect.bottom }, tail: { left: x - tailHalfWidth, top: rect.bottom + gap - tailLength, right: x + tailHalfWidth, bottom: rect.bottom + gap } },
    );
  }
  const makeTailSegments = (candidate: typeof candidates[number]): TailSegment[] => {
    const isHorizontal = candidate.placement === 'top' || candidate.placement === 'bottom';
    const attachesAtPositiveSide = candidate.targetPoint.x >= rect.left + rect.width / 2;
    const anchorX = isHorizontal ? (attachesAtPositiveSide ? candidate.left + width - tailCornerInset : candidate.left + tailCornerInset) : (candidate.placement === 'right' ? candidate.left : candidate.left + width);
    const anchorY = isHorizontal ? (candidate.placement === 'bottom' ? candidate.top : candidate.top + height) : (candidate.targetPoint.y >= rect.top + rect.height / 2 ? candidate.top + height - tailCornerInset : candidate.top + tailCornerInset);
    const inward = candidate.placement === 'right' ? { x: 1, y: 0 }
      : candidate.placement === 'left' ? { x: -1, y: 0 }
        : candidate.placement === 'bottom' ? { x: 0, y: 1 }
          : { x: 0, y: -1 };
    const landing = { x: anchorX + inward.x * tailLandingOverlap, y: anchorY + inward.y * tailLandingOverlap };
    const first = isHorizontal ? { x: landing.x - tailLandingHalfWidth, y: landing.y } : { x: landing.x, y: landing.y - tailLandingHalfWidth };
    const second = isHorizontal ? { x: landing.x + tailLandingHalfWidth, y: landing.y } : { x: landing.x, y: landing.y + tailLandingHalfWidth };
    const outward = candidate.placement === 'right' ? { x: 1, y: 0 }
      : candidate.placement === 'left' ? { x: -1, y: 0 }
        : candidate.placement === 'bottom' ? { x: 0, y: 1 }
          : { x: 0, y: -1 };
    const start = { x: candidate.targetPoint.x + outward.x * 0.5, y: candidate.targetPoint.y + outward.y * 0.5 };
    return [[start, first], [start, second]];
  };
  const selected = candidates.find(candidate => {
    const bubble = { left: candidate.left, top: candidate.top, right: candidate.left + width, bottom: candidate.top + height };
    const inViewport = bubble.left >= margin && bubble.top >= margin && bubble.right <= window.innerWidth - margin && bubble.bottom <= window.innerHeight - margin;
    return inViewport;
  }) ?? candidates[3];
  const diagonalTailVisible = true;
  const left = Math.max(margin, Math.min(selected.left, window.innerWidth - width - margin));
  const top = Math.max(margin, Math.min(selected.top, window.innerHeight - height - margin));
  const positionedSelected = { ...selected, left, top };
  const diagonalTail = makeTailSegments(positionedSelected);
  const targetPoint = selected.placement === 'right' || selected.placement === 'left'
    ? selected.tail.top + tailHalfWidth
    : selected.tail.left + tailHalfWidth;
  return {
    left,
    top,
    height,
    placement: selected.placement,
    tailVisible: false,
    tailOffset: selected.placement === 'right' || selected.placement === 'left'
      ? Math.max(12, Math.min(height - 12, targetPoint - top))
      : Math.max(12, Math.min(width - 12, targetPoint - left)),
    diagonalTail: diagonalTailVisible ? {
      path: `M ${diagonalTail[0][0].x} ${diagonalTail[0][0].y} L ${diagonalTail[0][1].x} ${diagonalTail[0][1].y} L ${diagonalTail[1][1].x} ${diagonalTail[1][1].y} Z`,
      outlinePath: `M ${diagonalTail[0][0].x} ${diagonalTail[0][0].y} L ${diagonalTail[0][1].x} ${diagonalTail[0][1].y} M ${diagonalTail[0][0].x} ${diagonalTail[0][0].y} L ${diagonalTail[1][1].x} ${diagonalTail[1][1].y}`,
    } : undefined,
  };
}

export default function GuideOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [target, setTarget] = useState<GuideTargetDetail | null>(null);
  const targetRef = useRef<GuideTargetDetail | null>(null);
  const highlightedElementRef = useRef<HTMLElement | null>(null);
  const [completed, setCompleted] = useState(false);
  const [guideStage, setGuideStage] = useState<GuideStage>('message');
  const [visibilityHint, setVisibilityHint] = useState('正在定位目标消息…');
  const [bubblePosition, setBubblePosition] = useState<BubblePosition | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setCompleted(false);
    setGuideStage('message');
    const onSelectionComplete = () => {
      setGuideStage('staging');
      window.dispatchEvent(new Event('guide-clear-visuals'));
    };
    const onStanceSelected = () => {
      setGuideStage('contribution');
      window.dispatchEvent(new Event('guide-clear-visuals'));
    };
    window.addEventListener('guide-selection-complete', onSelectionComplete);
    window.addEventListener('guide-stance-selected', onStanceSelected);
    const onTarget = (event: Event) => {
      const detail = (event as CustomEvent<GuideTargetDetail>).detail;
      targetRef.current = detail;
      setTarget(detail);
      let attempts = 0;
      const locate = () => {
        const element = document.querySelector<HTMLElement>(`[data-msgid="${CSS.escape(detail.messageId)}"]`);
        if (!element && attempts++ < 12) { window.setTimeout(locate, 120); return; }
        if (!element) { setVisibilityHint('暂时找不到目标消息，请保持在当前主题后重试。'); return; }
        element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        highlightedElementRef.current = element;
        element.style.boxShadow = '0 0 0 3px #facc15, 0 0 22px rgba(250,204,21,0.65)';
        setBubblePosition(getBubblePosition(element.getBoundingClientRect()));
        setVisibilityHint('目标消息已定位在左侧显示视图-结构图。选择暂存区位于右侧操作面板，如看不到请滚动右侧面板；界面过窄时请先缩小界面。');
      };
      locate();
    };
    window.addEventListener('guide-target-ready', onTarget);
    window.dispatchEvent(new Event('guide-start'));
    return () => {
      if (highlightedElementRef.current) highlightedElementRef.current.style.boxShadow = '';
      window.removeEventListener('guide-selection-complete', onSelectionComplete);
      window.removeEventListener('guide-stance-selected', onStanceSelected);
      window.removeEventListener('guide-target-ready', onTarget);
      window.dispatchEvent(new Event('guide-stop'));
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const clearHighlight = () => {
      if (highlightedElementRef.current) highlightedElementRef.current.style.boxShadow = '';
    };
    window.addEventListener('guide-clear-visuals', clearHighlight);
    return () => window.removeEventListener('guide-clear-visuals', clearHighlight);
  }, [open]);

  useEffect(() => {
    if (!open || completed || (guideStage !== 'staging' && guideStage !== 'stance' && guideStage !== 'contribution')) return;
    const elements = guideStage === 'staging'
      ? [document.querySelector<HTMLElement>('[data-guide-selection-staging="true"]')]
      : guideStage === 'stance'
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-guide-stance-type="true"]'))
        : [document.querySelector<HTMLElement>('[data-guide-contribution-stake="true"]')];
    const highlightedElements = elements.filter((element): element is HTMLElement => Boolean(element));
    if (highlightedElements.length === 0) return;
    highlightedElements.forEach(element => { element.style.boxShadow = '0 0 0 3px #facc15, 0 0 22px rgba(250,204,21,0.65)'; });
    return () => {
      highlightedElements.forEach(element => { element.style.boxShadow = ''; });
    };
  }, [open, completed, guideStage]);

  useEffect(() => {
    if (!open || completed) return;
    const updateHint = () => {
      const targetElement = guideStage === 'staging'
        ? document.querySelector<HTMLElement>('[data-guide-selection-staging="true"]')
        : guideStage === 'stance'
          ? (() => {
            const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-guide-stance-type="true"]'));
            const rects = elements.map(element => element.getBoundingClientRect());
            if (rects.length === 0) return null;
            const left = Math.min(...rects.map(rect => rect.left));
            const top = Math.min(...rects.map(rect => rect.top));
            const right = Math.max(...rects.map(rect => rect.right));
            const bottom = Math.max(...rects.map(rect => rect.bottom));
            return new DOMRect(left, top, right - left, bottom - top);
          })()
        : guideStage === 'contribution'
          ? document.querySelector<HTMLElement>('[data-guide-contribution-stake="true"]')
        : target?.messageId
          ? document.querySelector<HTMLElement>(`[data-msgid="${CSS.escape(target.messageId)}"]`)
          : null;
      const rightPanel = document.querySelector<HTMLElement>('[data-guide-right-panel="true"]');
      if (!targetElement || !rightPanel) return;
      const targetRect = targetElement instanceof DOMRect ? targetElement : targetElement.getBoundingClientRect();
      const rightRect = rightPanel.getBoundingClientRect();
      const targetVisible = targetRect.bottom > 0 && targetRect.top < window.innerHeight;
      const rightVisible = rightRect.bottom > 0 && rightRect.top < window.innerHeight && rightRect.left < window.innerWidth;
      setBubblePosition(current => getBubblePosition(targetRect, current?.height ?? 340));
      if (guideStage === 'staging') setVisibilityHint('消息已经加入选择暂存区，当目标集合为空时，选择暂存区中存在的消息被视为已加入目标集合。');
      else if (guideStage === 'stance') setVisibilityHint('赞同你赞同的，反对你反对的。');
      else if (guideStage === 'contribution') setVisibilityHint('发送前可以修改这次操作使用的贡献点。');
      else if (!targetVisible) setVisibilityHint('目标消息当前不在可视区域，请滚动左侧结构图。');
      else if (!rightVisible) setVisibilityHint('目标消息已定位。请滚动右侧面板查看选择暂存区；界面过窄时请先缩小界面。');
    };
    updateHint();
    const timer = window.setInterval(updateHint, 500);
    return () => window.clearInterval(timer);
  }, [open, completed, guideStage, target?.messageId]);

  useLayoutEffect(() => {
    if (!open || completed || !bubbleRef.current) return;
    const measuredHeight = bubbleRef.current.offsetHeight;
    if (!measuredHeight) return;
    const targetElement = guideStage === 'staging'
      ? document.querySelector<HTMLElement>('[data-guide-selection-staging="true"]')
      : guideStage === 'stance'
        ? (() => {
          const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-guide-stance-type="true"]'));
          const rects = elements.map(element => element.getBoundingClientRect());
          if (rects.length === 0) return null;
          const left = Math.min(...rects.map(rect => rect.left));
          const top = Math.min(...rects.map(rect => rect.top));
          const right = Math.max(...rects.map(rect => rect.right));
          const bottom = Math.max(...rects.map(rect => rect.bottom));
          return new DOMRect(left, top, right - left, bottom - top);
        })()
        : guideStage === 'contribution'
          ? document.querySelector<HTMLElement>('[data-guide-contribution-stake="true"]')
        : target?.messageId
          ? document.querySelector<HTMLElement>(`[data-msgid="${CSS.escape(target.messageId)}"]`)
          : null;
    if (!targetElement) return;
    const targetRect = targetElement instanceof DOMRect ? targetElement : targetElement.getBoundingClientRect();
    setBubblePosition(current => current && current.height !== measuredHeight
      ? getBubblePosition(targetRect, measuredHeight)
      : current);
  }, [open, completed, guideStage, target?.messageId, visibilityHint]);

  if (!open) return null;

  if (completed) {
    return createPortal(
      <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.72)' }}>
        <div role="dialog" aria-modal="true" style={{ width: 'min(420px, calc(100vw - 32px))', padding: 24, border: '1px solid #86efac', borderRadius: 12, background: '#18181b', color: '#f4f4f5', boxShadow: '0 12px 40px rgba(0,0,0,0.55)', textAlign: 'center' }}>
          <div style={{ fontSize: 30, color: '#86efac' }}>✓</div>
          <h2 style={{ margin: '8px 0', fontSize: 18 }}>已完成引导</h2>
          <p style={{ margin: 0, color: '#d4d4d8', fontSize: 13, lineHeight: 1.7 }}>消息选择、站队和发送前贡献点设置引导已完成。</p>
          <button type="button" onClick={onClose} style={{ marginTop: 18, padding: '7px 20px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer' }}>完成</button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div data-guide-overlay="true" style={{ position: 'fixed', inset: 0, zIndex: 900, pointerEvents: 'none' }}>
      {bubblePosition?.diagonalTail && (
        <svg aria-hidden="true" width="100%" height="100%" viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`} style={{ position: 'fixed', inset: 0, zIndex: 2, overflow: 'visible', pointerEvents: 'none' }}>
          <rect x={bubblePosition.left} y={bubblePosition.top} width={Math.min(BUBBLE_MAX_WIDTH, window.innerWidth - 32)} height={bubblePosition.height} rx="16" fill="rgba(24,24,27,0.96)" stroke="#facc15" strokeWidth="1" />
          <path d={bubblePosition.diagonalTail.path} fill="rgba(24,24,27,0.96)" stroke="none" />
          <path d={bubblePosition.diagonalTail.outlinePath} fill="none" stroke="#facc15" strokeWidth="1" strokeLinecap="butt" />
        </svg>
      )}
      <div ref={bubbleRef} data-guide-bubble="true" style={{
        position: 'fixed', top: bubblePosition?.top ?? 24, left: bubblePosition?.left ?? 24, zIndex: 3, width: `min(${BUBBLE_MAX_WIDTH}px, calc(100vw - 32px))`, height: 'auto', minHeight: 0, boxSizing: 'border-box',
        padding: '15px 18px 32px', border: 0, borderRadius: 16,
        background: 'transparent', color: '#f4f4f5',
        boxShadow: 'none', pointerEvents: 'auto',
      }}>
        <div style={{
          position: 'absolute', width: 32, height: 24, background: '#facc15', zIndex: 1,
          display: bubblePosition?.tailVisible === false ? 'none' : undefined,
          ...(bubblePosition?.placement === 'left' ? { right: -31, top: (bubblePosition.tailOffset - 12), clipPath: 'polygon(0 0, 0 100%, 100% 34%)' } :
            bubblePosition?.placement === 'top' ? { width: 24, height: 32, left: (bubblePosition.tailOffset - 12), bottom: -31, clipPath: 'polygon(0 0, 100% 0, 68% 100%)' } :
              bubblePosition?.placement === 'bottom' ? { width: 24, height: 32, left: (bubblePosition.tailOffset - 12), top: -31, clipPath: 'polygon(0 100%, 100% 100%, 32% 0)' } :
                { left: -31, top: ((bubblePosition?.tailOffset ?? 12) - 12), clipPath: 'polygon(100% 0, 100% 100%, 0 66%)' }),
        }}>
          <div style={{
            position: 'absolute', background: 'rgba(24,24,27,0.96)', zIndex: 1,
            ...(bubblePosition?.placement === 'left' ? { width: 32, height: 20, left: -1, top: 2, clipPath: 'polygon(0 0, 0 100%, 100% 34%)' } :
              bubblePosition?.placement === 'top' ? { width: 20, height: 32, left: 2, top: -1, clipPath: 'polygon(0 0, 100% 0, 68% 100%)' } :
                bubblePosition?.placement === 'bottom' ? { width: 20, height: 32, left: 2, bottom: -1, clipPath: 'polygon(0 100%, 100% 100%, 32% 0)' } :
                  { width: 32, height: 20, right: -1, top: 2, clipPath: 'polygon(100% 0, 100% 100%, 0 66%)' }),
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <strong style={{ color: '#fde68a' }}>{guideStage === 'staging' ? '消息已加入选择暂存区' : guideStage === 'stance' ? '选择站队关系' : guideStage === 'contribution' ? '发送前修改贡献点' : '选择目标消息'}</strong>
          <button type="button" onClick={onClose} style={{ border: 0, background: 'transparent', color: '#a1a1aa', cursor: 'pointer', fontSize: 18 }} aria-label="关闭引导">×</button>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.65 }}>
          <div style={{ color: '#a1a1aa', fontSize: 11 }}>操作</div>
          <div>{guideStage === 'staging' ? '请查看右侧选择暂存区' : guideStage === 'stance' ? '请选择赞同或反对' : guideStage === 'contribution' ? '发送前调整贡献点押注数值' : '单击选择消息'}</div>
          <div style={{ marginTop: 8, color: '#fcd34d', fontSize: 12 }}>提示</div>
          <div>{guideStage === 'staging' ? '消息已加入选择暂存区，点击相关按钮可将选择暂存区中的所有消息加入来源集合或目标集合。' : guideStage === 'stance' ? '对正确的消息内容，选择赞同。' : guideStage === 'contribution' ? '贡献点数值会影响发送时的消耗，发送前可以按需要修改。' : '单击选中，再次单击取消选中；双击空白区域可取消所有选中。'}</div>
          <div style={{ marginTop: 8, color: '#a1a1aa', fontSize: 12 }}>说明</div>
          <div>{visibilityHint}</div>
          {target && <div style={{ marginTop: 8, color: '#a1a1aa', fontSize: 11 }}>目标消息ID：{target.messageId}</div>}
          {target?.title && <div style={{ marginTop: 4, color: '#d4d4d8', fontSize: 12, lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>目标消息内容：{target.title}</div>}
          <div style={{ marginTop: 8, color: '#86efac', fontSize: 12 }}>{guideStage === 'staging' ? '提醒：点击下一步继续。' : guideStage === 'stance' ? '提醒：选择关系类型后继续下一步。' : guideStage === 'contribution' ? '提醒：完成发送前押注贡献点调整后，点击下一步继续。' : '提醒：选中后继续下一步。'}</div>
        </div>
        {guideStage === 'staging' && <button type="button" onClick={() => { setGuideStage('stance'); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>下一步</button>}
        {guideStage === 'contribution' && <button type="button" onClick={() => { setCompleted(true); window.dispatchEvent(new Event('guide-clear-visuals')); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>下一步</button>}
      </div>
    </div>,
    document.body,
  );
}
