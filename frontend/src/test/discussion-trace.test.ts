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
  it.each((['classify','summary','merge'] as const).flatMap(type=>(['up','down','both'] as const).map(direction=>({type,direction}))))('never spends $direction distance on $type membership or a multi-target JOIN',({type,direction})=>{
    const group={...messages[0],id:'group',kind:'relation' as const,relationType:type};
    const join={...messages[0],id:'join',kind:'join' as const,relationType:undefined};
    const nodes=[...messages,group,join],links=[...edges,
      ...['B','Q'].map(target=>({...edges[0],id:'group-'+target,relationMessageId:'group',relationType:type,from:{...edges[0].from,messageId:'anon:group'},to:{...edges[0].to,messageId:target}})),
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
  it('reads the same discussion tree level by level in breadth-first order',()=>{
    const expected=['A','B','C','D','F','E','N','P','Q'];
    expect(discussionForest(messages,edges).breadthOrder).toEqual(expected);
    expect(discussionForest([...messages].reverse(),[...edges].reverse()).breadthOrder).toEqual(expected);
    const cycle=[...edges,{...edges[0],id:'cycle',relationMessageId:'cycle',from:{...edges[0].from,messageId:'A'},to:{...edges[0].to,messageId:'B'}}];
    const traversal=discussionForest(messages,cycle).breadthOrder;
    expect(new Set(traversal)).toEqual(new Set(messages.map(message=>message.id)));
    expect(traversal).toHaveLength(messages.length);
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
  it.each(['up','down','both'] as const)('counts arrangement peers as one hop while preserving %s reference direction',direction=>{
    const nodes=['member','peer','before','after','outsider'].map(id=>({...messages[0],id}));
    const group={...messages[0],id:'group',kind:'relation' as const,relationType:'arrange' as const};
    const member=(id:string)=>({...edges[0],id:'group-'+id,relationMessageId:'group',relationType:'arrange' as const,
      from:{...edges[0].from,messageId:'anon:group'},to:{...edges[0].to,messageId:id}});
    const reference=(from:string,to:string)=>({...edges[0],id:from+to,relationMessageId:from+to,relationType:'reference' as const,
      from:{...edges[0].from,messageId:from},to:{...edges[0].to,messageId:to}});
    const links=[member('member'),member('peer'),reference('peer','before'),reference('after','peer')];
    for(const budget of [0,2,1,0,1]){
      const range=traceRange([...nodes,group],links,['member'],budget,direction);
      expect(range.ids.has('peer')).toBe(budget>=1);
      if(budget>=1)expect(range.distances.get('peer')).toBe(1);
      expect(range.ids.has('before')).toBe(budget>=2&&direction!=='down');
      expect(range.ids.has('after')).toBe(budget>=2&&direction!=='up');
      expect(range.ids.has('outsider')).toBe(false);
    }
    expect(traceRange([...nodes,group],links,['member'],{up:1,down:0}).distances.get('peer')).toBe(1);
    expect(traceRange([...nodes,group],links,['member'],{up:0,down:1}).distances.get('peer')).toBe(1);
    expect(traceRange([...nodes,group],links,['member'],{up:0,down:0}).ids).toEqual(new Set(['member']));
  });
  it('includes legacy arrangement sources and spends another hop on nested arrangements',()=>{
    const nodes=['member','peer','leaf'].map(id=>({...messages[0],id}));
    const groups=['outer','inner'].map(id=>({...messages[0],id,kind:'relation' as const,relationType:'arrange' as const}));
    const link=(owner:string,source:string,target:string)=>({...edges[0],id:owner+target,relationMessageId:owner,relationType:'arrange' as const,
      from:{...edges[0].from,messageId:source},to:{...edges[0].to,messageId:target}});
    const links=[link('outer','member','peer'),link('outer','member','inner'),link('inner','anon:inner','leaf')];
    for(const starts of [['member'],['peer','member']]){
      const one=traceRange([...nodes,...groups],links,starts,1);
      expect(one.distances.get('peer')).toBe(starts.includes('peer')?0:1);expect(one.ids.has('leaf')).toBe(false);
      expect(traceRange([...nodes,...groups],links,starts,2).distances.get('leaf')).toBe(2);
    }
  });
});
