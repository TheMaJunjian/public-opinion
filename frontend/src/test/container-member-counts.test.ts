import { describe, expect, it, vi } from 'vitest';
import type { Relation, TargetRef } from '../types';
import { createContainerOwnership } from '../pages/workbench/model/ownership';

const messageRef = (messageId:string):TargetRef => ({kind:'message',messageId});
const relationRef = (relationId:string):TargetRef => ({kind:'relation',relationId});
const relation = (id:string, type:string, targets:TargetRef[] = [], source:string|null = null):Relation => ({
  id, relationType:type, sourceMessageId:source, targetRefs:targets,
  createdAt:'2026-01-01T00:00:00Z', createdBy:{id:'author',username:'author',createdAt:''},
});
const container = (id:string, members:string[] = [], type = 'CLASSIFY') => relation(id,type,members.map(messageRef));

describe('on-demand container member counts', () => {
  it('includes nested containers themselves and reports direct and recursive counts separately', () => {
    const ownership=createContainerOwnership([container('A',['one','two','B']),container('B',['three','four','five'])]);
    expect(ownership.memberCounts('A')).toEqual({direct:3,total:6});
    expect(ownership.memberCounts('B')).toEqual({direct:3,total:3});
    // Existing ownership consumers retain their previous text/relation separation.
    expect(ownership.owned('A')).toEqual({textIds:new Set(['one','two','three','four','five']),relationIds:new Set(['B'])});
  });

  it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE'])('recurses through %s membership', type => {
    const ownership=createContainerOwnership([container('root',['nested']),container('nested',['leaf'],type)]);
    expect(ownership.memberCounts('root')).toEqual({direct:1,total:2});
  });

  it('counts every member type but does not follow the targets of ordinary relations', () => {
    const root=relation('root','CLASSIFY',[
      messageRef('text'), messageRef('proposal'), messageRef('code'), messageRef('operations'),
      relationRef('agree'), relationRef('disagree'), relationRef('tag'), relationRef('reference'),
      relationRef('join'), messageRef('round'), messageRef('result'),
    ]);
    const relations=[root,...['agree','disagree','tag','reference'].map(id=>relation(id,id.toUpperCase(),[messageRef('external')])),
      relation('join','JOIN',[messageRef('elsewhere')],'other')];
    const ownership=createContainerOwnership(relations);
    expect(ownership.memberCounts('root')).toEqual({direct:11,total:11});
    expect(ownership.memberCounts('missing')).toEqual({direct:0,total:0});
    expect(ownership.memberCounts('agree')).toEqual({direct:0,total:0});
  });

  it('deduplicates fragment references, reference formats and shared descendant paths by message ID', () => {
    const root=relation('root','CLASSIFY',[
      messageRef('same'), relationRef('same'),
      {kind:'text-fragment',messageId:'same',text:'fragment',hash:'hash'},
      messageRef('left'),relationRef('right'),
    ]);
    const ownership=createContainerOwnership([root,container('left',['same','shared']),container('right',['shared'])]);
    expect(ownership.memberCounts('root')).toEqual({direct:3,total:4});
  });

  it('excludes self and anonymous endpoints and terminates cyclic imported membership', () => {
    const ownership=createContainerOwnership([container('A',['A','B','anon:ghost']),container('B',['A','B','leaf','anon:B'])]);
    expect(ownership.memberCounts('A')).toEqual({direct:1,total:2});
    expect(ownership.memberCounts('B')).toEqual({direct:2,total:2});
  });

  it('uses independent effective JOIN membership and replaces totals for moves and rejection snapshots', () => {
    const A={...container('A',['member']),payload:{independentMemberships:true}};
    const B={...container('B'),payload:{independentMemberships:true}};
    const old=relation('old','JOIN',[messageRef('member')],'A');
    const moved={...relation('moved','JOIN',[messageRef('member')],'B'),createdAt:'2026-01-02T00:00:00Z'};
    const before=createContainerOwnership([A,B,old]);
    expect(before.memberCounts('A')).toEqual({direct:1,total:1});
    const relations=[A,B,old,moved];
    const after=createContainerOwnership(relations);
    expect(after.memberCounts('A')).toEqual({direct:0,total:0});
    expect(after.memberCounts('B')).toEqual({direct:1,total:1});
    const opposed=createContainerOwnership(relations,new Set(),new Set(['moved']));
    expect(opposed.memberCounts('A')).toEqual({direct:1,total:1});
    expect(opposed.memberCounts('B')).toEqual({direct:0,total:0});
    const parentOpposed=createContainerOwnership(relations,new Set(['B']));
    expect(parentOpposed.memberCounts('A')).toEqual({direct:1,total:1});
    expect(parentOpposed.memberCounts('B')).toEqual({direct:0,total:0});
    expect(before.memberCounts('A')).toEqual({direct:1,total:1});
  });

  it('isolates current-user and comparison-preview winner snapshots even with the same relation array', () => {
    const relations=[container('A'),container('B'),relation('old','JOIN',[messageRef('member')],'A'),
      {...relation('new','JOIN',[messageRef('member')],'B'),createdAt:'2026-01-02T00:00:00Z'}];
    const personal=createContainerOwnership(relations,new Set(),new Set(),new Map([['member','old']]));
    const preview=createContainerOwnership(relations,new Set(),new Set(),new Map([['member','new']]));
    expect(personal.memberCounts('A')).toEqual({direct:1,total:1});
    expect(preview.memberCounts('A')).toEqual({direct:0,total:0});
    expect(personal.memberCounts('B')).toEqual({direct:0,total:0});
    expect(preview.memberCounts('B')).toEqual({direct:1,total:1});
  });

  it('does not count retired containers and retains the existing release semantics for opposed legacy containers', () => {
    const relations=[container('root',['nested','leaf']),container('nested',['inside'])];
    const opposed=createContainerOwnership(relations,new Set(['nested']));
    expect(opposed.memberCounts('root')).toEqual({direct:2,total:3});
    const retired=createContainerOwnership([relations[0],{...relations[1],state:{
      messageId:'nested',revision:1,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0,organizationRetired:true,
    }}]);
    expect(retired.memberCounts('root')).toEqual({direct:1,total:1});
    expect(retired.memberCounts('nested')).toEqual({direct:0,total:0});
  });

  it('does no indexing before use and reuses requested totals and shared adjacency without retraversal', () => {
    const nested=container('nested',['leaf']);
    const readMembers=vi.fn(()=>[messageRef('leaf')]);
    Object.defineProperty(nested,'targetRefs',{get:readMembers});
    const ownership=createContainerOwnership([container('root',['nested']),nested]);
    expect(readMembers).not.toHaveBeenCalled();
    const first=ownership.memberCounts('root'),reads=readMembers.mock.calls.length;
    expect(first).toEqual({direct:1,total:2});
    expect(reads).toBeGreaterThan(0);
    for(let repeat=0;repeat<20;repeat++)expect(ownership.memberCounts('root')).toBe(first);
    expect(ownership.memberCounts('nested')).toEqual({direct:1,total:1});
    expect(readMembers).toHaveBeenCalledTimes(reads);
  });

  it('counts a deep imported hierarchy without recursive stack growth', () => {
    const depth=6000;
    const relations=Array.from({length:depth},(_,index)=>container(`category-${index}`,[index===depth-1?'leaf':`category-${index+1}`]));
    expect(createContainerOwnership(relations).memberCounts('category-0')).toEqual({direct:1,total:depth});
  });
});
