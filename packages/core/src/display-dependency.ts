import type { Message, Reference } from './types.js';

/** Display attachment is separate from explicit organization membership. */
export const DISPLAY_DEPENDENCY_ROLES: Readonly<Record<string, 'source' | 'target' | 'parent'>> = {
  annotation:'source', reference:'source', reply:'source', notify:'source',
  correct:'target', amend:'target', agree:'target', disagree:'target', tag:'target',
  recommend:'target', archive:'target', 'low-quality':'target', attention:'target', follow:'target',
  unfollow:'target', block:'target', unblock:'target', read:'target', unread:'target',
  join:'parent', 'member-of':'parent',
};
export function displayDependencyRole(relation: string): 'source' | 'target' | 'parent' | null {
  const name = relation.toLowerCase();
  return Object.hasOwn(DISPLAY_DEPENDENCY_ROLES, name) ? DISPLAY_DEPENDENCY_ROLES[name]! : null;
}

/** Generated self stances and placement hints do not make ordinary content dependent. */
export function messageDisplayDependency(message: Pick<Message, 'id' | 'parts'>): Reference[] | null {
  const display = message.parts.find(part => part.type === 'display' && part.target);
  if (display?.type === 'display' && display.target) return [display.target];
  const primary = message.parts.find(part => part.type === 'relation'
    && !(part.relation === 'member-of' && !part.roles.member?.length)
    && !((part.id === 'self-stance' || part.id.startsWith('minimum-self-stance-'))
      && ['agree', 'disagree'].includes(part.relation) && part.roles.target?.length === 1
      && part.roles.target[0]!.reference.messageId === message.id));
  if (primary?.type !== 'relation') return null;
  const role = displayDependencyRole(primary.relation);
  return role ? (primary.roles[role] ?? []).map(binding => binding.reference) : null;
}
