import {describe,it,expect} from 'vitest';
import {discussionMessages as messages,discussionEdges as edges} from './discussion-fixture';
import {discussionForest} from '../utils/discussionOrder';
import {traceRange,type TraceDirection} from '../utils/traceRange';
import {computeSceneLayout} from '../utils/frameLayout';

describe('discussion structure and directed scope',()=>{
  it('limits the two directions independently without zigzagging into another branch',()=>{
    expect(traceRange(messages,edges,['B'],{up:1,down:2}).ids).toEqual(new Set(['B','A','D','F','N']));
    expect(traceRange(messages,edges,['B'],{up:0,down:1}).ids).toEqual(new Set(['B','D','F']));
    expect(traceRange(messages,edges,['B'],{up:1,down:0}).ids).toEqual(new Set(['B','A']));
    expect(traceRange(messages,edges,['B'],{up:0,down:0}).ids).toEqual(new Set(['B']));
  });
  it.each(['up','down','both'] as const)('never spends %s distance on shared membership or a multi-target JOIN',direction=>{
    const group={...messages[0],id:'group',kind:'relation' as const,relationType:'classify' as const};
    const join={...messages[0],id:'join',kind:'join' as const,relationType:undefined};
    const nodes=[...messages,group,join],links=[...edges,
      ...['B','Q'].map(target=>({...edges[0],id:'group-'+target,relationMessageId:'group',relationType:'classify' as const,from:{...edges[0].from,messageId:'anon:group'},to:{...edges[0].to,messageId:target}})),
      ...['B','Q'].map(target=>({...edges[0],id:'join-'+target,relationMessageId:'join',relationType:'reference' as const,from:{...edges[0].from,messageId:'anon:join'},to:{...edges[0].to,messageId:target}}))];
    for(const distance of [0,1,2])expect(traceRange(nodes,links,['B'],distance,direction).ids).toEqual(traceRange(messages,edges,['B'],distance,direction).ids);
    expect(traceRange(nodes,links,['group'],20,direction).ids).toEqual(new Set(['group']));
  });
  it('does not change an old reply lane when a later citation opens a new column',()=>{
    const ids=['root','first-reference','old-reply','later-reference','new-citation'];
    const nodes=ids.map((id,index)=>({...messages[0],id,author:index===0?'other':'same-author',createdAt:new Date(index*1000).toISOString()}));
    const link=(source:string,target:string,type:'reply'|'reference')=>({...edges[0],id:source+target,relationMessageId:source+target,relationType:type,
      from:{...edges[0].from,messageId:source},to:{...edges[0].to,messageId:target}});
    const original=[link(ids[1],ids[0],'reference'),link(ids[2],ids[1],'reply'),link(ids[3],ids[0],'reference')];
    const run=(texts:typeof nodes,links:typeof original)=>computeSceneLayout({normals:texts,allMessages:texts,edges:links,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    const before=run(nodes.slice(0,-1),original),after=run(nodes,[...original,link(ids[4],ids[3],'reference'),link(ids[4],ids[0],'reference')]);
    for(const id of ids.slice(0,-1))expect(after.layout[id].x).toBe(before.layout[id].x);
  });
  it('uses publish sequence to break timestamp ties consistently with reading order',()=>{
    const nodes=['z-first','a-second'].map((id,index)=>({...messages[0],id,sequence:index+1}));
    const result=computeSceneLayout({normals:[...nodes].reverse(),allMessages:nodes,edges:[],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    expect(result.placementOrder).toEqual(discussionForest(nodes,[]).order);
    expect(result.placementOrder).toEqual(['z-first','a-second']);
  });
  it('does not import an unrelated author lane when a new citation bridges two discussions',()=>{
    const ids=['claim','first-reference','evidence','parallel-reference','isolated','old-reply','new-citation'];
    const nodes=ids.map((id,index)=>({...messages[0],id,author:index===0||index===2?'other':'same-author',createdAt:new Date(index*1000).toISOString()}));
    const link=(source:string,target:string,type:'reply'|'reference')=>({...edges[0],id:source+target,relationMessageId:source+target,relationType:type,
      from:{...edges[0].from,messageId:source},to:{...edges[0].to,messageId:target}});
    const original=[link(ids[1],ids[0],'reference'),link(ids[2],ids[1],'reference'),link(ids[3],ids[0],'reference'),link(ids[5],ids[1],'reply')];
    const run=(texts:typeof nodes,links:typeof original)=>computeSceneLayout({normals:texts,allMessages:texts,edges:links,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    const before=run(nodes.slice(0,-1),original),after=run(nodes,[...original,link(ids[6],ids[4],'reference'),link(ids[6],ids[1],'reference')]);
    for(const id of ids.slice(0,-1))expect(after.layout[id].x).toBe(before.layout[id].x);
  });
  it.each([['up',['A','B']],['down',['B','D','F','N']],['both',['A','B','C','D','F','N']]] as [TraceDirection,string[]][])('calculates %s without target shortcuts',(direction,expected)=>{
    expect([...traceRange(messages,edges,['B'],2,direction).ids].sort()).toEqual(expected.sort());
  });
  it('keeps discussion order independent of traversal direction and input order',()=>{
    const expected=['A','B','D','N','P','Q','F','C','E'];
    expect(discussionForest(messages,edges).order).toEqual(expected);
    expect(discussionForest([...messages].reverse(),[...edges].reverse()).order).toEqual(expected);
  });
  it('does not merge the two old reply threads when one new text cites both',()=>{
    const ids=['old','question','answer','reply-1','reply-2','citation'];
    const nodes=ids.map((id,index)=>({...messages[0],id,createdAt:new Date(index*1000).toISOString()}));
    const link=(source:string,target:string,type:'reply'|'reference')=>({...edges[0],id:source+target,relationMessageId:source+target,relationType:type,
      from:{...edges[0].from,messageId:source},to:{...edges[0].to,messageId:target}});
    const oldEdges=[link('answer','question','reply'),link('reply-1','old','reply'),link('reply-2','old','reply')];
    const run=(nodes:typeof messages,edges:typeof oldEdges)=>computeSceneLayout({normals:nodes,allMessages:nodes,edges,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    const before=run(nodes.slice(0,-1),oldEdges),after=run(nodes,[...oldEdges,link('citation','reply-2','reference'),link('citation','answer','reference')]);
    expect(after.layout['reply-1'].y).toBeLessThan(after.layout['reply-2'].y);
    expect(after.layout['reply-2'].y).toBeLessThan(after.layout.answer.y);
    for(const id of ids.slice(0,-1))expect(after.layout[id].y).toBe(before.layout[id].y);
  });
  it('breaks placement cycles without removing their real connections',()=>{
    const cycle=[...edges,{...edges[0],id:'cycle',relationMessageId:'cycle',from:{...edges[0].from,messageId:'A'},to:{...edges[0].to,messageId:'B'}}];
    const result=discussionForest(messages,cycle);
    expect(new Set(result.order).size).toBe(messages.length);
    expect(traceRange(messages,cycle,['B'],8,'both').ids.size).toBe(messages.length);
  });
  it('does not expand an ancestor container into unreached siblings',()=>{
    const group={...messages[0],id:'group',kind:'relation' as const,relationType:'arrange' as const};
    const member=(id:string)=>({...edges[0],id:'group-'+id,relationMessageId:'group',relationType:'arrange' as const,
      from:{...edges[0].from,messageId:'anon:group'},to:{...edges[0].to,messageId:id}});
    expect(traceRange([...messages,group],[...edges,member('D'),member('Q')],['D'],2,'both').ids.has('Q')).toBe(false);
  });
});
