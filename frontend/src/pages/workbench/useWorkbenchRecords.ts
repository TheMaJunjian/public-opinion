import { useMemo, useReducer, useRef, type Dispatch, type SetStateAction } from 'react';
import type { WorkbenchSnapshot } from '@gonglun/core';
import type { ScopeView, User, Relation } from '../../types';
import type { DemoMessage, DemoEdge } from '../../utils/modelBridge';
import type { projectWorkbenchSnapshot } from '../../utils/workbenchProjection';

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

/** A synchronization installs one coherent projection; optimistic rollback cannot undo a newer snapshot. */
export function useWorkbenchRecords() {
  const [state, dispatch] = useReducer(reducer, initial);
  const current = useRef(state); current.current = state;
  const generation = useRef(0);
  const actions = useMemo(() => {
    const field = <K extends keyof Records>(key: K): Dispatch<SetStateAction<Records[K]>> => value =>
      dispatch({ type: 'edit', apply: previous => ({ ...previous, [key]: typeof value === 'function'
        ? (value as (old: Records[K]) => Records[K])(previous[key]) : value }) });
    return {
      setMessages: field('messages'), setEdges: field('edges'), setRelations: field('relations'),
      setStakeCounts: field('stakeCounts'), setMessageBettorCounts: field('messageBettorCounts'), setAuthorStakes: field('authorStakes'),
      replace(snapshot: Pick<WorkbenchSnapshot, 'scope' | 'users' | 'attentionUsers' | 'tagCounts'>, projected: Projection) {
        generation.current++;
        const next: Records = { scope: snapshot.scope, messages: projected.messages, edges: projected.edges,
          relations: projected.relations, registeredUsers: snapshot.users,
          attentionUsersByTarget: { ...snapshot.attentionUsers }, tagCounts: { ...snapshot.tagCounts },
          stakeCounts: projected.counts, messageBettorCounts: projected.bettors, authorStakes: projected.authorAmounts };
        current.current = next;
        dispatch({ type: 'replace', state: next });
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
  return { ...state, ...actions };
}
