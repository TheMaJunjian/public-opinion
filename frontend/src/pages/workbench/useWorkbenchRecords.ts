import { useMemo, useReducer, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { projectWorkbenchSnapshot } from '../../utils/workbenchProjection';
import type { WorkbenchSnapshot } from '@gonglun/core';
import type { ScopeView, User, Relation } from '../../types';
import type { DemoMessage, DemoEdge } from '../../utils/modelBridge';

type Projection = ReturnType<typeof projectWorkbenchSnapshot>;
interface Records {
  scope: ScopeView | null; messages: DemoMessage[]; edges: DemoEdge[]; relations: Relation[];
  tagCounts: WorkbenchSnapshot['tagCounts']; attentionUsersByTarget: WorkbenchSnapshot['attentionUsers'];
  stakeCounts: Projection['counts']; messageBettorCounts: Projection['bettors'];
  authorStakes: Projection['authorAmounts']; registeredUsers: User[];
}
const initial: Records = { scope: null, messages: [], edges: [], relations: [], tagCounts: {},
  attentionUsersByTarget: {}, stakeCounts: {}, messageBettorCounts: {}, authorStakes: {}, registeredUsers: [] };
type Action = { type: 'replace'; state: Records } | { type: 'edit'; apply(state: Records): Records };
const reducer = (state: Records, action: Action) => action.type === 'replace' ? action.state : action.apply(state);

function applyPreviewPages(base: Records, pages: WorkbenchSnapshot[]): Records {
  let state = base;
  for (const page of pages) {
    const projected = projectWorkbenchSnapshot(page);
    const changed = new Set([...page.messages.map(message => message.id), ...(page.removedMessageIds ?? [])]);
    const relationIds = new Set([...page.relations.map(relation => relation.id), ...changed]);
    state = { ...state,
      messages: [...state.messages.filter(message => !changed.has(message.id)), ...projected.messages],
      relations: [...state.relations.filter(relation => !relationIds.has(relation.id)), ...projected.relations],
      edges: [...state.edges.filter(edge => !relationIds.has(edge.relationMessageId)), ...projected.edges],
      stakeCounts: { ...state.stakeCounts, ...projected.counts },
      messageBettorCounts: { ...state.messageBettorCounts, ...projected.bettors },
      authorStakes: { ...state.authorStakes, ...projected.authorAmounts },
      tagCounts: { ...state.tagCounts, ...page.tagCounts }, attentionUsersByTarget: { ...state.attentionUsersByTarget, ...page.attentionUsers },
    };
  }
  return state;
}

/** A synchronization installs one coherent projection; optimistic rollback cannot undo a newer snapshot. */
export function useWorkbenchRecords() {
  const [state, dispatch] = useReducer(reducer, initial);
  const current = useRef(state); current.current = state;
  const liveSequence = useRef(0);
  const transient = useRef<Records | null>(null);
  const [preview, setPreview] = useState<Records | null>(null);
  const generation = useRef(0);
  const actions = useMemo(() => {
    const field = <K extends keyof Records>(key: K): Dispatch<SetStateAction<Records[K]>> => value =>
      { const apply = (previous: Records): Records => ({ ...previous, [key]: typeof value === 'function'
        ? (value as (old: Records[K]) => Records[K])(previous[key]) : value });
        if (transient.current) transient.current = apply(transient.current);
        else dispatch({ type: 'edit', apply }); };
    return {
      setMessages: field('messages'), setEdges: field('edges'), setRelations: field('relations'),
      setStakeCounts: field('stakeCounts'), setMessageBettorCounts: field('messageBettorCounts'), setAuthorStakes: field('authorStakes'),
      replace(snapshot: Pick<WorkbenchSnapshot, 'scope' | 'users' | 'attentionUsers' | 'tagCounts'> & { sequence?: number }, projected: Projection) {
        liveSequence.current = snapshot.sequence ?? liveSequence.current;
        generation.current++;
        const next: Records = { scope: snapshot.scope, messages: projected.messages, edges: projected.edges,
          relations: projected.relations, registeredUsers: snapshot.users,
          attentionUsersByTarget: { ...snapshot.attentionUsers }, tagCounts: { ...snapshot.tagCounts },
          stakeCounts: projected.counts, messageBettorCounts: projected.bettors, authorStakes: projected.authorAmounts };
        current.current = next;
        dispatch({ type: 'replace', state: next });
      },
      async captureTransient(work: () => Promise<unknown>) {
        transient.current = current.current;
        try { await work(); } finally { transient.current = null; }
      },
      showSendPreview(pages: WorkbenchSnapshot[]) {
        setPreview(applyPreviewPages(current.current, pages));
      },
      clearSendPreview() { setPreview(null); },
      confirmSendPreview(pages: WorkbenchSnapshot[]) {
        generation.current++;
        // Synchronization can finish before the confirmation response arrives.
        // Its newer authoritative state must survive promotion of the preview.
        const accepted = pages.filter(page => page.sequence >= liveSequence.current)
          .sort((left, right) => left.sequence - right.sequence);
        const next = applyPreviewPages(current.current, accepted);
        liveSequence.current = Math.max(liveSequence.current, ...pages.map(page => page.sequence));
        current.current = next; dispatch({ type: 'replace', state: next }); setPreview(null);
      },
      captureOptimisticRollback() {
        const previous = current.current, version = generation.current;
        return () => {
          if (generation.current !== version) return;
          dispatch({ type: 'replace', state: previous });
        };
      },
    };
  }, []);
  return { ...(preview ?? state), liveMessages:state.messages, liveRelations:state.relations, liveSequence: liveSequence.current, ...actions };
}
