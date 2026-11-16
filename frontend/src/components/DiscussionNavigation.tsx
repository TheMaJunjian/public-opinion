import type { ClassificationPathEntry } from '@gonglun/core';
import './DiscussionNavigation.css';

export default function DiscussionNavigation({ recommended, personal, onCategory, onRelated }: {
  recommended: ClassificationPathEntry[]; personal: ClassificationPathEntry[];
  onCategory(id: string): void; onRelated(): void;
}) {
  const differs = recommended.map(part => part.id).join('/') !== personal.map(part => part.id).join('/');
  const path = (parts: ClassificationPathEntry[]) => <>
    <span>根目录</span>{parts.map((part, index) => <span key={`${part.id}:${index}`}> / {part.id
      ? <button type="button" onClick={() => onCategory(part.id)} title={part.title}>{part.title}</button> : part.title}</span>)}
  </>;
  const parent = (differs ? personal : recommended).at(-1);
  return <section aria-label="讨论分类路径" className="discussion-navigation">
    <details open={recommended.length <= 3 && personal.length <= 3}>
      <summary>分类路径{recommended.length > 3 || personal.length > 3 ? ` · ${parent?.title ?? '根目录'}` : ''}</summary>
      <nav aria-label="统计推荐分类">推荐分类：{path(recommended)}</nav>
      {differs && <nav aria-label="个人显示分类">你的显示：{path(personal)}<small>个人选择与推荐分类不同，关注范围按推荐分类计算。</small></nav>}
    </details>
    <div className="discussion-navigation-actions">
      {parent?.id && <button type="button" onClick={() => onCategory(parent.id)}>查看所属分类</button>}
      {differs && recommended.at(-1)?.id && <button type="button" onClick={() => onCategory(recommended.at(-1)!.id)}>查看推荐分类</button>}
      <button type="button" onClick={onRelated}>展开相关内容</button>
    </div>
  </section>;
}
