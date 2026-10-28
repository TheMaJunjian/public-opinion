import type {DemoEdge,DemoMessage} from './modelBridge';
import {isCardMessage} from './modelBridge';
import {getPresentationSpec} from '../types';

/** Text accompanying an annotation occupies the same source lane as a citation. */
export function projectAnnotationLayoutEdges(messages:DemoMessage[],edges:DemoEdge[]):DemoEdge[]{
  const byId=new Map(messages.map(message=>[message.id,message]));
  return edges.map(edge=>{
    if(edge.relationType!=='annotation'&&!['inline-badge','decoration-label'].includes(getPresentationSpec(edge.relationType).kind))return edge;
    const source=edge.from.messageId.startsWith('anon:')?byId.get(edge.relationMessageId):byId.get(edge.from.messageId);
    if(!source||!isCardMessage(source))return edge;
    return {...edge,relationType:'reference',from:{...edge.from,messageId:source.id}};
  });
}
