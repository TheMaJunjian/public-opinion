import type { Dispatch, MutableRefObject, Ref, RefObject, SetStateAction } from 'react';
import { Z_INDEX } from '../../../constants/zIndex';
import { relationTypeName } from '../../../utils/graphTextSelection';
import type { RelationType } from '../../../utils/modelBridge';
import { ALL_RELATION_TYPES } from '../model/relationComposition';
import { useThemeSettings } from '../../../theme/theme';
import { ThemeLabel } from '../../../theme/ThemeIcon';
import AboutLink from '../../../components/AboutLink';
import MessageJumpControl from '../../../components/MessageJumpControl';

interface ComposerMode {
  relationType: RelationType | null; secondaryRelationType: string; newMessageContent: string; subType: string | null;
  setRelationType: Dispatch<SetStateAction<RelationType | null>>; setSecondaryRelationType: Dispatch<SetStateAction<string>>;
  setNewMessageContent: Dispatch<SetStateAction<string>>;
  lastTagSecondaryRef: MutableRefObject<string>; lastDelegationSecondaryRef: MutableRefObject<'create' | 'fulfill'>;
  savedTextOnTypeSwitchRef: MutableRefObject<string>; subTypeCustomBufferRef: MutableRefObject<string>;
  guideTargetIdRef: MutableRefObject<string | null>;
}
export type LocalRelationType = 'reply' | 'agree' | 'disagree' | 'classify' | 'summary' | 'merge' | 'arrange' | 'correct';
const LOCAL_RELATION_TYPES: readonly RelationType[] = ['reply', 'agree', 'disagree', 'classify', 'summary', 'merge', 'arrange', 'correct'];
export interface LocalRelationMode {
  relationType: LocalRelationType | null;
  onChange: (type: LocalRelationType | null) => void;
  disabled?: boolean;
}
interface Props {
  barRef: Ref<HTMLDivElement>; leftControlsRef: RefObject<HTMLDivElement>; rightControlsRef: RefObject<HTMLDivElement>;
  top: number; springWidth: number; rightOffset: number; viewer: boolean;
  knownIds: ReadonlySet<string>; onJump: (id: string) => void;
  composer: ComposerMode;
  localMode?: LocalRelationMode;
}
export default function RelationToolbar({ barRef: relationBarRef, leftControlsRef: relationLeftControlsRef, rightControlsRef: relationRightControlsRef,
  top, springWidth: relationSpringWidth, rightOffset: relationControlsRightOffset, viewer: isPreloaded, knownIds, onJump, composer, localMode }: Props) {
  const {layout}=useThemeSettings();
  const showJump=layout.messageJump==='toolbar';
  const showRelations=(!isPreloaded||Boolean(localMode))&&layout.relationControls==='toolbar';
  if(!showJump&&!showRelations)return null;

  return (
    <div ref={relationBarRef} className="workbench-relation-toolbar" style={{ padding: "8px 16px", borderBottom: "1px solid var(--line-333)", background: "var(--surface-181818)", display: "flex", flexWrap: "wrap", rowGap: 8, alignItems: "center", fontSize: 14, flexShrink: 0, position: "sticky", top, zIndex: Z_INDEX.popover }}>
      {showJump&&<div ref={relationLeftControlsRef} className="workbench-jump-controls" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <MessageJumpControl knownIds={knownIds} onJump={onJump}/>
      </div>}
      <div aria-hidden="true" style={{ flex: "1 1 0", width: relationSpringWidth, minWidth: 0 }} />
      {showRelations && (
        <div ref={relationRightControlsRef} className="workbench-relation-types" style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", marginLeft: "auto", gap: 6, fontSize: 12, flex: "0 1 auto", maxWidth: "100%", minWidth: 0, paddingLeft: 8, background: "var(--surface-181818)", position: "sticky", right: `${relationControlsRightOffset}px`, zIndex: Z_INDEX.header }}>
          <RelationChoices composer={composer} localMode={localMode} />
        </div>
      )}
    </div>


  );
}


const RELATION_GROUPS = [
  { label: '讨论', types: ['annotation', 'reference', 'reply', 'notify'] },
  { label: '表态', types: ['agree', 'disagree', 'tag'] },
  { label: '组织', types: ['arrange', 'classify', 'merge', 'summary'] },
  { label: '修订', types: ['correct'] },
  { label: '治理', types: ['proposal', 'delegation', 'code_change', 'operations'] },
] as const;

