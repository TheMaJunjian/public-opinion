import type { ZhihuViewingData, ZhihuQuestion } from './zhihuArchive';
import type { ReadingTextLinkHint } from '../components/ReadingTextLinks';

/** Lazily recover explicit anchor labels from the source, never from surrounding prose. */
export function createZhihuReadingLinks(data: ZhihuViewingData) {
  const { archive, byMessageId } = data.zhihu;
  const items = new Map(archive.items.map(item => [`${item.type}:${item.id}`, item]));
  const comments = new Map(archive.comments.flatMap(comment => [
    [`${comment.threadId}:${comment.sourceId || comment.id}`, comment] as const,
    [`${comment.threadId}:${comment.id}`, comment] as const,
  ]));
  const questions = new Map((archive.questions || []).filter(question => question.id).map(question => [question.id!, question] as const));
  const primaryIds = new Set(questions.keys());
  // Match the reader's question projection: primary records win; otherwise
  // later partial observations must not replace a complete embedded version.
  const questionRank = (question: ZhihuQuestion) => typeof question.text === 'string'
    ? question.completeness && typeof question.completeness === 'object'
      && !Array.isArray(question.completeness) && (question.completeness as Record<string, unknown>).body === 'complete' ? 2 : 1 : 0;
  for (const item of archive.items) if (item.question?.id) {
    const previous = questions.get(item.question.id);
    if (!previous || !primaryIds.has(item.question.id) && questionRank(item.question) > questionRank(previous)) questions.set(item.question.id, item.question);
  }
  const cache = new Map<string, readonly ReadingTextLinkHint[]>();
  return (messageId: string): readonly ReadingTextLinkHint[] => {
    const meta = byMessageId[messageId];
    const source = meta?.kind === 'item' ? items.get(meta.threadId)
      : meta?.kind === 'comment' ? comments.get(`${meta.threadId}:${meta.sourceId}`)
        : meta?.kind === 'question' ? questions.get(meta.sourceId) : undefined;
    const html = source?.html;
    if (typeof html !== 'string' || !html.includes('<')) return [];
    const saved = cache.get(html);
    if (saved) return saved;
    // Template contents stay inert and are never inserted into the document.
    // Only label text and literal href attributes are used; no source HTML is rendered.
    const template = document.createElement('template');
    template.innerHTML = html;
    const hints: ReadingTextLinkHint[] = [];
    for (const anchor of template.content.querySelectorAll('a[href]')) {
      const url = anchor.getAttribute('href') || '';
      const label = (anchor.textContent || '').replace(/\u00a0/g, ' ').trim();
      if (/^https?:\/\//i.test(url) && label && label !== url) hints.push({ label, url });
    }
    cache.set(html, hints);
    return hints;
  };
}
