import type { DemoMessage, DemoEdge } from '../../../utils/modelBridge';
import { projectGraphScene } from '../../../utils/graphProjection';
import { layoutDiscussion } from '../../../utils/discussionLayout';

type Side = { messages: DemoMessage[]; edges: DemoEdge[]; widths?: Record<string, number> };
/** Compare semantic display inputs, never measured pixel coordinates. */
export function comparisonChanges(agree: Side, disagree: Side) {
  const index = (side: Side) => {
    const scene=projectGraphScene({...side,isTraceWindow:false,traceExpandedFrameIds:new Set(),discussionTargetIds:new Set(side.messages.map(message=>message.id))});
    const layout=layoutDiscussion(scene.normals.map(message=>({id:message.id,width:1,height:1,time:Date.parse(message.createdAt)||0,sequence:message.sequence})),scene.layoutEdges,
      {relationCatalog:new Map(side.messages.map(message=>[message.id,message]))});
    const ranks=new Map<string,string>(),counts=new Map<string,number>();
    for(const id of layout.order){
      const group=JSON.stringify([layout.parent.get(id),layout.parentTypes.get(id)]),rank=counts.get(group)??0;
      counts.set(group,rank+1);ranks.set(id,JSON.stringify([group,rank]));
    }
    const parents = new Map<string, string[]>();
    for (const edge of side.edges) if (['classify','summary','merge','arrange'].includes(edge.relationType)) {
      const list = parents.get(edge.to.messageId) ?? []; list.push(edge.relationMessageId); parents.set(edge.to.messageId,list);
    }
    return new Map(side.messages.map(message => {
      const ancestors = new Set<string>(), pending = [...parents.get(message.id) ?? []];
      while (pending.length) { const id = pending.pop()!; if (ancestors.has(id)) continue; ancestors.add(id); pending.push(...parents.get(id) ?? []); }
      const connections = side.edges.filter(edge => edge.relationMessageId === message.id || edge.from.messageId === message.id || edge.to.messageId === message.id)
        .map(edge => JSON.stringify([edge.relationType,edge.relationMessageId,edge.from,edge.to])).sort();
      return [message.id, { message, body: message.content, width: side.widths?.[message.id],
        order:ranks.get(message.id),location: JSON.stringify([...ancestors].sort()), connections: JSON.stringify(connections) }];
    }));
  };
  const left = index(agree), right = index(disagree);
  return [...new Set([...left.keys(), ...right.keys()])].flatMap(id => {
    const a = left.get(id), b = right.get(id), reasons: string[] = [];
    if (!a || !b) reasons.push('显示范围');
    else {
      if (a.body !== b.body) reasons.push('正文');
      if (a.width !== b.width) reasons.push('宽度');
      if (a.location !== b.location) reasons.push('归属');
      if (a.order !== b.order) reasons.push('顺序或区域');
      if (a.connections !== b.connections) reasons.push('关系或排列');
    }
    return reasons.length ? [{ id, reasons, message: (a ?? b)!.message }] : [];
  });
}
