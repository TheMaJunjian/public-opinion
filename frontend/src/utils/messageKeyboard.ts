import type { KeyboardEvent } from 'react';

/** A focused card follows the same selection/opening path as its pointer surface. */
export function activateMessageFromKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (event.target !== event.currentTarget || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.dispatchEvent(new MouseEvent(event.key === 'Enter' && event.shiftKey ? 'dblclick' : 'click', {
    bubbles: true, cancelable: true, detail: event.shiftKey ? 2 : 0,
  }));
}
