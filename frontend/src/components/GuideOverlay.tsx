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
type GuideStage = 'message-compose' | 'message-contribution' | 'message-consumption' | 'message-send' | 'message' | 'staging' | 'stance' | 'contribution' | 'consumption' | 'send' | 'settlement-view' | 'settle' | 'settlement-confirm' | 'settlement-confirm-action' | 'settlement-history';
type TailSegment = [{ x: number; y: number }, { x: number; y: number }];
type GuideMaskRect = { top: number; left: number; width: number; height: number };
type GuideCopy = { title: string; operation: string; prompt: string; description: string; reminder: string };
const GUIDE_COPY: Record<GuideStage, GuideCopy> = {
  'message-compose': { title: '输入文本消息内容', operation: '在输入框中输入消息内容', prompt: '输入你认为正确的内容。', description: '正确的内容会获得收益，错误的内容会付出代价。', reminder: '提醒：点击下一步进入文本消息贡献点调整。' },
  'message-contribution': { title: '调整文本消息贡献点', operation: '调整文本消息贡献点押注', prompt: '文本消息的贡献点押注数值会影响本次发送消耗。', description: '调整发送这条文本消息消耗的贡献点，确认发送时的贡献点押注数值，不能低于最低限制。', reminder: '提醒：点击下一步查看文本消息贡献点消耗。' },
  'message-consumption': { title: '查看文本消息消耗', operation: '查看文本消息消耗并点击下一步', prompt: '确认发送后的总消耗和预计剩余贡献点。', description: '查看这条文本消息发送将消耗的贡献点，以及发送后的预计剩余点数。查看完成后点击下一步。', reminder: '提醒：点击下一步进入文本消息发送。' },
  'message-send': { title: '发送文本消息', operation: '点击发送按钮', prompt: '点击发送，创建文本消息。', description: '发送按钮可以点击时，世界已经准备好聆听你的声音。', reminder: '提醒：点击发送按钮，继续下一步。' },
  message: { title: '选择目标消息', operation: '单击选择消息', prompt: '单击选中，再次单击取消选中；双击空白区域可取消所有选中。', description: '目标消息已定位，请单击它加入选择暂存区。', reminder: '提醒：选中后继续下一步。' },
  staging: { title: '消息已加入选择暂存区', operation: '请查看右侧选择暂存区', prompt: '消息已加入选择暂存区，点击相关按钮可将选择暂存区中的所有消息加入来源集合或目标集合。', description: '消息已经加入选择暂存区，当目标集合为空时，选择暂存区中存在的消息被视为已加入目标集合。', reminder: '提醒：点击下一步继续。' },
  stance: { title: '选择站队关系', operation: '请选择赞同或反对', prompt: '对正确的消息内容，选择赞同。', description: '赞同你赞同的，反对你反对的。', reminder: '提醒：选择关系类型后继续下一步。' },
  contribution: { title: '发送前修改贡献点', operation: '发送前调整贡献点押注数值', prompt: '贡献点数值会影响发送时的消耗，发送前可以按需要修改。', description: '发送前可以修改这次操作使用的贡献点。', reminder: '提醒：完成发送前押注贡献点调整后，点击下一步继续。' },
  consumption: { title: '查看贡献点消耗', operation: '查看发送按钮左侧的贡献点消耗信息', prompt: '总计显示本次操作的贡献点消耗，剩余显示发送后预计保留的贡献点。', description: '查看本次发送将消耗的贡献点，以及发送后预计剩余的贡献点。', reminder: '提醒：查看贡献点消耗后，点击下一步继续。' },
  send: { title: '发送站队关系消息', operation: '点击发送按钮', prompt: '点击发送按钮后，系统会提交这条站队关系消息。', description: '贡献点设置和消耗确认完成后，点击发送按钮提交站队关系消息。', reminder: '提醒：点击发送按钮进入下一步。' },
  'settlement-view': { title: '进入结算', operation: '点击消息卡片上的结算入口', prompt: '结算入口用于打开当前消息的结算面板。', description: '发送成功后，点击消息卡片上的结算入口查看结算面板。', reminder: '提醒：点击结算入口进入下一步。' },
  settle: { title: '点击结算', operation: '点击结算按钮', prompt: '结算按钮会打开确认弹窗，请继续查看弹窗内容。', description: '结算面板已打开，点击结算按钮查看结算确认提示。', reminder: '提醒：点击结算按钮查看确认提示。' },
  'settlement-confirm': { title: '查看结算确认提示', operation: '查看确认弹窗中的提示信息，然后点击引导窗口中的下一步', prompt: '确认弹窗会展示本轮结算结果、收益池和当前用户贡献点变化；查看完成后点击下一步。', description: '请查看结算确认弹窗中的结算结果和贡献点提示，查看完成后点击引导窗口中的下一步。', reminder: '提醒：查看提示信息后点击下一步。' },
  'settlement-confirm-action': { title: '确认结算', operation: '点击确认结算按钮', prompt: '确认弹窗中的信息已查看，点击确认结算后等待结算完成。', description: '确认弹窗提示信息已查看，请点击确认结算按钮。', reminder: '提醒：点击确认结算后，等待结算完成。' },
  'settlement-history': { title: '查看结算历史', operation: '双击对应历史结算记录展开详细信息', prompt: '双击对应的历史结算记录，可以展开查看本轮详细结算信息。', description: '结算已完成，请双击对应的历史结算记录展开详细信息，然后点击引导窗口中的完成。', reminder: '提醒：双击记录查看详情，然后点击完成。' },
};
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
  const guideStageRef = useRef<GuideStage>('message');
  const settlementRoundIdRef = useRef<string | null>(null);
  guideStageRef.current = guideStage;
  const [guideMaskRect, setGuideMaskRect] = useState<GuideMaskRect | null>(null);
  const [bubblePosition, setBubblePosition] = useState<BubblePosition | null>(null);
  const [messageDraftReady, setMessageDraftReady] = useState(false);
  const [invalidAction, setInvalidAction] = useState<{ left: number; top: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const invalidActionTimerRef = useRef<number | null>(null);
  const lastInvalidActionAtRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setCompleted(false);
    setGuideStage('message-compose');
    const onGuideTextMessageSent = (event: Event) => {
      if (guideStageRef.current !== 'message-send') return;
      const detail = (event as CustomEvent<GuideTargetDetail>).detail;
      if (!detail?.messageId) return;
      setGuideStage('message');
      window.dispatchEvent(new CustomEvent('guide-target-ready', { detail }));
    };
    const onSelectionComplete = () => {
      setGuideStage('staging');
      window.dispatchEvent(new Event('guide-clear-visuals'));
    };
    const onStanceSelected = () => {
      setGuideStage('contribution');
      window.dispatchEvent(new Event('guide-clear-visuals'));
    };
    const onGuideSendSelected = () => {
      if (guideStageRef.current !== 'send') return;
      setGuideStage('settlement-view');
      window.dispatchEvent(new Event('guide-clear-visuals'));
    };
    const onGuideSettlementOpened = () => {
      if (guideStageRef.current !== 'settlement-view') return;
      setGuideStage('settle');
      window.dispatchEvent(new Event('guide-clear-visuals'));
    };
    const onGuideSettleSelected = () => {
      if (guideStageRef.current !== 'settle') return;
      setGuideStage('settlement-confirm');
      window.dispatchEvent(new Event('guide-clear-visuals'));
    };
    const onGuideSettlementConfirmed = (event: Event) => {
      if (guideStageRef.current !== 'settlement-confirm-action') return;
      settlementRoundIdRef.current = (event as CustomEvent<{ roundId?: string }>).detail?.roundId ?? null;
      setBubblePosition(null);
      setGuideStage('settlement-history');
      window.dispatchEvent(new Event('guide-clear-visuals'));
    };
    window.addEventListener('guide-selection-complete', onSelectionComplete);
    window.addEventListener('guide-text-message-sent', onGuideTextMessageSent);
    window.addEventListener('guide-stance-selected', onStanceSelected);
    window.addEventListener('guide-send-selected', onGuideSendSelected);
    window.addEventListener('guide-settlement-opened', onGuideSettlementOpened);
    window.addEventListener('guide-settle-selected', onGuideSettleSelected);
    window.addEventListener('guide-settlement-confirmed', onGuideSettlementConfirmed);
    const onTarget = (event: Event) => {
      const detail = (event as CustomEvent<GuideTargetDetail>).detail;
      targetRef.current = detail;
      setTarget(detail);
      let attempts = 0;
      const locate = () => {
        const element = document.querySelector<HTMLElement>(`[data-msgid="${CSS.escape(detail.messageId)}"]`);
        if (!element && attempts++ < 12) { window.setTimeout(locate, 120); return; }
        if (!element) return;
        element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        highlightedElementRef.current = element;
        element.style.boxShadow = '0 0 0 3px #facc15, 0 0 22px rgba(250,204,21,0.65)';
        setBubblePosition(getBubblePosition(element.getBoundingClientRect()));
      };
      locate();
    };
    window.addEventListener('guide-target-ready', onTarget);
    window.dispatchEvent(new Event('guide-start'));
    return () => {
      if (highlightedElementRef.current) highlightedElementRef.current.style.boxShadow = '';
      window.removeEventListener('guide-selection-complete', onSelectionComplete);
      window.removeEventListener('guide-text-message-sent', onGuideTextMessageSent);
      window.removeEventListener('guide-stance-selected', onStanceSelected);
      window.removeEventListener('guide-send-selected', onGuideSendSelected);
      window.removeEventListener('guide-settlement-opened', onGuideSettlementOpened);
      window.removeEventListener('guide-settle-selected', onGuideSettleSelected);
      window.removeEventListener('guide-settlement-confirmed', onGuideSettlementConfirmed);
      window.removeEventListener('guide-target-ready', onTarget);
      window.dispatchEvent(new Event('guide-stop'));
    };
  }, [open]);

  useEffect(() => {
    if (!open || guideStage !== 'message-compose') {
      setMessageDraftReady(false);
      return;
    }
    const input = document.querySelector<HTMLTextAreaElement>('[data-guide-message-input="true"]');
    if (!input) return;
    const syncDraftState = () => setMessageDraftReady(input.value.trim().length > 0);
    syncDraftState();
    input.addEventListener('input', syncDraftState);
    return () => input.removeEventListener('input', syncDraftState);
  }, [open, guideStage]);

  useEffect(() => {
    if (!open || completed) return;
    const getAllowedTargetSelector = () => {
      if (guideStage === 'message-compose') return '[data-guide-message-input="true"]';
      if (guideStage === 'message-contribution' || guideStage === 'contribution') return '[data-guide-contribution-stake="true"]';
      if (guideStage === 'message-consumption' || guideStage === 'consumption') return '[data-guide-contribution-consumption="true"]';
      if (guideStage === 'message-send') return '[data-guide-text-message-send="true"]';
      if (guideStage === 'message' && target?.messageId) return `[data-msgid="${CSS.escape(target.messageId)}"]`;
      if (guideStage === 'staging') return '[data-guide-selection-staging="true"]';
      if (guideStage === 'stance') return '[data-guide-stance-type="true"]';
      if (guideStage === 'send') return '[data-guide-send="true"]';
      if (guideStage === 'settlement-view' && target?.messageId) return `[data-guide-settlement-entry="true"][data-guide-target-message="${CSS.escape(target.messageId)}"]`;
      if (guideStage === 'settle') return '[data-guide-settle="true"]';
      if (guideStage === 'settlement-confirm') return '[data-guide-settlement-message="true"]';
      if (guideStage === 'settlement-confirm-action') return '[data-guide-settlement-confirm="true"]';
      if (guideStage === 'settlement-history' && settlementRoundIdRef.current) return `[data-guide-settlement-history="${CSS.escape(settlementRoundIdRef.current)}"]`;
      return null;
    };
    const showInvalidAction = (event: Event) => {
      const now = Date.now();
      if (now - lastInvalidActionAtRef.current < 80) return;
      lastInvalidActionAtRef.current = now;
      const pointerEvent = event as MouseEvent;
      const eventTarget = event.target;
      const targetElement = eventTarget instanceof Element ? eventTarget : null;
      const rect = targetElement?.getBoundingClientRect();
      const left = Number.isFinite(pointerEvent.clientX) && pointerEvent.clientX > 0 ? pointerEvent.clientX : (rect?.left ?? window.innerWidth / 2) + (rect?.width ?? 0) / 2;
      const top = Number.isFinite(pointerEvent.clientY) && pointerEvent.clientY > 0 ? pointerEvent.clientY : (rect?.top ?? window.innerHeight / 2) + (rect?.height ?? 0) / 2;
      setInvalidAction({ left, top });
      if (invalidActionTimerRef.current !== null) window.clearTimeout(invalidActionTimerRef.current);
      invalidActionTimerRef.current = window.setTimeout(() => {
        setInvalidAction(null);
        invalidActionTimerRef.current = null;
      }, 500);
    };
    const blockInvalidOperation = (event: Event) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Element)) return;
      if (eventTarget.closest('[data-guide-bubble="true"] button')) return;
      const allowedTargetSelector = getAllowedTargetSelector();
      if (allowedTargetSelector && eventTarget.closest(allowedTargetSelector)) return;
      event.preventDefault();
      event.stopPropagation();
      showInvalidAction(event);
    };
    document.addEventListener('pointerdown', blockInvalidOperation, true);
    document.addEventListener('click', blockInvalidOperation, true);
    document.addEventListener('keydown', blockInvalidOperation, true);
    return () => {
      document.removeEventListener('pointerdown', blockInvalidOperation, true);
      document.removeEventListener('click', blockInvalidOperation, true);
      document.removeEventListener('keydown', blockInvalidOperation, true);
      if (invalidActionTimerRef.current !== null) window.clearTimeout(invalidActionTimerRef.current);
    };
  }, [open, completed, guideStage, target?.messageId]);

  useEffect(() => {
    if (!open) return;
    const clearHighlight = () => {
      if (highlightedElementRef.current) highlightedElementRef.current.style.boxShadow = '';
    };
    window.addEventListener('guide-clear-visuals', clearHighlight);
    return () => window.removeEventListener('guide-clear-visuals', clearHighlight);
  }, [open]);

  useEffect(() => {
    if (!open || completed || (guideStage !== 'message-compose' && guideStage !== 'message-contribution' && guideStage !== 'message-consumption' && guideStage !== 'message-send' && guideStage !== 'staging' && guideStage !== 'stance' && guideStage !== 'contribution' && guideStage !== 'consumption' && guideStage !== 'send' && guideStage !== 'settlement-view' && guideStage !== 'settle' && guideStage !== 'settlement-confirm' && guideStage !== 'settlement-confirm-action' && guideStage !== 'settlement-history')) return;
    const elements = guideStage === 'message-compose'
      ? [document.querySelector<HTMLElement>('[data-guide-message-input="true"]')]
      : guideStage === 'message-contribution'
        ? [document.querySelector<HTMLElement>('[data-guide-contribution-stake="true"]')]
        : guideStage === 'message-consumption'
          ? [document.querySelector<HTMLElement>('[data-guide-contribution-consumption="true"]')]
      : guideStage === 'message-send'
        ? [document.querySelector<HTMLElement>('[data-guide-text-message-send="true"]')]
      : guideStage === 'staging'
      ? [document.querySelector<HTMLElement>('[data-guide-selection-staging="true"]')]
      : guideStage === 'stance'
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-guide-stance-type="true"]'))
        : guideStage === 'contribution'
          ? [document.querySelector<HTMLElement>('[data-guide-contribution-stake="true"]')]
          : guideStage === 'consumption'
            ? [document.querySelector<HTMLElement>('[data-guide-contribution-consumption="true"]')]
            : guideStage === 'send'
              ? [document.querySelector<HTMLElement>('[data-guide-send="true"]')]
              : guideStage === 'settlement-view'
                ? [document.querySelector<HTMLElement>(`[data-guide-settlement-entry="true"][data-guide-target-message="${CSS.escape(target?.messageId ?? '')}"]`)]
                : guideStage === 'settle'
                  ? [document.querySelector<HTMLElement>('[data-guide-settle="true"]')]
                  : guideStage === 'settlement-confirm'
                    ? [document.querySelector<HTMLElement>('[data-guide-settlement-message="true"]')]
                    : guideStage === 'settlement-confirm-action'
                      ? [document.querySelector<HTMLElement>('[data-guide-settlement-confirm="true"]')]
                      : [document.querySelector<HTMLElement>(`[data-guide-settlement-history="${CSS.escape(settlementRoundIdRef.current ?? '')}"]`)];
    const highlightedElements = elements.filter((element): element is HTMLElement => Boolean(element));
    const applyHighlight = () => {
      const currentElements = (guideStage === 'message-compose' || guideStage === 'message-contribution' || guideStage === 'message-consumption' || guideStage === 'message-send' || guideStage === 'settle' || guideStage === 'settlement-confirm' || guideStage === 'settlement-confirm-action' || guideStage === 'settlement-history')
        ? [document.querySelector<HTMLElement>(guideStage === 'settle'
          ? '[data-guide-settle="true"]'
          : guideStage === 'message-compose'
            ? '[data-guide-message-input="true"]'
          : guideStage === 'message-contribution'
            ? '[data-guide-contribution-stake="true"]'
          : guideStage === 'message-consumption'
            ? '[data-guide-contribution-consumption="true"]'
          : guideStage === 'message-send'
            ? '[data-guide-text-message-send="true"]'
          : guideStage === 'settlement-confirm'
            ? '[data-guide-settlement-message="true"]'
            : guideStage === 'settlement-confirm-action'
              ? '[data-guide-settlement-confirm="true"]'
              : `[data-guide-settlement-history="${CSS.escape(settlementRoundIdRef.current ?? '')}"]`)].filter((element): element is HTMLElement => Boolean(element))
        : highlightedElements;
      currentElements.forEach(element => {
        element.style.boxShadow = guideStage === 'settlement-confirm'
          ? 'inset 0 0 0 3px #facc15'
          : '0 0 0 3px #facc15';
      });
      return currentElements;
    };
    let appliedElements = applyHighlight();
    const timer = (guideStage === 'message-compose' || guideStage === 'message-contribution' || guideStage === 'message-consumption' || guideStage === 'message-send' || guideStage === 'settle' || guideStage === 'settlement-confirm' || guideStage === 'settlement-confirm-action' || guideStage === 'settlement-history') && appliedElements.length === 0
      ? window.setInterval(() => { appliedElements = applyHighlight(); }, 100)
      : null;
    return () => {
      if (timer !== null) window.clearInterval(timer);
      appliedElements.forEach(element => {
        element.style.boxShadow = '';
      });
    };
  }, [open, completed, guideStage]);

  useEffect(() => {
    if (!open || completed) return;
    const updateHint = () => {
      const targetElement = guideStage === 'message-compose'
        ? document.querySelector<HTMLElement>('[data-guide-message-input="true"]')
        : guideStage === 'message-contribution'
          ? document.querySelector<HTMLElement>('[data-guide-contribution-stake="true"]')
        : guideStage === 'message-consumption'
          ? document.querySelector<HTMLElement>('[data-guide-contribution-consumption="true"]')
        : guideStage === 'message-send'
          ? document.querySelector<HTMLElement>('[data-guide-text-message-send="true"]')
        : guideStage === 'staging'
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
        : guideStage === 'consumption'
          ? document.querySelector<HTMLElement>('[data-guide-contribution-consumption="true"]')
        : guideStage === 'send'
          ? document.querySelector<HTMLElement>('[data-guide-send="true"]')
        : guideStage === 'settlement-view'
          ? document.querySelector<HTMLElement>(`[data-guide-settlement-entry="true"][data-guide-target-message="${CSS.escape(target?.messageId ?? '')}"]`)
        : guideStage === 'settle'
          ? document.querySelector<HTMLElement>('[data-guide-settle="true"]')
        : guideStage === 'settlement-confirm'
          ? document.querySelector<HTMLElement>('[data-guide-settlement-message="true"]')
        : guideStage === 'settlement-confirm-action'
          ? document.querySelector<HTMLElement>('[data-guide-settlement-confirm="true"]')
        : guideStage === 'settlement-history'
          ? document.querySelector<HTMLElement>(`[data-guide-settlement-history="${CSS.escape(settlementRoundIdRef.current ?? '')}"]`)
        : target?.messageId
          ? document.querySelector<HTMLElement>(`[data-msgid="${CSS.escape(target.messageId)}"]`)
          : null;
      const rightPanel = document.querySelector<HTMLElement>('[data-guide-right-panel="true"]');
      if (!targetElement || !rightPanel) {
        setGuideMaskRect(null);
        if (guideStage === 'settlement-history') setBubblePosition(null);
        return;
      }
      const targetRect = targetElement instanceof DOMRect ? targetElement : targetElement.getBoundingClientRect();
      setGuideMaskRect({ top: targetRect.top, left: targetRect.left, width: targetRect.width, height: targetRect.height });
      setBubblePosition(current => getBubblePosition(targetRect, current?.height ?? 340));
    };
    updateHint();
    const timer = window.setInterval(updateHint, guideStage === 'settlement-history' ? 100 : 500);
    return () => window.clearInterval(timer);
  }, [open, completed, guideStage, target?.messageId]);

  useLayoutEffect(() => {
    if (!open || completed || !bubbleRef.current) return;
    const measuredHeight = bubbleRef.current.offsetHeight;
    if (!measuredHeight) return;
    const targetElement = guideStage === 'message-compose'
      ? document.querySelector<HTMLElement>('[data-guide-message-input="true"]')
      : guideStage === 'message-contribution'
        ? document.querySelector<HTMLElement>('[data-guide-contribution-stake="true"]')
        : guideStage === 'message-consumption'
          ? document.querySelector<HTMLElement>('[data-guide-contribution-consumption="true"]')
      : guideStage === 'message-send'
        ? document.querySelector<HTMLElement>('[data-guide-text-message-send="true"]')
        : guideStage === 'staging'
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
        : guideStage === 'consumption'
          ? document.querySelector<HTMLElement>('[data-guide-contribution-consumption="true"]')
        : guideStage === 'send'
          ? document.querySelector<HTMLElement>('[data-guide-send="true"]')
        : guideStage === 'settlement-view'
          ? document.querySelector<HTMLElement>(`[data-guide-settlement-entry="true"][data-guide-target-message="${CSS.escape(target?.messageId ?? '')}"]`)
        : guideStage === 'settle'
          ? document.querySelector<HTMLElement>('[data-guide-settle="true"]')
        : guideStage === 'settlement-confirm'
          ? document.querySelector<HTMLElement>('[data-guide-settlement-message="true"]')
        : guideStage === 'settlement-confirm-action'
          ? document.querySelector<HTMLElement>('[data-guide-settlement-confirm="true"]')
        : guideStage === 'settlement-history'
          ? document.querySelector<HTMLElement>(`[data-guide-settlement-history="${CSS.escape(settlementRoundIdRef.current ?? '')}"]`)
        : target?.messageId
          ? document.querySelector<HTMLElement>(`[data-msgid="${CSS.escape(target.messageId)}"]`)
          : null;
    if (!targetElement) return;
    const targetRect = targetElement instanceof DOMRect ? targetElement : targetElement.getBoundingClientRect();
    setBubblePosition(getBubblePosition(targetRect, measuredHeight));
  }, [open, completed, guideStage, target?.messageId]);

  if (!open) return null;

  if (completed) {
    return createPortal(
      <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.72)' }}>
        <div role="dialog" aria-modal="true" style={{ width: 'min(420px, calc(100vw - 32px))', padding: 24, border: '1px solid #86efac', borderRadius: 12, background: '#18181b', color: '#f4f4f5', boxShadow: '0 12px 40px rgba(0,0,0,0.55)', textAlign: 'center' }}>
          <div style={{ fontSize: 30, color: '#86efac' }}>✓</div>
          <h2 style={{ margin: '8px 0', fontSize: 18 }}>与会者引导完成</h2>
          <p style={{ margin: 0, color: '#d4d4d8', fontSize: 13, lineHeight: 1.7 }}>接下来，请对世界做出重要指示。</p>
          <button type="button" onClick={onClose} style={{ marginTop: 18, padding: '7px 20px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer' }}>完成</button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div data-guide-overlay="true" style={{ position: 'fixed', inset: 0, zIndex: 3100, pointerEvents: 'none' }}>
      {guideMaskRect && (
        <div aria-hidden="true" style={{ position: 'fixed', top: guideMaskRect.top, left: guideMaskRect.left, width: guideMaskRect.width, height: guideMaskRect.height, zIndex: 1, pointerEvents: 'none', boxShadow: '0 0 0 9999px rgba(0,0,0,0.14)' }} />
      )}
      {invalidAction && (
        <div role="status" style={{ position: 'fixed', left: invalidAction.left, top: invalidAction.top, transform: 'translate(-50%, -120%)', zIndex: 5, padding: '5px 9px', borderRadius: 5, background: '#7f1d1d', color: '#fee2e2', fontSize: 12, whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(0,0,0,0.35)' }}>
          当前步骤不可操作
        </div>
      )}
      {bubblePosition?.diagonalTail && (
        <svg aria-hidden="true" width="100%" height="100%" viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`} style={{ position: 'fixed', inset: 0, zIndex: 2, overflow: 'visible', pointerEvents: 'none' }}>
          <rect x={bubblePosition.left} y={bubblePosition.top} width={Math.min(BUBBLE_MAX_WIDTH, window.innerWidth - 32)} height={bubblePosition.height} rx="16" fill="rgba(24,24,27,0.96)" stroke="#facc15" strokeWidth="1" />
          <path d={bubblePosition.diagonalTail.path} fill="rgba(24,24,27,0.96)" stroke="none" />
          <path d={bubblePosition.diagonalTail.outlinePath} fill="none" stroke="#facc15" strokeWidth="1" strokeLinecap="butt" />
        </svg>
      )}
      <div key={guideStage} ref={bubbleRef} data-guide-bubble="true" style={{
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <strong style={{ color: '#fde68a' }}>{GUIDE_COPY[guideStage].title}</strong>
          <button type="button" onClick={onClose} style={{ flex: '0 0 28px', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', margin: 0, padding: 0, border: 0, borderRadius: 0, background: 'transparent', color: '#d4d4d8', cursor: 'pointer', fontSize: 19, fontWeight: 400, lineHeight: 1 }} aria-label="关闭引导">×</button>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.65 }}>
          <div style={{ color: '#a1a1aa', fontSize: 11 }}>操作</div>
          <div>{GUIDE_COPY[guideStage].operation}</div>
          <div style={{ marginTop: 8, color: '#fcd34d', fontSize: 12 }}>提示</div>
          <div>{GUIDE_COPY[guideStage].prompt}</div>
          <div style={{ marginTop: 8, color: '#a1a1aa', fontSize: 12 }}>说明</div>
          <div>{GUIDE_COPY[guideStage].description}</div>
          {target && <div style={{ marginTop: 8, color: '#a1a1aa', fontSize: 11 }}>目标消息ID：{target.messageId}</div>}
          {target?.title && <div style={{ marginTop: 4, color: '#d4d4d8', fontSize: 12, lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>目标消息内容：{target.title}</div>}
          <div style={{ marginTop: 8, color: '#86efac', fontSize: 12 }}>{GUIDE_COPY[guideStage].reminder}</div>
        </div>
        {guideStage === 'message-compose' && <button type="button" disabled={!messageDraftReady} onClick={() => { if (!messageDraftReady) return; setGuideStage('message-contribution'); window.dispatchEvent(new Event('guide-clear-visuals')); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: messageDraftReady ? '#14532d' : '#27272a', color: messageDraftReady ? '#dcfce7' : '#71717a', cursor: messageDraftReady ? 'pointer' : 'not-allowed', fontSize: 12 }}>下一步</button>}
        {guideStage === 'message-contribution' && <button type="button" onClick={() => { setGuideStage('message-consumption'); window.dispatchEvent(new Event('guide-clear-visuals')); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>下一步</button>}
        {guideStage === 'message-consumption' && <button type="button" onClick={() => { setGuideStage('message-send'); window.dispatchEvent(new Event('guide-clear-visuals')); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>下一步</button>}
        {guideStage === 'staging' && <button type="button" onClick={() => { setGuideStage('stance'); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>下一步</button>}
        {guideStage === 'contribution' && <button type="button" onClick={() => { setGuideStage('consumption'); window.dispatchEvent(new Event('guide-clear-visuals')); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>下一步</button>}
        {guideStage === 'consumption' && <button type="button" onClick={() => { setGuideStage('send'); window.dispatchEvent(new Event('guide-clear-visuals')); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>下一步</button>}
        {guideStage === 'settlement-confirm' && <button type="button" onClick={(event) => { event.stopPropagation(); setGuideStage('settlement-confirm-action'); window.dispatchEvent(new Event('guide-clear-visuals')); }} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>下一步</button>}
        {guideStage === 'settlement-history' && <button type="button" onClick={() => setCompleted(true)} style={{ position: 'absolute', right: 18, bottom: 14, padding: '6px 16px', border: '1px solid #86efac', borderRadius: 5, background: '#14532d', color: '#dcfce7', cursor: 'pointer', fontSize: 12 }}>完成</button>}
      </div>
    </div>,
    document.body,
  );
}
