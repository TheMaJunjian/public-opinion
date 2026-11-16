import { resolveMemberships, type MembershipAction } from './membership.js';

export interface MembershipSupport {
  id: string; support: number; createdAt: string; sequence: number; order: number;
}

/** The public default is shared by discovery and the workbench; personal choices remain separate. */
export function compareMembershipSupport(a: MembershipSupport, b: MembershipSupport): number {
  return b.support - a.support || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
    || b.sequence - a.sequence || b.order - a.order || b.id.localeCompare(a.id);
}

export const rejectsMembership = (pro: number, con: number, latest?: 'agree' | 'disagree') =>
  con > pro || con === pro && latest === 'disagree';

export function resolveRecommendedMemberships(candidates: Array<MembershipSupport & { memberId: string; parentId: string }>, excluded: ReadonlySet<string>) {
  const byMember = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    if (excluded.has(candidate.id) || excluded.has(candidate.parentId)) continue;
    const list = byMember.get(candidate.memberId) ?? [];
    list.push(candidate); byMember.set(candidate.memberId, list);
  }
  const actions: MembershipAction[] = [], sources = new Map<string, string>();
  for (const [memberId, list] of byMember) {
    list.sort(compareMembershipSupport);
    let previousId: string | null = null, previousParentId: string | null = null;
    for (let index = list.length - 1; index >= 0; index--) {
      const candidate = list[index]!, id = `display:${memberId}:${list.length - index - 1}`;
      actions.push({ id, memberId, parentId: candidate.parentId, previousId, previousParentId, order: -index - 1 });
      sources.set(id, candidate.id); previousId = id; previousParentId = candidate.parentId;
    }
  }
  return new Map([...resolveMemberships(actions, new Set()).effective].map(([id, action]) =>
    [id, { memberId: id, parentId: action.parentId, sourceId: sources.get(action.id)! }]));
}
