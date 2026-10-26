import { expect,it } from 'vitest';
import { deriveCorrectionStanceDisplay } from '../utils/correctionStanceDisplay';
import { computeCorrectionVersions,computeTransitiveVoteStats,computeTransitiveRelDecStats,convertMessagesToDemoModel } from '../utils/modelBridge';
import type { Message,Relation } from '../types';

it.each([42, { invalid: true }, ['correction', 42]])('keeps malformed imported stance context readable (%j)', invalid => {
  const user = { id: 'u', username: 'u', createdAt: '' };
  const original: Message = { id: 'original', kind: 'TEXT', contentType: 'TEXT', content: '原文', createdAt: '2026-01-01', createdBy: user };
  const correction: Relation = { id: 'correction', relationType: 'CORRECT', sourceMessageId: null,
    targetRefs: [{ kind: 'message', messageId: original.id }], createdAt: '2026-01-02', createdBy: user,
    payload: { correctionBeforeContent: '原文', correctionAfterContent: '新原意', correctionKind: 'MEANING' } };
  const stance: Relation = { ...correction, id: 'stance', relationType: 'AGREE', createdAt: '2026-01-03',
    payload: { stanceCorrections: { original: invalid as unknown as string[] } } };
  const model = convertMessagesToDemoModel([original], [correction, stance]);
  const versions = computeCorrectionVersions(model.messages, model.edges);
  const display = deriveCorrectionStanceDisplay(model.messages, model.edges, versions, {});
  expect(display.counts).toEqual({});
  expect(display.excludedEdges.has(model.edges.find(edge => edge.relationMessageId === stance.id)!.id)).toBe(false);
});

it.each(['TEXT','MEANING',undefined] as const)('shares ordinary votes and preserves historical context evidence (kind=%s)',kind=>{
  const user={id:'u',username:'u',createdAt:''};
  const original:Message={id:'original',kind:'TEXT',contentType:'TEXT',content:'原文',createdAt:'2026-01-01',createdBy:user};
  const relation=(id:string,type:string,target:string,date:string,payload:Relation['payload']={}):Relation=>({id,relationType:type,sourceMessageId:null,
    targetRefs:[{kind:'message',messageId:target}],createdAt:date,createdBy:user,payload});
  const records=[relation('old','AGREE','original','2026-01-02'),relation('correction','CORRECT','original','2026-01-03',{
    correctionBeforeContent:'原文',correctionAfterContent:'新正文',...(kind?{correctionKind:kind}:{})}),
    relation('new','AGREE','original','2026-01-04',{stanceCorrections:{original:kind==='MEANING'?['correction']:[]}}),
    relation('reverse','DISAGREE','new','2026-01-05'),relation('approve-correction','AGREE','correction','2026-01-06')];
  const model=convertMessagesToDemoModel([original],records);
  for(const [id,amount] of [['old',10],['new',4],['reverse',3]] as const)model.messages.find(message=>message.id===id)!.spending={protocol:1,recommendation:0,wager:amount};
  const versions=computeCorrectionVersions(model.messages,model.edges),raw={original:{truth:{pro:34,con:3},value:{pro:9,con:0}}};
  const before=JSON.stringify(model),display=deriveCorrectionStanceDisplay(model.messages,model.edges,versions,raw);
  const statistics=computeTransitiveVoteStats(model.edges,model.messages,display.excludedEdges);
  expect(statistics.original).toMatchObject({agreeCount:2,disagreeCount:1});
  expect(display.counts).toEqual(raw);expect(display.excludedEdges.size).toBe(0);
  expect(statistics.correction.agreeCount).toBe(1);
  expect(computeTransitiveRelDecStats(model.edges,model.messages,display.excludedEdges).get('correction')?.agreeCount).toBe(1);
  expect(display.counts.original.value).toEqual(raw.original.value);
  expect(JSON.stringify(model)).toBe(before);expect(raw.original.truth.pro).toBe(34);
});
