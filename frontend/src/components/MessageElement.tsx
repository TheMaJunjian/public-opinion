import type { ComponentProps, ReactNode } from 'react';
import type { Reference } from '@gonglun/core';
import { selectMessageElement } from '../utils/messageElementSelection';

/** Makes an existing visible label/reference selectable, without adding an inspector. */
export default function MessageElement({ reference, label, children, selected = false, ...props }: Omit<ComponentProps<'span'>, 'onClick' | 'onKeyDown'> & {
  reference?: Reference;
  label: string;
  children: ReactNode;
  selected?: boolean;
}) {
  const style = { ...props.style,
    ...(props.style?.fontWeight ? { fontWeight: 'var(--badge-weight)' } : {}),
    ...(typeof props.style?.fontSize === 'number' ? { fontSize: `max(var(--badge-min-size), ${props.style.fontSize}px)` } : {}),
  };
  if (!reference) return <span {...props} style={style}>{children}</span>;
  return <span {...props}
    data-message-reference={JSON.stringify(reference)}
    data-message-badge={!!props.style?.background || undefined}
    data-gesture-disabled="true"
    role="button"
    tabIndex={0}
    aria-label={`选择${label}`}
    aria-pressed={selected}
    style={{ ...style, ...(selected ? { background: 'var(--surface-fbbf24)', color: 'var(--ink-111827)', outline: '2px solid var(--line-fbbf24)' } : {}) }}
    title={props.title ?? `单击选择${label}`}
    onClick={event => { event.stopPropagation(); selectMessageElement(reference, label); }}
    onDoubleClick={props.onDoubleClick}
    onKeyDown={event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation(); selectMessageElement(reference, label);
    }}
  >{children}</span>;
}
