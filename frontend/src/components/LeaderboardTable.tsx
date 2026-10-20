import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export interface LeaderboardColumn {
  label: string;
  width: number;
}

interface Props {
  columns: readonly LeaderboardColumn[];
  widths: number[];
  onResize: (index: number, width: number) => void;
  stickyTop?: number | string;
  children: ReactNode;
}

const MIN_WIDTH = 48;
const MAX_WIDTH = 1200;

export default function LeaderboardTable({ columns, widths, onResize, stickyTop = 0, children }: Props) {
  const tableRef = useRef<HTMLTableElement>(null);
  const columnRefs = useRef<(HTMLTableColElement | null)[]>([]);
  const dragRef = useRef<{
    index: number; x: number; width: number; latest: number; tableWidth: number;
    autoDialog: HTMLElement | null; dialogWidth: number; dialogWidthStyle: string;
    dialogMargin: string; frozenMargin: string; previewed: boolean;
  } | null>(null);
  useLayoutEffect(() => () => {
    const drag = dragRef.current;
    if (drag?.autoDialog) {
      drag.autoDialog.style.width = drag.dialogWidthStyle;
      drag.autoDialog.style.margin = drag.dialogMargin;
    }
  }, []);
  const resize = (index: number, width: number) => onResize(index, Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)));
  const finishResize = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.autoDialog) drag.autoDialog.style.margin = drag.dialogMargin;
    if (drag && drag.latest !== drag.width) onResize(drag.index, drag.latest);
  };

  return (
    <table ref={tableRef} style={{ width: widths.reduce((total, width) => total + width, 0), tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, overflowWrap: 'anywhere' }}>
      <colgroup>
        {columns.map((column, index) => <col key={column.label} ref={element => { columnRefs.current[index] = element; }} style={{ width: widths[index] }} />)}
      </colgroup>
      <thead>
        <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
          {columns.map((column, index) => (
            <th key={column.label} scope="col" aria-label={column.label} title={column.label} style={{ position: 'sticky', top: stickyTop, zIndex: 1, padding: '6px 12px 6px 8px', borderBottom: '1px solid #243041', background: '#101216', verticalAlign: 'top' }}>
              {column.label}
              <span
                role="separator"
                aria-label={`调整${column.label === '#' ? '排名' : column.label}列宽`}
                aria-orientation="vertical"
                aria-valuemin={MIN_WIDTH}
                aria-valuemax={MAX_WIDTH}
                aria-valuenow={widths[index]}
                tabIndex={0}
                title="拖动调整列宽，双击恢复；也可用左右方向键调整"
                style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: 8, borderRight: '1px solid #334155', cursor: 'col-resize', touchAction: 'none', userSelect: 'none' }}
                onPointerDown={event => {
                  if (event.button !== 0 || event.isPrimary === false) return;
                  event.preventDefault();
                  const dialog = tableRef.current?.closest<HTMLElement>('[role="dialog"]');
                  const autoDialog = dialog?.dataset.leaderboardSizing === 'auto' ? dialog : null;
                  const bounds = autoDialog?.getBoundingClientRect();
                  const stage = autoDialog?.parentElement;
                  const stageBounds = stage?.getBoundingClientRect();
                  const stageStyle = stage ? getComputedStyle(stage) : null;
                  dragRef.current = {
                    index, x: event.clientX, width: widths[index], latest: widths[index],
                    tableWidth: widths.reduce((total, width) => total + width, 0), autoDialog,
                    dialogWidth: autoDialog ? parseFloat(autoDialog.style.width) || autoDialog.offsetWidth : 0,
                    dialogWidthStyle: autoDialog?.style.width ?? '', dialogMargin: autoDialog?.style.margin ?? '',
                    frozenMargin: bounds && stageBounds && stageStyle
                      ? `${Math.max(0, bounds.top - stageBounds.top - parseFloat(stageStyle.paddingTop))}px 0 0 ${Math.max(0, bounds.left - stageBounds.left - parseFloat(stageStyle.paddingLeft))}px` : 'auto',
                    previewed: false,
                  };
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={event => {
                  const drag = dragRef.current;
                  const table = tableRef.current;
                  const column = columnRefs.current[index];
                  if (drag?.index !== index || !table || !column) return;
                  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, drag.width + event.clientX - drag.x));
                  if (width === drag.latest) return;
                  if (!drag.previewed && drag.autoDialog) drag.autoDialog.style.margin = drag.frozenMargin;
                  drag.previewed = true;
                  drag.latest = width;
                  // Resize the existing column locally; save and update the data table on release.
                  column.style.width = `${width}px`;
                  table.style.width = `${drag.tableWidth + width - drag.width}px`;
                  event.currentTarget.setAttribute('aria-valuenow', String(width));
                  if (drag.autoDialog) drag.autoDialog.style.width = `${Math.max(480, drag.dialogWidth + width - drag.width)}px`;
                }}
                onPointerUp={event => {
                  finishResize();
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={finishResize}
                onLostPointerCapture={finishResize}
                onDoubleClick={() => resize(index, column.width)}
                onKeyDown={event => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
                  event.preventDefault();
                  resize(index, event.key === 'Home' ? column.width : widths[index] + (event.key === 'ArrowLeft' ? -16 : 16));
                }}
              />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
