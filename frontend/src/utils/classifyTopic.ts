/** Extract classify topic title from relation message content with a safe fallback. */
export function extractClassifyTopicTitle(content: string | undefined, fallbackTargetCount: number): string {
  if (!content) return `分类话题（${fallbackTargetCount}）`;
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return `分类话题（${fallbackTargetCount}）`;
  const stripped = firstLine.replace(/^(话题|分类话题|建立分类话题|建立分类关系（无来源消息）)[:：]?\s*/u, '').trim();
  return stripped || `分类话题（${fallbackTargetCount}）`;
}
