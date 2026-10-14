/** Routes identify actual messages; the whole workspace has no synthetic message. */
export function messageScopePath(messageId?: string | null): string {
  return messageId && messageId !== 'root' ? `/messages/${encodeURIComponent(messageId)}` : '/messages';
}
