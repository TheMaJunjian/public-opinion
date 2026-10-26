import {it,expect} from 'vitest';
import {upgradeVersionContexts} from './version-context-format.js';
import type {Message} from '@gonglun/core';
const message=(id:string,createdAt='2026-01-01'):Message=>({id,revision:1,authorId:'u',createdAt,updatedAt:createdAt,regionId:'r',ledgerId:'l',programVersion:'2',ruleVersion:1,sequence:1,parts:[{id:'body',type:'text',text:'原文'}],spending:{protocol:1,wager:0,recommendation:1}});
it('migrates known original references, marks ambiguous corrected references unknown, and never mutates inputs',()=>{
  const m=message('m'),reply={...message('reply','2026-01-03'),parts:[{id:'r',type:'relation' as const,relation:'reply',roles:{target:[{id:'t',reference:{messageId:'m'}}]}}]};
  const originals=new Map([['m:1',m]]),latest=new Map([['m',m],['reply',reply]]),before=JSON.stringify(reply);
  const known=upgradeVersionContexts(reply,latest,originals);expect(known.parts[0].type==='relation'&&known.parts[0].roles.target[0].reference.context?.kind).toBe('BODY');
  const correction={...message('c','2026-01-02'),parts:[{id:'r',type:'relation' as const,relation:'correct',roles:{target:[{id:'t',reference:{messageId:'m',revision:1}}]}}]};
  latest.set('c',correction);const unknown=upgradeVersionContexts(reply,latest,originals);
  expect(unknown.parts[0].type==='relation'&&unknown.parts[0].roles.target[0].reference.context?.kind).toBe('UNKNOWN');expect(JSON.stringify(reply)).toBe(before);
  expect(upgradeVersionContexts(unknown,latest,originals)).toEqual(unknown);
});
