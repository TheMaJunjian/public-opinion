import { buildStanceTargetMap, resolveDisplayedStance, type CorrectionVersion, type DemoEdge, type DemoMessage } from './modelBridge';
import type { MessageStakeCounts } from '../components/MessageSettlementActions';

type CorrectionEntry = {current?:CorrectionVersion;versions:CorrectionVersion[]};
type Versions = Map<string,CorrectionEntry>;
export function meaningCorrectionIds(entry:CorrectionEntry|undefined):string[] {
  const applied=new Set(entry?.current?.appliedCorrectionIds??(entry?.current?[entry.current.correctionId]:[]));
  return entry?.versions.filter(version=>version.correctionKind==='MEANING'&&applied.has(version.correctionId)).map(version=>version.correctionId).sort()??[];
}

/** A view projection only: text fixes share votes; meaning edits retain the stance's original context. */
export function deriveCorrectionStanceDisplay(messages:DemoMessage[],edges:DemoEdge[],versions:Versions,
  stakeCounts:Record<string,MessageStakeCounts>,authorStakes:Record<string,number>={}) {
  const map=new Map(messages.map(message=>[message.id,message])),stanceMap=buildStanceTargetMap(edges,map);
  const groups=new Map([...versions].filter(([,entry])=>entry.versions.some(version=>version.correctionKind==='MEANING'))
    .map(([id,entry])=>[id,meaningCorrectionIds(entry).join('\n')]));
  const counts={...stakeCounts},excludedEdges=new Set<string>();
  for(const [id,key] of groups)counts[id]=key?{truth:{pro:0,con:0},value:{...stakeCounts[id]?.value??{pro:0,con:0}}}:{
    truth:{...stakeCounts[id]?.truth??{pro:0,con:0}},value:{...stakeCounts[id]?.value??{pro:0,con:0}},
  };
  const directEdges=new Map(edges.filter(edge=>['agree','disagree'].includes(edge.relationType)).map(edge=>[edge.relationMessageId,edge]));
  function basis(edge:DemoEdge,targetId:string):string {
    const seen=new Set<string>();
    while(!seen.has(edge.relationMessageId)){
      seen.add(edge.relationMessageId);
      const saved=map.get(edge.relationMessageId)?.relationPayload?.stanceCorrections?.[targetId];
      if(Array.isArray(saved)&&saved.every(id=>typeof id==='string'))return [...saved].sort().join('\n');
      if(edge.to.messageId===targetId)break;
      const parent=directEdges.get(edge.to.messageId);if(!parent)break;edge=parent;
    }
    // Historical stances share the original and every text-only correction.
    return '';
  }
  for(const edge of edges){
    if(!['agree','disagree'].includes(edge.relationType))continue;
    const resolved=resolveDisplayedStance(edge,map,stanceMap),targetId=resolved?.targetId??edge.to.messageId,key=groups.get(targetId);
    if(key===undefined)continue;
    const from=basis(edge,targetId),matches=from===key;
    if(!matches)excludedEdges.add(edge.id);
    const amount=map.get(edge.relationMessageId)?.spending?.wager??authorStakes[edge.relationMessageId]??0;
    const side=(resolved?.type??edge.relationType)==='agree'?'pro':'con';
    if(key&&matches)counts[targetId].truth[side]+=amount;
    else if(!key&&from)counts[targetId].truth[side]=Math.max(0,counts[targetId].truth[side]-amount);
  }
  return {counts,excludedEdges};
}
