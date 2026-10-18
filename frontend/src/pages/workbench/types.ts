import type { UnitSelection } from '../../utils/modelBridge';

export type ViewMode = "list" | "graph";

export type TraceSnapshot = {
  /** Restore the local scope history captured with this viewport, using cached records. */
  restoreScope?: () => void;
  viewMode: ViewMode;
  leftScroll: { top: number; left: number } | null;
  pageScroll: { top: number; left: number } | null;
  rightScroll: { top: number; left: number } | null;
  draftUnits: UnitSelection[];
  sourceUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  activeTextSelectId: string | null;
  lastClickedMessageId: string | null;
  traceDistance: number;
};

export type ClassifyStackEntry = { relMsgId: string; snapshot: TraceSnapshot | null };

export type TraceEntry = {
  ids: string[];
  snapshot: TraceSnapshot | null;
  mode: "trace" | "scope";
  relatedView?: boolean;
  scopeRelationMessageId?: string;
  classifyRelMsgId: string | null;
  classifyStack: ClassifyStackEntry[];
};

export type DraftGroup = { messageId: string; wholeSelected: boolean; wholeUnits: UnitSelection[]; fragments: UnitSelection[] };
