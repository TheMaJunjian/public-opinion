import { useEffect, useMemo, useReducer, useRef, type Dispatch, type SetStateAction } from 'react';
import type { RelationType, UnitSelection } from '../../utils/modelBridge';

export interface ComposerState {
  draftUnits: UnitSelection[]; sourceUnits: UnitSelection[]; targetUnits: UnitSelection[];
  activeTextSelectId: string | null; relationType: RelationType | null;
  secondaryRelationType: string; subType: string; subTypeCustomLabel: string;
  relationLabel: string; newMessageContent: string;
  stakeAmount: number | ''; relStakeAmount: number | ''; recommendationAmount: number | '';
}
export interface ComposerCheckpoint {
  state: ComposerState;
  textOnTypeSwitch: string; customText: string; textBeforeDelegation: string;
  delegationContent: Record<'create' | 'fulfill', string>;
}
const initialState: ComposerState = {
  draftUnits: [], sourceUnits: [], targetUnits: [], activeTextSelectId: null, relationType: null,
  secondaryRelationType: 'none', subType: '', subTypeCustomLabel: '', relationLabel: '', newMessageContent: '',
  stakeAmount: 0, relStakeAmount: 0, recommendationAmount: 0,
};
type Action = { type: 'restore'; state: ComposerState } | { type: 'update'; apply(state: ComposerState): ComposerState };
const reducer = (state: ComposerState, action: Action) => action.type === 'restore' ? action.state : action.apply(state);

/** Owns the draft, selections and mode buffers, including atomic recovery after a rejected send. */
export function useWorkbenchComposer() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state); stateRef.current = state;
  const subTypeCustomBufferRef = useRef('');
  const savedTextOnTypeSwitchRef = useRef('');
  const savedTextBeforeDelegationRef = useRef('');
  const lastTagSecondaryRef = useRef('recommend');
  const lastDelegationSecondaryRef = useRef<'create' | 'fulfill'>('create');
  const delegationContentBufferRef = useRef<Record<'create' | 'fulfill', string>>({ create: '', fulfill: '' });
  const previousComposerModeRef = useRef('plain::none');
  const setters = useMemo(() => {
    const field = <K extends keyof ComposerState>(key: K): Dispatch<SetStateAction<ComposerState[K]>> => value =>
      dispatch({ type: 'update', apply: current => ({ ...current, [key]: typeof value === 'function'
        ? (value as (previous: ComposerState[K]) => ComposerState[K])(current[key]) : value }) });
    return {
      setDraftUnits: field('draftUnits'), setSourceUnits: field('sourceUnits'), setTargetUnits: field('targetUnits'),
      setActiveTextSelectId: field('activeTextSelectId'), setRelationType: field('relationType'),
      setSecondaryRelationType: field('secondaryRelationType'), setSubType: field('subType'),
      setSubTypeCustomLabel: field('subTypeCustomLabel'), setRelationLabel: field('relationLabel'),
      setNewMessageContent: field('newMessageContent'), setStakeAmount: field('stakeAmount'),
      setRelStakeAmount: field('relStakeAmount'), setRecommendationAmount: field('recommendationAmount'),
    };
  }, []);
  const recovery = useMemo(() => ({
    capture(): ComposerCheckpoint {
      return { state: stateRef.current, textOnTypeSwitch: savedTextOnTypeSwitchRef.current,
        customText: subTypeCustomBufferRef.current, textBeforeDelegation: savedTextBeforeDelegationRef.current,
        delegationContent: { ...delegationContentBufferRef.current } };
    },
    restore(checkpoint: ComposerCheckpoint) {
      savedTextOnTypeSwitchRef.current = checkpoint.textOnTypeSwitch;
      subTypeCustomBufferRef.current = checkpoint.customText;
      savedTextBeforeDelegationRef.current = checkpoint.textBeforeDelegation;
      delegationContentBufferRef.current = { ...checkpoint.delegationContent };
      previousComposerModeRef.current = `${checkpoint.state.relationType ?? 'plain'}::${checkpoint.state.secondaryRelationType}`;
      dispatch({ type: 'restore', state: checkpoint.state });
    },
  }), []);
  const { relationType, secondaryRelationType } = state;
  useEffect(() => {
    const mode = `${relationType ?? 'plain'}::${secondaryRelationType}`;
    const previousMode = previousComposerModeRef.current;
    if (mode === previousMode) return;
    const content = stateRef.current.newMessageContent;
    const wasDelegation = previousMode.startsWith('delegation::');
    if (relationType === 'proposal') {
      if (secondaryRelationType === '终止结算' || secondaryRelationType === '分配收入') setters.setNewMessageContent('');
      else if (secondaryRelationType === '充值分账') setters.setNewMessageContent('充值总额=1000\n收入池分成=100\n指定与会者=user-id');
      else if (secondaryRelationType === '运营收入注入') setters.setNewMessageContent('收入金额=1000\n来源=服务收入');
    }
    if (relationType === 'delegation' && !wasDelegation) savedTextBeforeDelegationRef.current = content;
    if (wasDelegation) {
      const previousKind = previousMode.slice('delegation::'.length);
      if (previousKind === 'create' || previousKind === 'fulfill') delegationContentBufferRef.current[previousKind] = content;
    }
    if (relationType === 'delegation') {
      if (secondaryRelationType === 'create' || secondaryRelationType === 'fulfill') {
        lastDelegationSecondaryRef.current = secondaryRelationType;
        setters.setNewMessageContent(delegationContentBufferRef.current[secondaryRelationType]
          || (secondaryRelationType === 'create' ? '报酬数量=100\n委托内容=' : '完成说明='));
      } else setters.setSecondaryRelationType(lastDelegationSecondaryRef.current);
    } else if (wasDelegation) setters.setNewMessageContent(savedTextBeforeDelegationRef.current);
    previousComposerModeRef.current = mode;
  }, [relationType, secondaryRelationType, setters]);
  return { ...state, ...setters, ...recovery, subTypeCustomBufferRef, savedTextOnTypeSwitchRef,
    savedTextBeforeDelegationRef, lastTagSecondaryRef, lastDelegationSecondaryRef, delegationContentBufferRef };
}
export type WorkbenchComposer = ReturnType<typeof useWorkbenchComposer>;
