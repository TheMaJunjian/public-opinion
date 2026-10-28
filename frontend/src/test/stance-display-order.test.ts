import {expect,it} from 'vitest';
import {computeCorrectionVersions,computeGloballySuppressedRelIds,computeUserActiveStanceRelIds,computeUserOverriddenStanceRelIds,type DemoMessage,type DemoEdge} from '../utils/modelBridge';

const target:DemoMessage={id:'target',author:'other',content:'目标',kind:'relation',relationType:'reference',createdAt:'2026-10-27T09:00:00Z'};
const stance=(id:string,type:'agree'|'disagree',wager:number,sequence:number):DemoMessage=>({id,author:'reader',content:'',kind:'relation',relationType:type,
  createdAt:'2026-10-27T10:00:00Z',sequence,spending:{wager,recommendation:0,protocol:0}});
const edge=(message:DemoMessage):DemoEdge=>({id:message.id,relationMessageId:message.id,relationType:message.relationType!,relationLabel:'',
  from:{messageId:`anon:${message.id}`,selection:{kind:'whole'}},to:{messageId:target.id,selection:{kind:'whole'}}});

it('uses stake totals rather than voter counts and resolves equal amounts by the latest publication',()=>{
  const votes=[stance('z-support', 'agree',10,1),stance('y-support','agree',10,2),stance('a-opposition','disagree',20,3)];
  for(const records of [votes,[...votes].reverse()])expect(computeGloballySuppressedRelIds(records.map(edge),[target,...records])).toEqual(new Set(['target']));
  const latest=stance('latest-support','agree',20,4),opposition=stance('earlier-opposition','disagree',20,3);
  expect(computeGloballySuppressedRelIds([edge(latest),edge(opposition)],[target,latest,opposition])).toEqual(new Set());
});

it('uses publication sequence for personal choices and their superseded labels at the same timestamp',()=>{
  const older=stance('z-older','agree',10,1),newer=stance('a-newer','disagree',10,2),records=[target,newer,older],edges=[edge(newer),edge(older)];
  expect(computeUserActiveStanceRelIds(edges,records,'reader').get(target.id)).toMatchObject({relMsgId:newer.id,type:'disagree'});
  expect(computeUserOverriddenStanceRelIds(edges,records,'reader')).toEqual(new Set([older.id]));
});

it('prefers the latest personal correction approval when both approvals have the same timestamp',()=>{
  const original:DemoMessage={...target,kind:'normal',relationType:undefined,content:'原文'};
  const older:DemoMessage={...target,id:'older',relationType:'correct',content:'较早更正',createdAt:'2026-10-27T09:10:00Z',sequence:1};
  const newer:DemoMessage={...older,id:'newer',content:'较新更正',createdAt:'2026-10-27T09:20:00Z',sequence:2};
  const approveNewer=stance('approve-newer','agree',10,3),approveOlder=stance('approve-older','agree',10,4);
  const corrections=[older,newer].map(message=>({...edge(message),to:{messageId:original.id,selection:{kind:'whole' as const}}}));
  const approvals=[{...edge(approveNewer),to:{messageId:newer.id,selection:{kind:'whole' as const}}},{...edge(approveOlder),to:{messageId:older.id,selection:{kind:'whole' as const}}}];
  const records=[original,older,newer,approveNewer,approveOlder];
  expect(computeCorrectionVersions(records,[...corrections,...approvals],new Set(),'reader').get(original.id)?.current?.correctionId).toBe(older.id);
});
