import { expect,it } from 'vitest';
import { legacyOrganizationState } from './legacy-organizations.js';

it('restores an older JOIN when the newest JOIN is rejected by a transitive stance',()=>{
  const users=[{id:'u',username:'alice'}];
  const message=(id:string,type:string|null,targets:any[],source:string|null=null,time='2026-01-01T00:00:00Z')=>({id,kind:type?'RELATION':'TEXT',content:id,createdById:'u',createdAt:time,relationType:type,targetRefs:targets,relSourceId:source,relationPayload:{}});
  const rows=[message('text',null,[]),message('a','CLASSIFY',[]),message('b','CLASSIFY',[]),message('join-old','JOIN',[{kind:'message',messageId:'text'}],'a'),message('join-new','JOIN',[{kind:'message',messageId:'text'}],'b','2026-01-01T00:01:00Z'),message('no','DISAGREE',[{kind:'relation',relationId:'join-new',part:'whole'}])];
  const state=legacyOrganizationState(rows,users);
  expect(state.rejected.has('join-new')).toBe(true);
  expect(state.effectiveJoins).toEqual(new Set(['join-old']));
});
