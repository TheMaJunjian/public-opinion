import type { MessageView, TargetRef, WorkbenchSnapshot } from '@gonglun/core';

const mergeRefs = (previous: TargetRef[] = [], current: TargetRef[] = []) => [...new Map([...previous, ...current].map(ref => [
  JSON.stringify(ref.reference ?? (ref.kind === 'relation' ? [ref.kind, ref.relationId, ref.part] : [ref.kind, ref.messageId])), ref,
])).values()];

/** Edges are projected per batch, including context-only references. Keep each
 * freshly validated edge even when another page supplies only its source body. */
function mergeViews<T extends Pick<MessageView, 'id' | 'revision' | 'targetRefs' | 'declaredTargetRefs' | 'restricted'> & {content?:string}>(groups: T[][]): T[] {
  const result = new Map<string, T>();
  for (const group of groups) for (const row of group) {
    const previous = result.get(row.id);
    result.set(row.id, previous && previous.revision === row.revision && !previous.restricted && !row.restricted
      && (previous.targetRefs || row.targetRefs) ? { ...row,
        // A context-only synthetic label may omit a remote target's quotation.
        content: (previous.targetRefs?.length ?? 0) > (row.targetRefs?.length ?? 0) ? previous.content : row.content,
        targetRefs: mergeRefs(previous.targetRefs, row.targetRefs),
        declaredTargetRefs: mergeRefs(previous.declaredTargetRefs, row.declaredTargetRefs),
      } : row);
  }
  return [...result.values()];
}

/** Only merge freshly revalidated batches from the same discussion and reader. */
export function mergeDiscussionSnapshots(pages: WorkbenchSnapshot[]): WorkbenchSnapshot & { discussion: NonNullable<WorkbenchSnapshot['discussion']> } {
  const ordered = [...pages].sort((a, b) => a.sequence - b.sequence), latest = ordered.at(-1)!;
  const messages = mergeViews(ordered.map(page => page.messages)), byId = new Map(messages.map(row => [row.id, row]));
  return { ...latest,
    messages, relations: mergeViews(ordered.map(page => page.relations)).filter(row => {
      const message = byId.get(row.id);
      return !message?.restricted && (!message || message.revision === row.revision && !!message.relationType);
    }),
    users: [...new Map(ordered.flatMap(page => page.users).map(user => [user.id, user])).values()],
    stakes: Object.assign({}, ...ordered.map(page => page.stakes)),
    tagCounts: Object.assign({}, ...ordered.map(page => page.tagCounts)),
    attentionUsers: Object.assign({}, ...ordered.map(page => page.attentionUsers)),
    discussion: { ...pages[0]!.discussion!,
      pageIds: [...new Set(pages.flatMap(page => page.discussion!.pageIds))],
      ...(pages.some(page=>page.discussion!.expandedIds) ? {
        expandedIds: [...new Set(ordered.flatMap(page=>(page.discussion!.expandedIds ?? page.messages.map(row=>row.id))
          .filter(id=>page.messages.find(row=>row.id===id)?.revision === byId.get(id)?.revision)))],
      } : {}),
      nextCursor: pages.at(-1)!.discussion!.nextCursor,
      memberCounts: Object.assign({}, ...ordered.map(page => page.discussion!.memberCounts)),
    },
  };
}
