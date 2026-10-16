import { expect, it } from 'vitest';
import { deriveGraphMessagesToRender } from '../pages/workbench/projections/graphMessagesToRender';
import type { DemoMessage } from '../utils/modelBridge';

it('renders a root projection containing a classified settlement card without crashing',()=>{
  const message:DemoMessage={id:'owned-round',kind:'round',content:'结算卡片',author:'tester',createdAt:'2026-01-01T00:00:00Z'};
  const input={traceEntries:[],messagesToShow:[message],messages:[message],edgesToShow:[],edges:[],traceContainerMemberships:[],effectiveSuppressedRelIdsForLayout:new Set<string>(),traceDistance:1,traceExpandedFrameIds:new Set<string>(),isInsideClassify:false,currentClassifyRelMsgId:null,relationById:new Map(),relations:[],rejectedContainerIds:new Set<string>(),rejectedJoinRelationIds:new Set<string>(),msgMap:new Map([[message.id,message]]),activeClassifyOwnership:{textIds:new Set<string>(),relationIds:new Set<string>()},classifiedTargetSummaryRelMsgIds:new Set<string>(),listExclusiveRelMsgIds:new Set<string>(),replacedRelationMsgIds:new Set<string>(),classifiedTargetTextIds:new Set<string>(),graphOwnedRelationIds:new Set([message.id]),traceRelationMsgIds:new Set<string>(),classifiedTargetClassifyRelMsgIds:new Set<string>(),classifiedTargetMergeRelMsgIds:new Set<string>(),classifiedTargetARRANGERelMsgIds:new Set<string>(),activeSummaryOwnership:{textIds:new Set<string>(),relationIds:new Set<string>()},graphExclusiveRelMsgIds:new Set<string>(),graphHiddenTextIds:new Set<string>()};
  const result=deriveGraphMessagesToRender(input);
  expect(result.listMessagesToRender).toEqual([]);
  expect(result.graphMessagesToRender).toEqual([]);
});
