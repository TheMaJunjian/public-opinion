import type { AnchorHTMLAttributes } from 'react';
import { aboutDocumentUrl } from '../utils/aboutNavigation';

/** Keep a normal public URL for new tabs and copying, and open in place on a plain click. */
export default function AboutLink({ children, href, onClick, onPointerEnter, onFocus, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const destination = href ?? '/about.html';
  const documentUrl = () => {
    try { return aboutDocumentUrl(new URL(destination, window.location.href)); }
    catch { return null; }
  };
  const prepare = () => { if (documentUrl()) window.dispatchEvent(new Event('prepare-about-viewer')); };
  return <a {...props} href={destination}
    onPointerEnter={event => { onPointerEnter?.(event); prepare(); }}
    onFocus={event => { onFocus?.(event); prepare(); }}
    onClick={event => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
        || (props.target && props.target !== '_self') || props.download !== undefined) return;
      const url = documentUrl();
      if (!url) return;
      event.preventDefault();
      window.dispatchEvent(href === undefined ? new Event('open-about-viewer')
        : new CustomEvent('open-about-viewer', { detail: { url } }));
    }}>{children}</a>;
}
