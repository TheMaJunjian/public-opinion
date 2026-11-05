import type { Relation } from '../../../types';

type NavigationRelation = Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs'>
  & { payload?: Relation['payload'] & { sourceNavigation?: boolean }; state?: Relation['state'] };
const CONTAINERS = new Set(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE']);

/** Imported indexes may share originals; local organization remains scoped to its navigation branch. */
export function createSourceNavigationDeclarations(relations: readonly NavigationRelation[], winners: ReadonlyMap<string, string>) {
  const byId = new Map(relations.map(relation => [relation.id, relation]));
  const joined = new Set<string>();
  const parents = new Map<string, Set<string>>();
  const targetId = (ref: NavigationRelation['targetRefs'][number]) => ref.kind === 'relation' ? ref.relationId : ref.messageId;
  const addParent = (child: string, parent: string) => {
    if (!CONTAINERS.has(byId.get(child)?.relationType.toUpperCase() ?? '')) return;
    const values = parents.get(child) ?? new Set<string>();
    values.add(parent); parents.set(child, values);
  };
  for (const relation of relations) if (relation.relationType.toUpperCase() === 'JOIN') {
    for (const ref of relation.targetRefs) joined.add(targetId(ref));
  }
  for (const relation of relations) {
    if (!CONTAINERS.has(relation.relationType.toUpperCase()) || relation.state?.organizationRetired) continue;
    for (const ref of relation.targetRefs) {
      const child = targetId(ref), winner = byId.get(winners.get(child) ?? '');
      if (relation.payload?.sourceNavigation === true || !relation.payload?.independentMemberships
        && (!joined.has(child) || winner?.sourceMessageId === relation.id)) addParent(child, relation.id);
    }
  }
  for (const [child, joinId] of winners) {
    const parent = byId.get(joinId)?.sourceMessageId;
    if (parent) addParent(child, parent);
  }
  const within = new Map<string, boolean>();
  return (containerId: string, memberId: string): boolean => {
    if (byId.get(containerId)?.payload?.sourceNavigation !== true) return false;
    const winnerParent = byId.get(winners.get(memberId) ?? '')?.sourceMessageId;
    if (!winnerParent || winnerParent === containerId) return true;
    const key = JSON.stringify([containerId, winnerParent]);
    let descendant = within.get(key);
    if (descendant === undefined) {
      const pending = [winnerParent], seen = new Set<string>();
      descendant = false;
      while (pending.length) {
        const current = pending.pop()!;
        if (current === containerId) { descendant = true; break; }
        if (seen.has(current)) continue;
        seen.add(current);
        for (const parent of parents.get(current) ?? []) pending.push(parent);
      }
      within.set(key, descendant);
    }
    // A move within this scope replaces its direct appearance. Other source paths stay readable.
    return !descendant;
  };
}
