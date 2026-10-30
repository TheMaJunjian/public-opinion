import type { UnitSelection } from '../../utils/modelBridge';
import type {DisplayHintWindowSnapshot} from './model/displayHintWindow';
import type {TraceDirection} from '../../utils/traceRange';
import type {MessageFilterSettings} from '../../components/MessageFilterPanel';
import type {ReadingOrder} from './model/readingTasks';

export type ViewMode = "list" | "graph";

export type TraceSnapshot = {
  graphFrameViewState?: import('../../utils/frameViewports').GraphFrameViewState;
  displayHintWindow?:DisplayHintWindowSnapshot;
  /** Restore the local scope history captured with this viewport, using cached records. */
  restoreScope?: () => void;
  viewMode: ViewMode;
  leftScroll: { top: number; left: number } | null;
  pageScroll: { top: number; left: number } | null;
  rightScroll: { top: number; left: number } | null;
  traceDistance: number;
  traceDepths?: import('../../utils/traceRange').TraceDepths;
  traceDirection?: TraceDirection;
  readingOrder?: ReadingOrder;
  readingFocusId?:string|null;
  readingMessageIds?:string[];
  readingAnchorId?:string|null;
  readingViewportAnchor?:{messageId:string;top:number;left:number}|null;
  messageFilter?:MessageFilterSettings;
  overlayView?:boolean;
  modeScroll?:Record<ViewMode,{top:number;left:number}|null>;
};

export type ClassifyStackEntry = {
  relMsgId: string; snapshot: TraceSnapshot | null;
  /** A temporary category contains only messages present in the expanded frame. */
  frameScopeIds?: string[];
  frameKnownIds?: string[];
};

export type TraceEntry = {
  readingContext?: import('./model/readingTasks').ReadingTask[];
  ids: string[];
  snapshot: TraceSnapshot | null;
  mode: "trace" | "scope";
  relatedView?: boolean;
  scopeRelationMessageId?: string;
  classifyRelMsgId: string | null;
  classifyStack: ClassifyStackEntry[];
};

export type DraftGroup = { messageId: string; wholeSelected: boolean; wholeUnits: UnitSelection[]; fragments: UnitSelection[] };
