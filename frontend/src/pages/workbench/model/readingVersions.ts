import type {CorrectionVersion,DemoMessage} from '../../../utils/modelBridge';
import {correctionVersionIdentity} from '../../../utils/bodyVersions';
import {bodyVersionKey,type BodyVersion,type ReadingMark} from '@gonglun/core';

type VersionVisit={values:readonly string[];index:number;frozen?:Readonly<Record<string,CorrectionVersion>>};
export type ReadingVersions=ReadonlyMap<string,VersionVisit>;
export const selectedReadingVersion=(versions:ReadingVersions,id:string)=>{
  const visit=versions.get(id);return visit?.values[visit.index]??'current';
};

type VersionContent=(value:string)=>string|undefined;
/** A changed source can resolve to the same text; only visit a different displayed body. */
export function readingVersionNavigation(versions:ReadingVersions,id:string,contentFor:VersionContent=value=>value,_displayedContent?:string,identityFor:VersionContent=value=>value){
  const visit=versions.get(id);
  const next=(direction:number)=>{
    if(!visit)return undefined;
    for(let index=visit.index+direction;index>=0&&index<visit.values.length;index+=direction){
      const content=contentFor(visit.values[index]);
      if(content!==undefined&&identityFor(visit.values[index])!==identityFor(visit.values[visit.index]))return index;
    }
  };
  return {back:next(-1),forward:next(1)};
}

/** Local viewing history is separate for each message and never changes its outcome. */
export function createReadingVersionHistory(){
  let snapshot:ReadingVersions=new Map();
  const listeners=new Set<()=>void>();
  const publish=(id:string,visit:VersionVisit)=>{
    snapshot=new Map(snapshot).set(id,visit);listeners.forEach(listener=>listener());
  };
  return {
    subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    getSnapshot:()=>snapshot,
    select:(id:string,value:string,recordVisit=true)=>{
      const previous=snapshot.get(id)??{values:['current'],index:0};
      if(previous.values[previous.index]===value)return;
      if(!recordVisit){const values=[...previous.values];values[previous.index]=value;publish(id,{...previous,values});return;}
      const values=[...previous.values.slice(0,previous.index+1),value];
      publish(id,{...previous,values,index:values.length-1});
    },
    freeze:(id:string,version:CorrectionVersion)=>{
      if(!version.bodyVersion)return;
      const key=bodyVersionKey(version.bodyVersion),previous=snapshot.get(id)??{values:['current'],index:0};
      publish(id,{values:[...previous.values.slice(0,previous.index+1),key],index:previous.index+1,frozen:{...previous.frozen,[key]:structuredClone(version)}});
    },
    back:(id:string,contentFor?:VersionContent,identityFor?:VersionContent)=>{const visit=snapshot.get(id),index=readingVersionNavigation(snapshot,id,contentFor,undefined,identityFor).back;if(visit&&index!==undefined)publish(id,{...visit,index});},
    forward:(id:string,contentFor?:VersionContent,identityFor?:VersionContent)=>{const visit=snapshot.get(id),index=readingVersionNavigation(snapshot,id,contentFor,undefined,identityFor).forward;if(visit&&index!==undefined)publish(id,{...visit,index});},
  };
}
export type ReadingVersionHistory=ReturnType<typeof createReadingVersionHistory>;
type CorrectionEntries=Map<string,{current?:CorrectionVersion;versions:CorrectionVersion[]}>;
export type ReadingVersionChoice={value:string;label:string;sameAs:string[];content:string;identity?:string};

