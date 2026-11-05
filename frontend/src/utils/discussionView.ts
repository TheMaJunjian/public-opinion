import { isDiscussionType } from './discussionTypes';
/** Visual discussion settings never alter messages, relations or reading state. */
export interface DiscussionView {
  mode: 'graph' | 'discussion';
  collapsed: readonly string[];
}

export function isDiscussionView(value: unknown): value is DiscussionView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.mode === 'graph' || candidate.mode === 'discussion')
    && Array.isArray(candidate.collapsed) && candidate.collapsed.every(key => {
      if (typeof key !== 'string') return false;
      try {
        const parts: unknown = JSON.parse(key);
        return Array.isArray(parts) && parts.length === 2 && typeof parts[0] === 'string' && parts[0].length > 0
          && typeof parts[1] === 'string' && isDiscussionType(parts[1]) && JSON.stringify(parts) === key;
      } catch { return false; }
    });
}

export function copyDiscussionView(value: DiscussionView): { mode: DiscussionView['mode']; collapsed: string[] } {
  return { mode: value.mode, collapsed: [...new Set(value.collapsed)] };
}
