/** Routes identify actual messages; the whole workspace has no synthetic message. */
export function messageScopePath(messageId?: string | null): string {
  return messageId && messageId !== 'root' ? `/messages/${encodeURIComponent(messageId)}` : '/messages';
}

/** Change the data source without losing the linked message, category or view options. */
export function fullWorkbenchPath(location: { pathname: string; search: string; hash?: string }, focusId?: string): string {
  const params = new URLSearchParams(location.search);
  params.set('catalog', 'full');
  // A category route can separately link a member through ?msg=. Its snapshot
  // focus is the category, so keep the more specific message destination.
  if (focusId && !(location.pathname === messageScopePath(focusId) && params.get('msg')?.trim())) params.set('msg', focusId);
  return `${location.pathname}?${params}${location.hash ?? ''}`;
}
