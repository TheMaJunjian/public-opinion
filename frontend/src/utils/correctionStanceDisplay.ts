import type {CorrectionVersion,DemoEdge,DemoMessage} from './modelBridge';
import type {MessageStakeCounts} from '../components/MessageSettlementActions';
/** Display variants address one message. Historical contracts remain individually inspectable. */
export function deriveCorrectionStanceDisplay(_messages:DemoMessage[],_edges:DemoEdge[],_versions:Map<string,{current?:CorrectionVersion;versions:CorrectionVersion[]}>,stakeCounts:Record<string,MessageStakeCounts>,_authorStakes:Record<string,number>={}){
  void _authorStakes;
  return {counts:stakeCounts,excludedEdges:new Set<string>()};
}
