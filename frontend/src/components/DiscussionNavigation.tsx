import { useState } from 'react';
import type { ClassificationPathEntry } from '@gonglun/core';
import { dialogStyles } from './dialogStyles';
import './DiscussionNavigation.css';

export default function DiscussionNavigation({ recommended, personal, onCategory, onRelated }: {
  recommended: ClassificationPathEntry[]; personal: ClassificationPathEntry[];
  onCategory(id: string): void; onRelated(): void;
}) {
  const [openChoice, setOpenChoice] = useState<boolean | null>(null);
  const expanded = openChoice ?? (recommended.length <= 3 && personal.length <= 3);
  const differs = recommended.length !== personal.length || recommended.some((part, i) => part.id !== personal[i].id);
  const linkedIds = new Set<string>();
  const path = (parts: ClassificationPathEntry[]) => <>
    <span>根目录</span>{parts.map((part, index) => {
      const link = part.id && !linkedIds.has(part.id);
      linkedIds.add(part.id);
      return <span key={`${part.id}:${index}`}> / {link
        ? <button type="button" onClick={() => onCategory(part.id)} title={part.title}>{part.title}</button> : part.title}</span>;
    })}
  </>;
  const parent = personal.at(-1), recommendedParent = recommended.at(-1);
  return <section aria-label="讨论分类路径" className="discussion-navigation">
    <details open={expanded} onToggle={event => {
      if (event.currentTarget.open !== expanded) setOpenChoice(event.currentTarget.open);
    }}>
      <summary>
        分类路径{!expanded && ` · ${parent?.title ?? '根目录'}`}
      </summary>
      {expanded && <>
        <nav aria-label="统计推荐分类">推荐分类：{path(recommended)}</nav>
        {differs && <nav aria-label="个人显示分类">你的显示：{path(personal)}<small>个人选择与推荐分类不同，关注范围按推荐分类计算。</small></nav>}
      </>}
    </details>
    <div className="discussion-navigation-actions">
      {!expanded && parent?.id && <button type="button" style={dialogStyles.button} title={parent.title} onClick={() => onCategory(parent.id)}>查看所属分类</button>}
      {!expanded && recommendedParent?.id && recommendedParent.id !== parent?.id &&
        <button type="button" style={dialogStyles.button} title={recommendedParent.title} onClick={() => onCategory(recommendedParent.id)}>查看推荐分类</button>}
      <button type="button" style={dialogStyles.button} onClick={onRelated}>展开相关内容</button>
    </div>
  </section>;
}
