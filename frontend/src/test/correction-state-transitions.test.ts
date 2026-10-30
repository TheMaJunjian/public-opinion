import {describe,it,expect} from 'vitest';
import {bodyVersion,bodyVersionKey,meaningVersionKey} from '@gonglun/core';
import type {ReadingMark} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {convertMessagesToDemoModel,computeCorrectionVersions,computeEffectiveSuppressedRelIds,computeGloballySuppressedRelIds,computeUserOverriddenStanceRelIds} from '../utils/modelBridge';
import {deriveCorrectionStanceDisplay} from '../utils/correctionStanceDisplay';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {deriveDisplayHints} from '../pages/workbench/model/displayHints';
import {readingMarksFor,deriveReadingProgress,influenceReadingMarks} from '../pages/workbench/model/readingProgress';
import {createReadingVersionHistory,applyReadingVersions} from '../pages/workbench/model/readingVersions';
const author={id:'editor',username:'editor',createdAt:''},viewer={id:'viewer',username:'viewer',createdAt:''};
const original:Message={id:'m',kind:'TEXT',content:'甲乙',contentType:'TEXT',revision:1,createdAt:'2026-01-01',createdBy:author};
const c=(id:string,text:string,content:string,kind:'TEXT'|'MEANING'):Relation=>({id,revision:1,relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'text-fragment',messageId:'m',text,hash:id}],payload:{correctionKind:kind,correctionBeforeContent:'甲乙',correctionAfterContent:content},createdAt:'2026-01-02',createdBy:author});
const edits=[c('t','甲','丙乙','TEXT'),c('a','乙','甲丁','TEXT')];
const opinion=(id:string,target:string,type='DISAGREE',own=false):Relation=>({id,revision:1,sequence:Number(id.replace(/\D/g,''))||3,relationType:type,sourceMessageId:null,targetRefs:[{kind:'message',messageId:target}],createdAt:`2026-01-0${id.includes('4')?'4':'3'}`,createdBy:own?viewer:author});
function fixture(extra:Relation[]=[],marks:ReadingMark[]=[],selected='current'){
  const relations=[...edits,...extra],model=convertMessagesToDemoModel([original],relations);
  const personal=computeCorrectionVersions(model.messages,model.edges,computeEffectiveSuppressedRelIds(model.edges,model.messages,'viewer'),'viewer');
  const recommended=computeCorrectionVersions(model.messages,model.edges,computeGloballySuppressedRelIds(model.edges,model.messages));
  const history=createReadingVersionHistory();history.select('m',selected);
  const corrections=applyReadingVersions(personal,history.getSnapshot(),model.messages,recommended,personal),personalEffect=deriveContainerEffect({...model,relations,username:'viewer',stakeCounts:{}});
  const input={...model,relations,username:'viewer',readStatus:new Map<string,'READ'|'UNREAD'>(),readingMarks:marks,personalEffect,corrections:personal,recommendedCorrections:recommended,displayCorrections:corrections};
  const hints=deriveDisplayHints(input),reading={...input,marks,corrections,effectiveCorrections:personal,memberships:personalEffect.memberships,displays:new Map([...hints.hints].map(([id,h])=>[id,h.displayed]))};
  return {input,personal,recommended,history,reading,hint:hints.hints.get('m')!,confirm:()=>readingMarksFor(reading,'m',hints.hints.get('m')!.displayed)};
}
const initialMarks=()=>{
  let marks=fixture([],[],'original').confirm();
  for(const id of ['t','a']){const step=fixture([],marks);marks=[...marks,...readingMarksFor(step.reading,id,step.reading.displays.get(id)!)];}
  return [...marks,...fixture([],marks).confirm()];
};
describe('correction opposition, retained reading and visible causes',()=>{
  it('removes only a rejected TEXT change and keeps independent text changes and the shared read state',()=>{
    const marks=initialMarks(),after=fixture([opinion('oppose3','t')],marks);
    expect(after.hint.displayed.content).toBe('甲丁');expect(after.personal.get('m')?.current?.appliedCorrectionIds).toEqual(['a']);
    expect(after.hint.unread).toBe(false);expect(after.hint.selectionChanged).toBe(true);
    expect(deriveReadingProgress(after.reading).selectionChanges.get('m')?.causes).toContain('oppose3');
    expect(marks.filter(mark=>mark.scope!=='influence'&&mark.messageId==='m')).toHaveLength(2);
  });
  it('returns to the previously read original while retaining a new selection confirmation',()=>{
    const marks=initialMarks(),extra=[opinion('oppose3','t'),opinion('oppose4','a')],after=fixture(extra,marks);
    expect(after.hint).toMatchObject({unread:false,selectionChanged:true,displayed:{content:'甲乙'}});
    expect(deriveReadingProgress(after.reading).confirmed('m')).toBe(false);
    const confirmed=fixture(extra,[...marks,...after.confirm(),...influenceReadingMarks('m',deriveReadingProgress(after.reading).pendingInfluences.get('m')??[])]);expect(confirmed.hint.selectionChanged).toBe(false);expect(deriveReadingProgress(confirmed.reading).confirmed('m')).toBe(true);
    expect(confirmed.personal.get('m')?.versions).toHaveLength(2);
  });
  it('keeps explicit personal adoption while public recommendation rejects the same correction',()=>{
    const own=opinion('own4','a','AGREE',true),extra=[opinion('oppose3','a'),own,{...opinion('other5','a'),createdBy:{id:'third',username:'third',createdAt:''}}];
    const result=fixture(extra,initialMarks());expect(result.hint.displayed.content).toBe('丙丁');expect(result.hint.unread).toBe(false);
    expect(result.recommended.get('m')?.current?.content).toBe('丙乙');
  });
  it('restores a previously read combination on re-adoption without repeating its outcome reminder',()=>{
    const marks=initialMarks(),rejected=[opinion('oppose3','a')],after=fixture(rejected,marks),ack=[...marks,...after.confirm()];
    const restored=fixture([...rejected,opinion('approve4','a','AGREE',true)],ack);
    expect(restored.hint.unread).toBe(false);expect(restored.hint.selectionChanged).toBe(false);
  });
  it('retains quoted-version evidence and shows its relation across display versions',()=>{
    const target=bodyVersion('m'),reply:Relation={...opinion('reply3','m','REPLY'),targetRefs:[{kind:'message',messageId:'m',reference:{messageId:'m',revision:1,context:{kind:'BODY',version:target}}}]};
    const before=fixture([reply],initialMarks());expect(before.hint.relatedUnreadIds).toContain('reply3');
    expect(fixture([reply],initialMarks(),'original').hint.relatedUnreadIds).toContain('reply3');
  });
  it('keeps rejected combinations fixed without changing personal or recommended adoption',()=>{
    const initial=fixture(),version=initial.personal.get('m')!.current!;initial.history.freeze('m',version);
    const rejected=fixture([opinion('oppose3','a')]),view=applyReadingVersions(rejected.personal,initial.history.getSnapshot(),rejected.input.messages);
    expect(view.get('m')?.current?.content).toBe('丙丁');expect(rejected.personal.get('m')?.current?.content).toBe('丙乙');
    expect(bodyVersionKey(view.get('m')!.current!.bodyVersion!)).toBe(bodyVersionKey(version.bodyVersion!));
  });
  it('shares content value and truth edges across display versions',()=>{
    const context={kind:'MEANING' as const,version:bodyVersion('m',1,[{messageId:'a',revision:1,kind:'MEANING'}])};
    const tag={...opinion('tag3','m','TAG'),targetRefs:[{kind:'message' as const,messageId:'m',reference:{messageId:'m',revision:1,context}}]};
    const result=fixture([tag],[],'original'),display=deriveCorrectionStanceDisplay(result.input.messages,result.input.edges,result.reading.corrections,{});
    expect(display.excludedEdges.has(result.input.edges.find(edge=>edge.relationMessageId==='tag3')!.id)).toBe(false);
  });
  it('takes the latest personal stance across all display versions',()=>{
    const a=bodyVersion('m'),b=bodyVersion('m',1,[{messageId:'a',revision:1,kind:'MEANING'}]);
    const stance=(id:string,version:typeof a,date:string):Relation=>({...opinion(id,'m','AGREE',true),createdAt:date,targetRefs:[{kind:'message',messageId:'m',reference:{messageId:'m',revision:1,context:{kind:'MEANING',version}}}]});
    const relations=[stance('old',a,'2026-01-03'),stance('other',b,'2026-01-04'),stance('new',a,'2026-01-05')],model=convertMessagesToDemoModel([original],relations);
    expect([...computeUserOverriddenStanceRelIds(model.edges,model.messages,'viewer')]).toEqual(['old','other']);
  });
  it('does not add locally loaded votes again when the server supplied authoritative scoped amounts',()=>{
    const result=fixture(),v=result.personal.get('m')!.current!.bodyVersion!,key=meaningVersionKey(v);
    const vote:Relation={...opinion('vote3','m','AGREE'),targetRefs:[{kind:'message',messageId:'m',reference:{messageId:'m',revision:1,context:{kind:'MEANING',version:v}}}]};
    const model=convertMessagesToDemoModel([{...original,state:{messageId:'m',revision:1,suppressed:false,supportCount:1,oppositionCount:0,recommendationTotal:0,contextStakes:{[key]:{truth:{pro:7,con:0},value:{pro:3,con:0}}}}}],[...edits,{...vote,spending:{protocol:0,recommendation:0,wager:7}}]);
    expect(deriveCorrectionStanceDisplay(model.messages,model.edges,result.personal,{m:{truth:{pro:7,con:0},value:{pro:3,con:0}}}).counts.m).toEqual({truth:{pro:7,con:0},value:{pro:3,con:0}});
  });
});
