import type {DemoEdge,DemoMessage} from './modelBridge';

type Node=Pick<DemoMessage,'id'|'createdAt'>&{sequence?:number};
const priority:Record<string,number>={reply:0,annotation:1,reference:2,notify:3,agree:4,disagree:4};
export const chronologicalOrder=(a:Node,b:Node)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0)||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id);

/** A stable placement forest. Secondary connections never merge or reorder branches. */
export function discussionForest(nodes:Node[],edges:DemoEdge[],catalog:ReadonlyMap<string,DemoMessage>=new Map()){
  const byId=new Map(nodes.map(node=>[node.id,node])),parent=new Map<string,string>();
  const candidates=edges.filter(edge=>priority[edge.relationType]!==undefined&&edge.from.messageId!==edge.to.messageId
    &&byId.has(edge.from.messageId)&&byId.has(edge.to.messageId)).sort((a,b)=>
      priority[a.relationType]-priority[b.relationType]
      ||chronologicalOrder(catalog.get(a.relationMessageId)??{id:a.relationMessageId,createdAt:''},catalog.get(b.relationMessageId)??{id:b.relationMessageId,createdAt:''})
      ||a.to.messageId.localeCompare(b.to.messageId));
  for(const edge of candidates)if(!parent.has(edge.from.messageId))parent.set(edge.from.messageId,edge.to.messageId);
  // Functional-graph cycles are broken only for placement; the real edges remain intact.
  const finished=new Set<string>();
  for(const node of nodes){
    if(finished.has(node.id))continue;
    const path:string[]=[],positions=new Map<string,number>();let id:string|undefined=node.id;
    while(id&&!finished.has(id)&&!positions.has(id)){positions.set(id,path.length);path.push(id);id=parent.get(id);}
    if(id&&positions.has(id)){
      const cycle=path.slice(positions.get(id)!).sort((a,b)=>chronologicalOrder(byId.get(a)!,byId.get(b)!));parent.delete(cycle[0]);
    }
    path.forEach(id=>finished.add(id));
  }
  const children=new Map<string,Node[]>(),roots:Node[]=[];
  for(const node of nodes){const owner=parent.get(node.id);if(!owner)roots.push(node);else{
    const values=children.get(owner)??[];values.push(node);children.set(owner,values);
  }}
  roots.sort(chronologicalOrder);children.forEach(values=>values.sort(chronologicalOrder));
  const groups:string[][]=[];
  for(const root of roots){
    const group:string[]=[],stack=[root.id];
    while(stack.length){const id=stack.pop()!;group.push(id);const values=children.get(id)??[];for(let i=values.length-1;i>=0;i--)stack.push(values[i].id);}
    groups.push(group);
  }
  const breadthOrder=roots.map(root=>root.id);
  for(let index=0;index<breadthOrder.length;index++)for(const child of children.get(breadthOrder[index])??[])breadthOrder.push(child.id);
  return {parent,groups,order:groups.flat(),breadthOrder};
}
