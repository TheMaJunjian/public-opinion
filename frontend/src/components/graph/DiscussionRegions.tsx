import { useLayoutEffect, useRef, type CSSProperties, type SyntheticEvent } from 'react';
import type { DiscussionRegionGeometry } from '../../utils/discussionLayout';
import { DISCUSSION_REGION_FOOTER } from '../../utils/discussionLayout';
import type { Box } from '../../utils/frameLayout';
import { intersectFrameRects } from '../../utils/frameViewports';
import { discussionLabels as labels, discussionTypes } from '../../utils/discussionTypes';

const accents = { agree: 'var(--ink-86efac)', reply: 'var(--ink-93c5fd)', disagree: 'var(--ink-fca5a5)', recommend: 'var(--ink-fbbf24)', archive: 'var(--ink-94a3b8)' };
const stop = (event: SyntheticEvent) => event.stopPropagation();

/** Automatic view frames own their folding entry; message cards remain unchanged. */
export default function DiscussionRegions({ regions, onToggle, clipFor, summaryCounts, hiddenSummaryKeys, onToggleSummary, onHeaderWidthsChange }: {
  regions: readonly DiscussionRegionGeometry[];
  onToggle: (key: string) => void;
  clipFor: (targetId: string) => Box | undefined;
  summaryCounts?: ReadonlyMap<string, number>;
  hiddenSummaryKeys?: ReadonlySet<string>;
  onToggleSummary?: (key: string) => void;
  onHeaderWidthsChange?: (widths: Readonly<Record<string, number>>) => void;
}) {
  const headerContents = useRef<Record<string, HTMLSpanElement | null>>({});
  const reportedWidths = useRef<{callback: typeof onHeaderWidthsChange; widths: Record<string, number>}>({callback: undefined, widths: {}});
  useLayoutEffect(() => {
    if (!onHeaderWidthsChange) return;
    const measure = () => {
      const widths: Record<string, number> = {};
      for (const region of regions) {
        const content = headerContents.current[region.key], button = content?.parentElement;
        if (!content || !button) continue;
        const width = content.scrollWidth;
        if (!width) continue;
        const style = getComputedStyle(button);
        const padding = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth]
          .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
        widths[region.key] = Math.ceil(width + padding);
      }
      // Layout and card folds re-render this layer frequently. Publishing an
      // unchanged measurement from a layout effect can keep queuing updates
      // while the parent is also committing new card geometry.
      const previous = reportedWidths.current;
      if (Object.keys(widths).length && (previous.callback !== onHeaderWidthsChange
        || Object.entries(widths).some(([key, width]) => Math.abs((previous.widths[key] ?? 0) - width) > 1))) {
        reportedWidths.current = {callback: onHeaderWidthsChange, widths: {...previous.widths, ...widths}};
        onHeaderWidthsChange(widths);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const region of regions) { const content = headerContents.current[region.key]; if (content) observer.observe(content); }
    return () => observer.disconnect();
  }, [regions, summaryCounts, onHeaderWidthsChange]);
  return <>{regions.map(region => {
    const clip = clipFor(region.targetId);
    const extent = clip ? intersectFrameRects(region, clip) : region;
    if (!extent.width || !extent.height) return null;
    const title = `${labels[region.type]}区域 ${region.targetId}`;
    const counts = region.textCounts ?? { total: 0, agree: 0, reply: 0, disagree: 0 };
    const countTypes = [region.type, ...discussionTypes.filter(type => type !== region.type && (counts[type] ?? 0) > 0)];
    const accent = accents[region.type];
    const summaryCount = summaryCounts?.get(region.key) ?? 0;
    const summaryVisible = !hiddenSummaryKeys?.has(region.key);
    const style: CSSProperties = { position: 'absolute', left: region.x, top: region.y,
      width: region.width, height: region.height, boxSizing: 'border-box', borderRadius: 4,
      borderWidth: 1, borderStyle: 'solid', borderColor: `color-mix(in srgb, ${accent} 45%, var(--line-444))`,
      borderLeftWidth: 2, pointerEvents: 'none',
      ...(clip ? { clipPath: `inset(${Math.max(0,clip.y-region.y)}px ${Math.max(0,region.x+region.width-clip.x-clip.width)}px ${Math.max(0,region.y+region.height-clip.y-clip.height)}px ${Math.max(0,clip.x-region.x)}px)` } : {}),
    };
    const titleVisible = !clip || intersectFrameRects({...region,height:region.headerHeight},clip).height > 0;
    const footerVisible = !clip || intersectFrameRects({...region,y:region.y+region.height-DISCUSSION_REGION_FOOTER,height:DISCUSSION_REGION_FOOTER},clip).height > 0;
    return <div key={region.key} data-discussion-region={region.key} data-discussion-collapsed={String(region.collapsed)}
      data-discussion-header-height={region.headerHeight} data-discussion-region-type={region.type}
      data-discussion-text-total={counts.total} data-discussion-text-agree={counts.agree}
      data-discussion-text-reply={counts.reply} data-discussion-text-disagree={counts.disagree}
      data-discussion-text-recommend={counts.recommend ?? 0} data-discussion-text-archive={counts.archive ?? 0}
      data-discussion-summary-visible={summaryCount ? String(summaryVisible) : undefined}
      role="group" aria-label={title} style={style}>
      <button type="button" data-discussion-group={region.key} data-discussion-branch-type={region.type}
        data-rel-overlay="true" aria-expanded={!region.collapsed}
        aria-label={`${region.collapsed ? '展开' : '收起'}${labels[region.type]}分支 ${region.targetId}`}
        title={`${title}；区域内共${counts.total}条文本；${countTypes.map(type => `${labels[type]}${counts[type] ?? 0}`).join('/')}。${region.collapsed ? '展开区域内的消息及分支' : '收起区域内的消息及全部后续分支，仅保留标题和数量'}。`}
        onClick={event => { event.stopPropagation(); onToggle(region.key); }}
        onDoubleClick={stop} onMouseDown={stop} onMouseUp={stop} onPointerDown={stop} onKeyDown={stop}
        style={{ position: 'absolute', left: -1, top: -1, width: region.width, minWidth: 'max-content', height: region.headerHeight,
          zIndex: 2, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 7,
          padding: summaryCount ? '0 7px 0 34px' : '0 7px', borderWidth: 1, borderStyle: 'solid', borderColor: `color-mix(in srgb, ${accent} 55%, var(--line-444))`,
          borderRadius: 3, background: 'var(--surface-141414)', overflow: 'hidden', whiteSpace: 'nowrap',
          color: 'var(--ink-eee)', fontSize: 12, lineHeight: 1, textAlign: 'left', cursor: 'pointer',
          pointerEvents: 'auto', visibility: titleVisible ? undefined : 'hidden' }}>
        <span data-discussion-header-content={region.key} ref={element => { headerContents.current[region.key] = element; }}
          style={{display:'inline-flex',alignItems:'center',gap:7,width:'max-content',flexShrink:0}}>
        <span aria-hidden="true" style={{color:accent}}>{region.collapsed ? '▸' : '▾'}</span>
        {countTypes.map((type, index) => <span key={type} data-discussion-text-type={type} data-discussion-text-count={counts[type]}>
          {index > 0 ? ' · ' : ''}{labels[type]} {counts[type] ?? 0} 条
        </span>)}
        </span>
      </button>
      {summaryCount > 0 && onToggleSummary && <button type="button" data-discussion-summary-toggle={region.key}
        data-rel-overlay="true" aria-pressed={summaryVisible}
        aria-label={`${summaryVisible ? '隐藏' : '显示'}${labels[region.type]}汇总关系 ${region.targetId}`}
        title={`${summaryVisible ? '隐藏' : '显示'}汇总${labels[region.type]}消息和连线（${summaryCount}条关系）；原关系可在关联消息中选择和查看`}
        onClick={event => { event.stopPropagation(); onToggleSummary(region.key); }}
        onDoubleClick={stop} onMouseDown={stop} onMouseUp={stop} onPointerDown={stop} onKeyDown={stop}
        style={{ position: 'absolute', left: 4, top: 2, width: 22, height: region.headerHeight - 6,
          zIndex: 3, padding: 0, border: '1px solid var(--line-444)', borderRadius: 3,
          background: 'var(--surface-141414)', color: summaryVisible ? accent : 'var(--ink-94a3b8)',
          fontSize: 11, lineHeight: 1, cursor: 'pointer', pointerEvents: 'auto',
          visibility: titleVisible ? undefined : 'hidden' }}>汇</button>}
      {!region.collapsed && region.height > region.headerHeight && <button type="button" data-discussion-footer={region.key}
        data-rel-overlay="true" aria-expanded="true"
        aria-label={`从底部收起${labels[region.type]}分支 ${region.targetId}`}
        title={`收起${labels[region.type]}汇总并跳转到目标消息 ${region.targetId}`}
        onClick={event => { event.stopPropagation(); onToggle(region.key); }}
        onDoubleClick={stop} onMouseDown={stop} onMouseUp={stop} onPointerDown={stop} onKeyDown={stop}
        style={{ position: 'absolute', left: -1, top: region.height-DISCUSSION_REGION_FOOTER-1,
          width: region.width, height: DISCUSSION_REGION_FOOTER, zIndex: 2, boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '0 7px', borderWidth: 1, borderStyle: 'solid', borderColor: `color-mix(in srgb, ${accent} 55%, var(--line-444))`,
          borderRadius: 3, background: 'var(--surface-141414)', color: 'var(--ink-eee)',
          fontSize: 12, lineHeight: 1, cursor: 'pointer', pointerEvents: 'auto',
          visibility: footerVisible ? undefined : 'hidden' }}>
        <span aria-hidden="true" style={{color:accent}}>▴</span>收起{labels[region.type]}汇总
      </button>}
    </div>;
  })}</>;
}