/** Both layouts use the original type-switching action and preserve the composition draft. */
export function RelationChoices({ composer, placement = 'toolbar', localMode }: { composer: ComposerMode; placement?: 'toolbar' | 'desk'; localMode?: LocalRelationMode }) {
  const {layout} = useThemeSettings();
  if (placement !== layout.relationControls) return null;
  const { secondaryRelationType, newMessageContent, setRelationType, setSecondaryRelationType, setNewMessageContent, lastTagSecondaryRef, lastDelegationSecondaryRef, savedTextOnTypeSwitchRef, guideTargetIdRef } = composer;
  const relationType = localMode ? localMode.relationType : composer.relationType;
  const allowedTypes = (types: readonly RelationType[]) => localMode ? types.filter(type => LOCAL_RELATION_TYPES.includes(type)) : types;
  const renderTypes = (types: readonly RelationType[]) => <>
          {allowedTypes(types).map(rt => (
            <button key={rt} disabled={localMode?.disabled} aria-pressed={relationType === rt} onClick={() => {
              if (localMode) {
                if (LOCAL_RELATION_TYPES.includes(rt)) localMode.onChange(relationType === rt ? null : rt as LocalRelationType);
                return;
              }
              if (relationType === "tag") { lastTagSecondaryRef.current = secondaryRelationType !== "none" ? secondaryRelationType : "recommend"; }
              const isDeselecting = relationType === rt;
              const newType = isDeselecting ? null : rt;
              // Preserve the merge draft separately; annotations accept body text.
              const isTextLessType = (t: string | null) => t === "merge";
              const wasTextLess = isTextLessType(relationType);
              const willBeTextLess = isTextLessType(newType);
              // Save and clear when switching TO a text-less type
              if (!wasTextLess && willBeTextLess && newMessageContent.trim()) {
                savedTextOnTypeSwitchRef.current = newMessageContent;
                setNewMessageContent("");
              }
              // Restore when switching FROM a text-less type
              if (wasTextLess && !willBeTextLess && savedTextOnTypeSwitchRef.current) {
                setNewMessageContent(savedTextOnTypeSwitchRef.current);
              }
              setRelationType(prev => prev === rt ? null : rt);
              if (newType === "tag") { setSecondaryRelationType(lastTagSecondaryRef.current || "recommend"); }
              else if (newType === "delegation") { setSecondaryRelationType(lastDelegationSecondaryRef.current); }
              else if (newType === "correct") { setSecondaryRelationType('text-correction'); }
              else { setSecondaryRelationType(newType === "arrange" ? "vertical" : "none"); }
              if (guideTargetIdRef.current && (rt === 'agree' || rt === 'disagree')) {
                window.dispatchEvent(new Event('guide-stance-selected'));
              }
            }}
              data-guide-stance-type={rt === 'agree' || rt === 'disagree' ? 'true' : undefined}
              style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--line-666)", background: relationType === rt ? "var(--surface-0b84ff)" : "var(--surface-222)", color: relationType === rt ? "var(--ink-fff)" : "var(--ink-rgba-255-255-255-0-7)", cursor: "pointer" }}>
              <ThemeLabel text={relationTypeName(rt)} />
            </button>
          ))}
  </>;
  if (placement === 'toolbar') return <><span>关系类型<AboutLink href="/about.html#guide-relations" className="workbench-help-link" aria-label="关系类型帮助" title="关系类型帮助">?</AboutLink></span>{renderTypes(ALL_RELATION_TYPES)}</>;
  return <section className="desk-relations" aria-label="关系类型">
    <div className="desk-section-title"><span className="desk-section-number">03</span>关系类型<AboutLink href="/about.html#guide-relations" className="workbench-help-link" aria-label="关系类型帮助" title="关系类型帮助">?</AboutLink></div>
    {RELATION_GROUPS.filter(group => allowedTypes(group.types).length > 0).map(group => <div className="desk-relation-group" key={group.label}>
      <span>{group.label}</span><div>{renderTypes(group.types)}</div>
    </div>)}
  </section>;
}
