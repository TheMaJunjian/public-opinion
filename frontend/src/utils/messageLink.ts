/** Change the workbench destination without losing other filters or a file:// hash route. */
export function categoryMessageUrl(address: string, messageId: string | null): string {
  const url = new URL(address);
  const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), 'https://gonglun.invalid') : url;
  if (messageId) route.searchParams.set('msg', messageId);
  else route.searchParams.delete('msg');
  route.searchParams.delete('locate');
  if (route !== url) url.hash = `${route.pathname}${route.search}${route.hash}`;
  return url.href;
}
