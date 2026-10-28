import type {DemoMessage,DemoEdge} from '../utils/modelBridge';
export const discussionMessages:DemoMessage[]=['A','B','C','D','E','F','N','P','Q'].map((id,index)=>({id,kind:'normal',author:'reader',content:id,createdAt:new Date(Date.UTC(2026,9,27,9,index)).toISOString()}));
const link=(source:string,target:string,type:'reply'|'reference'='reply'):DemoEdge=>({id:`${source}-${target}`,relationMessageId:`${source}-${target}`,relationType:type,relationLabel:type,
  from:{messageId:source,selection:{kind:'whole'}},to:{messageId:target,selection:{kind:'whole'}}});
export const discussionEdges=[link('B','A'),link('C','A'),link('D','B'),link('E','C'),link('F','B'),link('N','D','reference'),link('N','E','reference'),link('P','N'),link('Q','P')];
