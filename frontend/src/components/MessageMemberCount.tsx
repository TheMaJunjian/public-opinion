import type { ComponentProps } from 'react';
import ThemeIcon from '../theme/ThemeIcon';

/** Derived membership statistics are descriptive, never an addressable message part. */
export default function MessageMemberCount({ total, direct, showEnterHint = false, ...props }: Omit<ComponentProps<'span'>, 'children'> & {
  total?: number;
  direct?: number;
  showEnterHint?: boolean;
}) {
  const description = total === undefined ? '成员统计尚未就绪'
    : `${direct === undefined ? '' : `直接成员 ${direct} 条，`}含内部容器共 ${total} 条消息，已按消息编号去重`;
  return <><span {...props} data-message-member-count="true" title={description} aria-label={description}>
    <ThemeIcon name="message" fallback="💬" /> {total ?? '—'} 条消息
  </span>{showEnterHint&&<span data-message-entry-hint="true" style={{marginLeft:'auto',fontSize:11,opacity:0.8,whiteSpace:'nowrap'}}>双击进入</span>}</>;
}
