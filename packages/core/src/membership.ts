/** An immutable placement, including the placement it replaced. Root has no parent. */
export interface MembershipAction {
  id: string;
  memberId: string;
  parentId: string;
  previousId: string | null;
  previousParentId: string | null;
  order: number;
  sourcePartId?: string;
  bindingId?: string;
  sourceRevision?: number;
}

/** Shared by the server index and client previews. One winning action per member. */
export function resolveMemberships(actions: MembershipAction[], rejected: ReadonlySet<string>, retiredParents: ReadonlySet<string> = new Set()) {
  const byId = new Map(actions.map(action => [action.id, action]));
  const latest = new Map<string, MembershipAction>();
  for (const action of actions) {
    const before = latest.get(action.memberId);
    if (!before || action.order > before.order || action.order === before.order && action.id > before.id)
      latest.set(action.memberId, action);
  }
  const excluded = new Set(rejected);
  for (;;) {
    const effective = new Map<string, MembershipAction>();
    for (const [memberId, head] of latest) {
      let action: MembershipAction | undefined = head;
      const seen = new Set<string>();
      while (action && !seen.has(action.id)) {
        seen.add(action.id);
        // Removing a legacy boundary maps this placement to root. It is a
        // terminal checkpoint, not permission to restore an earlier container.
        if (retiredParents.has(action.parentId) || retiredParents.has(memberId)) break;
        if (!excluded.has(action.id) && !excluded.has(action.parentId)) {
          effective.set(memberId, action); break;
        }
        const previous: MembershipAction | undefined = action.previousId ? byId.get(action.previousId) : undefined;
        // A parent ID alone is not an effective JOIN. Never invent a placement
        // when a bounded client page has not loaded its predecessor yet.
        action = previous?.memberId === memberId ? previous : undefined;
      }
    }
    // Restoring an older placement can form a cycle with a later independent move.
    let cycle: string[] | undefined;
    const finished = new Set<string>();
    for (const start of latest.keys()) {
      const path: string[] = [], positions = new Map<string, number>();
      let id: string | undefined = start;
      while (id && !finished.has(id)) {
        const position = positions.get(id);
        if (position !== undefined) { cycle = path.slice(position); break; }
        positions.set(id, path.length); path.push(id); id = effective.get(id)?.parentId;
      }
      if (cycle) break;
      path.forEach(id => finished.add(id));
    }
    if (!cycle) return { effective, trackedMembers: new Set(latest.keys()) };
    const newest = cycle.map(id => effective.get(id)).filter((action): action is MembershipAction => !!action)
      .sort((a, b) => b.order - a.order || b.id.localeCompare(a.id))[0]!;
    excluded.add(newest.id);
  }
}