/** Only the same complete version can share a row. */
export function readingVersionChoices(original:string,personal:CorrectionVersion|undefined,recommended:CorrectionVersion|undefined,hasPersonalChoice:boolean,versions:CorrectionVersion[]=[],originalVersion?:BodyVersion):ReadingVersionChoice[]{
  const result:ReadingVersionChoice[]=[];
  const sources=[{value:'original',label:'原文',content:original,identity:correctionVersionIdentity(undefined,originalVersion)},{value:'recommended',label:'推荐选择',content:recommended?.content??original,identity:correctionVersionIdentity(recommended,originalVersion)},
    {value:'personal',label:'当前用户选择',content:personal?.content??original,identity:correctionVersionIdentity(personal,originalVersion)},
    ...versions.filter(version=>version.applicable!==false).map(version=>({value:version.correctionId,label:`更正 ${version.correctionId}${version.exclusionReason?`（${({personal:'本人反对',public:'公共反对',competition:'同处未采用',revision:'基础版本不同',address:'地址不匹配',authorization:'待授权'} as const)[version.exclusionReason]}）`:''}`,content:version.content,identity:correctionVersionIdentity({...version,appliedCorrectionIds:[version.correctionId]})}))];
  for(const source of sources){
    if(source.value==='personal'&&!hasPersonalChoice)continue;
    const existing=result.find(choice=>choice.identity===source.identity);
    if(existing){if(versions.some(version=>version.correctionId===source.value))continue;existing.sameAs.push(source.label);existing.value=source.value;}
    else result.push({...source,sameAs:[]});
  }
  return result;
}

export function readingVersionLabel(choices:ReadingVersionChoice[],content:string,identity?:string){
  const choice=choices.find(item=>identity===undefined?item.content===content:item.identity===identity);
  return choice?`${choice.label}${choice.sameAs.length?`（与${choice.sameAs.join('、')}相同）`:''}`:'更正预览';
}

/** Render a chosen complete version, including changed parts in multipart messages. */
export function applyReadingVersions(corrections:CorrectionEntries,versions:ReadingVersions,messages:DemoMessage[],recommendedCorrections?:CorrectionEntries,personalCorrections=corrections):CorrectionEntries{
  if(!versions.size)return corrections;
  const result=new Map(corrections),originals=new Map(messages.map(message=>[message.id,message.content]));
  for(const [id] of versions){
    const entry=corrections.get(id),selected=selectedReadingVersion(versions,id);
    const frozen=versions.get(id)?.frozen?.[selected];if(frozen){result.set(id,{...(entry??{versions:[]}),current:frozen});continue;}
    if(!entry)continue;
    if(selected==='current'||selected==='personal'||selected==='recommended'){
      result.set(id,{...entry,current:(selected==='recommended'?recommendedCorrections:personalCorrections)?.get(id)?.current});continue;
    }
    if(selected==='original'){result.set(id,{...entry,current:undefined});continue;}
    const version=entry.versions.find(item=>item.correctionId===selected);
    if(!version)continue;
    const original=originals.get(id)??version.baseContent;
    let start=0,end=original.length,replacementEnd=version.content.length;
    while(start<end&&start<replacementEnd&&original[start]===version.content[start])start++;
    while(end>start&&replacementEnd>start&&original[end-1]===version.content[replacementEnd-1]){end--;replacementEnd--;}
    result.set(id,{...entry,current:{...version,appliedCorrectionIds:[version.correctionId],
      changes:[{start,end,replacement:version.content.slice(start,replacementEnd)}]}});
  }
  return result;
}

/** Only versions actually recorded or addressed are known; never enumerate combinations. */
export function indexKnownReadingBodyVersions(marks:ReadingMark[],references:DemoMessage[]):Map<string,BodyVersion[]>{
  const result=new Map<string,Map<string,BodyVersion>>();
  const add=(version:BodyVersion)=>{if(version.corrections.some(item=>item.kind==='MEANING'))return;const values=result.get(version.messageId)??new Map();values.set(bodyVersionKey(version),version);result.set(version.messageId,values);};
  for(const mark of marks)if(!mark.unknownContext&&mark.version)add(mark.version);
  for(const message of references)for(const part of message.parts??[])if(part.type==='relation')for(const bindings of Object.values(part.roles))for(const binding of bindings){
    const context=binding.reference.context;if(context&&'version' in context&&context.version)add(context.version);
  }
  return new Map([...result].map(([id,values])=>[id,[...values.values()]]));
}
export const knownReadingBodyVersions=(id:string,marks:ReadingMark[],references:DemoMessage[])=>indexKnownReadingBodyVersions(marks,references).get(id)??[];
