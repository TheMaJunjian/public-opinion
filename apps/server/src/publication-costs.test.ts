import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {calculateSendCost} from '../../../frontend/src/hooks/useStakeCalculation';
import {contributionContext} from '../../../frontend/src/pages/workbench/model/contributionContext';
import {deriveContainerEffect} from '../../../frontend/src/pages/workbench/model/containerEffect';
import {projectWorkbenchSnapshot} from '../../../frontend/src/utils/workbenchProjection';
import {handleQuickSendAndRelateFromDraftTargets} from '../../../frontend/src/pages/workbench/actions/sendDraft';
import {createJoinRelationsForContainer,handleCreateRelationWithSourcesAndTargets,sendTagRelation} from '../../../frontend/src/pages/workbench/actions/sendRelation';
import {getClassifyTargetRefs,organizationTargetRef,resolveEffectiveTargetUnits} from '../../../frontend/src/pages/workbench/actions/targetResolution';
import {confirmReverseCorrection} from '../../../frontend/src/pages/workbench/actions/relationActions';
import type {DraftSendDependencies} from '../../../frontend/src/pages/workbench/actions/sendDraftTypes';
import type {RelationType,UnitSelection} from '../../../frontend/src/utils/modelBridge';
import {contributionFor,type ContributionDrafts} from '../../../frontend/src/pages/workbench/model/contributions';
import type {Relation,Message as ViewMessage} from '../../../frontend/src/types';
import {cleanupTestDatabases,createTestApp} from './test-database.js';
import {executeBatch,executeCommand} from './ui-commands.js';
import {relationViewType,snapshot} from './ui-projections.js';
import {bindRoles,targetInvestmentDimension} from '@gonglun/core';

vi.mock('../../../frontend/src/api',()=>({api:{getMessageStakes:vi.fn(async()=>({stakes:[]})),cancelCommandBatch:vi.fn()}}));
let app:Awaited<ReturnType<typeof createTestApp>>,user:Awaited<ReturnType<typeof app.store.user>>;
beforeAll(async()=>{
  vi.stubGlobal('window',Object.assign(new EventTarget(),{getSelection:()=>null,innerWidth:1024,innerHeight:768}));
  app=await createTestApp();
  const registration=await request(app).post('/api/register').send({name:'逐类计费核验',password:'local-test-password'});
  user=await app.store.user(registration.body.user.id);
});
afterAll(async()=>{await cleanupTestDatabases();vi.unstubAllGlobals();});

interface Scenario {name:string;type:RelationType|null;mode?:'sources'|'reason-parts'|'join'|'joined'|'all-joined'|'stale-join'|'empty'|'fulfill'|'containers'|'content-joined'|'edit-members'|'edit-join'|'replace-structure'|'remove-structure'|'covered-edge';secondary?:string;content?:string;fee?:number;label?:string}
const scenarios:Scenario[]=[
  {name:'独立文本',type:null},
  ...['修正原意','更正'].map(label=>({name:`独立正文＋自定义引用「${label}」`,type:'reference' as const,secondary:'custom',label,fee:3,content:'独立的新主张'})),
  ...(['reference','reply','annotation','notify','agree','disagree'] as const).flatMap(type=>[
    {name:type+' 带新正文',type},{name:type+' 已选来源',type,mode:'sources' as const},
  ]),
  {name:'通知使用候选目标和已有来源',type:'notify',mode:'reason-parts'},
  {name:'赞同同一来源的两个部件',type:'agree',mode:'reason-parts'},
  ...(['reference','reply','annotation','agree','disagree'] as const).map(type=>({name:type+' 整条关系与其连线同时选择',type,mode:'covered-edge' as const})),
  ...(['agree','disagree'] as const).map(type=>({name:type+' 不带正文',type,content:''})),
  ...['recommend','archive','attention','block','已有标签'].map(secondary=>({name:'标注 '+secondary,type:'tag' as const,secondary,content:''})),
  ...(['classify','summary','merge','arrange'] as const).flatMap(type=>[
    {name:'新建 '+type,type,content:type==='merge'?'':'分类名称'},
    ...(['join','joined','all-joined','stale-join'] as const).map(mode=>({name:type+' 加入模式 '+mode,type,mode,content:''})),
  ]),
  {name:'新建空分类',type:'classify',mode:'empty'},
  {name:'分类包含嵌套容器',type:'classify',mode:'containers'},
  {name:'已加入的提案作为内容消息显示',type:'classify',mode:'content-joined',content:''},
  {name:'新建空分类 协议费为 3',type:'classify',mode:'empty',fee:3},
  ...(['proposal','code_change','operations'] as const).map(type=>({name:type+' 与两条附属引用',type})),
  {name:'创建委托',type:'delegation',secondary:'create',mode:'empty',content:'报酬数量=7\n委托内容=测试'},
  {name:'完成委托',type:'delegation',secondary:'fulfill',mode:'fulfill',content:'完成说明=已完成'},
  {name:'更正正文',type:'correct',content:'更正后的正文'},
  {name:'授权规则提案',type:'authorize',mode:'empty',content:''},
  ...(['edit-members','edit-join','replace-structure','remove-structure'] as const).map(mode=>({name:'授权组织变更 '+mode,type:'authorize' as const,mode,content:''})),
];

for(const scope of ['root','inside'] as const)for(const scenario of scenarios)it(`${scope}：${scenario.name} 的预估与实际消息及账本一致`,async()=>{
  const rollback=new Error('rollback isolated scenario');
  await app.store.transaction(async()=>{
    const invoke=(path:string,body:Record<string,unknown>)=>executeCommand({store:app.store,user,requestId:randomUUID()},'POST',path,{recommendation:1,...body});
    const parent=await invoke('/relations',{relationType:'CLASSIFY',payload:{title:'外层'}});
    const scopeMessageId=scope==='root'?'root':parent.id;
    const targets:ViewMessage[]=[],sources:ViewMessage[]=[];
    for(const name of ['甲','乙'])targets.push(await invoke('/messages',{parentMessageId:scopeMessageId,content:name}));
    for(const name of ['来源甲','来源乙'])sources.push(await invoke('/messages',{content:name}));
    if(scenario.mode==='containers'){
      const inner=await invoke('/relations',{parentMessageId:scopeMessageId,relationType:'CLASSIFY',targetRefs:[{kind:'message',messageId:targets[0]!.id}],payload:{title:'内层容器'}});
      targets.splice(0,1,inner);
    }
    if(scenario.mode==='content-joined')targets.splice(0,1,await invoke('/relations',{relationType:'PROPOSAL',payload:{content:'已存在的提案'}}));
    if(scenario.mode==='covered-edge')targets.splice(0,1,await invoke('/relations',{relationType:'REFERENCE',sourceMessageId:sources[0]!.id,targetRefs:[{kind:'message',messageId:targets[0]!.id}]}));
    const joinOnly=['join','joined','all-joined','stale-join','content-joined'].includes(scenario.mode??'');
    let container:Relation|undefined;
    if(joinOnly){
      container=await invoke('/relations',{relationType:scenario.type!.toUpperCase(),payload:{title:'现有容器'}});
      const joined=scenario.mode==='all-joined'?targets:['joined','stale-join','content-joined'].includes(scenario.mode??'')?targets.slice(0,1):[];
      for(const target of joined){
        await invoke('/relations',{relationType:'JOIN',sourceMessageId:container!.id,targetRefs:[{kind:'message',messageId:target.id}]});
        if(scenario.mode==='stale-join')await invoke('/relations',{relationType:'JOIN',sourceMessageId:parent.id,targetRefs:[{kind:'message',messageId:target.id}]});
      }
    }
    if(scenario.mode==='fulfill'){
      const delegation=await invoke('/relations',{relationType:'DELEGATION',payload:{content:'委托',delegationKind:'CREATE',rewardAmount:7}});
      targets.splice(0,targets.length,delegation);
    }
    if(scenario.type==='authorize'){
      let proposal:ViewMessage;
      if(scenario.mode?.includes('structure')||scenario.mode?.startsWith('edit-')){
        const group=await invoke('/relations',{relationType:'CLASSIFY',targetRefs:targets.map(target=>({kind:'message',messageId:target.id})),payload:{title:'修改前分类'}});
        let reference:Record<string,unknown>={messageId:group.id},value:unknown;
        if(scenario.mode==='edit-members'){
          reference.partId='relation';reference.path=['roles','members'];
          value=bindRoles({members:[{messageId:targets[0]!.id},{messageId:sources[0]!.id}]}).members;
        }else if(scenario.mode==='edit-join'){
          const placement=await app.store.db.prepare('SELECT "sourceId" FROM memberships WHERE "memberId"=$1').get(targets[0]!.id);
          reference={messageId:String(placement!.sourceId),partId:'relation',path:['roles','parent']};
          value=bindRoles({parent:[{messageId:parent.id}]}).parent;
        }else if(scenario.mode==='replace-structure'){
          reference={messageId:sources[0]!.id};
          value=[{id:'relation',type:'relation',relation:'classify',roles:bindRoles({members:targets.map(target=>({messageId:target.id}))})}];
        }else value=[{id:'body',type:'text',text:'取消分类结构'}];
        proposal=await invoke('/relations',{relationType:'CORRECT',targetRefs:[{kind:'message',messageId:reference.messageId,reference}],payload:{correctionValue:value}});
      }else proposal=await invoke('/relations',{relationType:'PROPOSAL',payload:{content:'调整规则',proposedParameters:{}}});
      targets.splice(0,targets.length,proposal);
    }
    if(scenario.fee!==undefined)await app.store.set('rules',{...await app.store.rules(),protocolFee:scenario.fee});
    const projected=projectWorkbenchSnapshot(await snapshot(app.store,'root',{limit:200},user.id));
    const effect=deriveContainerEffect({...projected,username:user.name});
    const unit=(id:string):UnitSelection=>({messageId:id,selection:{kind:'whole'}});
    let selectedTargets=scenario.mode==='empty'&&scenario.type!=='authorize'||scenario.type===null?[]:targets.map(target=>unit(target.id));
    if(scenario.mode==='covered-edge')selectedTargets.push({messageId:targets[0]!.id,selection:{kind:'edge',edgeId:'selected-edge'}});
    if(scenario.type==='correct')selectedTargets=selectedTargets.slice(0,1);
    const sourceUnits=joinOnly?[unit(container!.id)]:scenario.mode==='sources'?sources.map(source=>unit(source.id)):
      scenario.mode==='reason-parts'?[{...unit(sources[0]!.id),reference:{messageId:sources[0]!.id,partId:'body'}},{...unit(sources[0]!.id),reference:{messageId:sources[0]!.id,partId:'data'}}]:[];
    const draftUnits=scenario.mode==='sources'||joinOnly?[]:selectedTargets,targetUnits=draftUnits.length?[]:selectedTargets;
    const content=scenario.content??'发送正文',secondary=scenario.secondary??'none',fee=(await app.store.rules()).protocolFee;
    const contributions:ContributionDrafts=Object.fromEntries(['TEXT','REFERENCE','REPLY','ANNOTATION','NOTIFY','AGREE','DISAGREE','TAG','READ','UNREAD','RECOMMEND','ARCHIVE','ATTENTION','BLOCK','CLASSIFY','SUMMARY','MERGE','ARRANGE','PROPOSAL','CODE_CHANGE','OPERATIONS','DELEGATION','CORRECT','AUTHORIZE','JOIN']
      .map((type,index)=>[type,{truth:index%3+1,value:index%2+1}]));
    const costContext=contributionContext({relationType:scenario.type,draftUnits,targetUnits,sourceUnits,relations:projected.relations,containerEffect:effect,joinOnlyAction:joinOnly});
    const cost=calculateSendCost({...costContext,relationType:scenario.type,secondaryRelationType:secondary,sourceUnits,newMessageContent:content,stakeAmount:1,relStakeAmount:1,
      contributions,scopeParentId:scopeMessageId,joinOnlyAction:joinOnly},fee)!;
    const commands:Array<{id:string;method:'POST';path:string;body:Record<string,unknown>}>=[],errors:string[]=[];
    const pricing=(type:string)=>{const investment=contributionFor(type,contributions);return {wager:Number(investment.truth),recommendation:Number(investment.value)};};
    const enqueue=(path:string,body:Record<string,unknown>)=>{
      const id=randomUUID();commands.push({id,method:'POST',path,body:{parentMessageId:scopeMessageId,...body}});
      return {...body,id,createdAt:new Date().toISOString(),createdBy:{id:user.id,username:user.name,createdAt:''},revision:1};
    };
    const createRel:DraftSendDependencies['createRel']=async(_scope,data)=>enqueue('/relations',{...data,...pricing(data.relationType),selfAgree:!['AGREE','DISAGREE'].includes(data.relationType)&&pricing(data.relationType).wager>0,joinContribution:pricing('JOIN')}) as unknown as Relation;
    const empty=vi.fn(),register=vi.fn(async()=>null),organizationRef=(selection:UnitSelection)=>organizationTargetRef({msgMap:effect.msgMap},selection);
    const deps:DraftSendDependencies={
      requireAuth:()=>true,singleButtonEnabled:true,newMessageContent:content,savedTextOnTypeSwitchRef:{current:''},draftUnits,targetUnits,sourceUnits,
      setSendError:value=>{if(typeof value==='string')errors.push(value);},resolveEffectiveTargetUnits:(draft,targets,type)=>resolveEffectiveTargetUnits({msgMap:effect.msgMap,promoteCompleteContainerSelections:units=>units},draft,targets,type),
      relationType:scenario.type,hasTextContent:!!content,stakeAmount:1,relStakeAmount:1,containerRelationTypes:new Set(['CLASSIFY','MERGE','SUMMARY','ARRANGE']),appendContainerType:joinOnly?scenario.type!.toUpperCase():null,
      effectiveMinStake:0,subType:['attention','block'].includes(secondary)?'YES':'',subTypeCustomLabel:'',subTypeStakeMap:{current:{}},relationStakeMap:{current:{}},totalConsumption:cost,availablePoints:1000,
      handleSendMessageOnly:async text=>{const result=enqueue('/messages',{content:text??content,...pricing('TEXT'),selfAgree:true,joinContribution:pricing('JOIN')});return {id:result.id,kind:'normal',content:text??content,author:user.name,createdAt:result.createdAt};},
      guideTargetIdRef:{current:null},setNewMessageContent:empty,getContainerMembershipTargetError:()=>null,joinOnlyAction:joinOnly,getContainerCycleError:()=>null,showAlert:message=>errors.push(message),
      relationsRef:{current:projected.relations},getJoinContainerCycleError:()=>null,createJoinRelationsForContainer:(id,type,refs)=>createJoinRelationsForContainer({getDependentDisplayTarget:()=>null,setSendError:empty,msgMap:effect.msgMap,
        containerRelationTypes:new Set(['CLASSIFY','SUMMARY','MERGE','ARRANGE']),relationsRef:{current:projected.relations},createRel,scopeMessageId,appendCreatedRelation:register,effectiveJoinRelationIds:effect.effectiveJoinIds},id,type,refs),
      setEdges:empty,setDraftUnits:empty,setSourceUnits:empty,setTargetUnits:empty,setActiveTextSelectId:empty,setSubType:empty,setRelationType:empty,setSecondaryRelationType:empty,relationLabel:scenario.label??'',
      handleCreateRelationWithSourcesAndTargets:params=>handleCreateRelationWithSourcesAndTargets({...deps,subTypeCustomLabel:'',registerCreatedRelationInCurrentClassify:register},params),secondaryRelationType:secondary,msgMap:effect.msgMap,createRel,scopeMessageId,
      registerCreatedRelationInCurrentClassify:register,edgesRef:{current:[]},sendTagRelation:(...args)=>sendTagRelation({...deps,registerCreatedRelationInCurrentClassify:register},...args),
      subTypeCustomBufferRef:{current:''},setSubTypeCustomLabel:empty,setComparisonPopup:vi.fn(),correctionVersions:new Map(),blockCorrectionForSecondBettor:async()=>false,edges:[],relationById:effect.relationById,
      organizationTargetRef:organizationRef,getGroupedTargetTextMessageIds:units=>units.map(unit=>unit.messageId),relationTypeByRelMsgId:new Map(projected.relations.map(relation=>[relation.id,relation.relationType.toLowerCase() as RelationType])),
      hasCrossNonReferenceTextLinkForClassifyTargets:()=>null,getClassifyTargetRefs:units=>getClassifyTargetRefs({msgMap:effect.msgMap,organizationTargetRef:organizationRef,relationTypeByRelMsgId:deps.relationTypeByRelMsgId},units),
      isInsideClassify:scope==='inside',currentClassifyRelMsgId:scope==='inside'?parent.id:null,classifyStackRef:{current:[]},appendCreatedRelation:register,setTraceKey:empty,isGovernanceOrOpsType:['proposal','code_change','operations'].includes(scenario.type??''),
      relations:projected.relations,setRelations:empty,hasTargetsAvailable:!!selectedTargets.length,user:{id:user.id,username:user.name,createdAt:''},setMessages:empty,relStakeRef:{current:1},setAuthorStakes:empty,mergeStakeSnapshot:empty,
    };
    await handleQuickSendAndRelateFromDraftTargets(deps);
    if(scenario.type==='correct'){
      const comparisonPopup=vi.mocked(deps.setComparisonPopup).mock.calls.at(-1)?.[0];
      expect(comparisonPopup).toBeTruthy();
      await confirmReverseCorrection({...deps,sendInFlightRef:{current:false},setSendInFlight:empty,setRecommendationAmount:empty,comparisonPopup:comparisonPopup as Parameters<typeof confirmReverseCorrection>[0]['comparisonPopup']});
    }
    expect(errors).toEqual([]);
    const before=await app.store.account(user.id),sequence=await app.store.latestSequence();
    const existingIds=new Set((await app.store.db.prepare('SELECT id FROM messages').all()).map(row=>String(row.id)));
    if(commands.length)await executeBatch(app.store,user,{requestId:randomUUID(),commands});
    const messages=(await app.store.db.prepare('SELECT body FROM messages WHERE "authorId"=$1 AND sequence>$2').all(user.id,sequence)).map(row=>JSON.parse(String(row.body))).filter(message=>!existingIds.has(message.id));
    const counts:Record<string,number>={};for(const message of messages){const type=relationViewType(message)??'TEXT';counts[type]=(counts[type]??0)+1;}
    expect(Object.fromEntries(cost.groups.map(group=>[group.type,group.count]))).toEqual(counts);
    const after=await app.store.account(user.id);
    expect(cost.messageCount).toBe(messages.length);
    if(scenario.label){const references=messages.filter(message=>relationViewType(message)==='REFERENCE');expect(references).toHaveLength(2);for(const reference of references)expect(reference.parts.find((part:any)=>part.type==='data').value.label).toBe(scenario.label);expect(cost.groups.find(group=>group.type==='REFERENCE')).toMatchObject({count:2,protocolFeeTotal:6});}
    expect(cost.total).toBe(before.available-after.available);
    const targetValue=messages.filter(message=>message.spending.wager===0&&message.parts.some((part:any)=>part.type==='relation'&&targetInvestmentDimension(part.relation)==='VALUE')).reduce((sum,message)=>sum+message.spending.recommendation,0);
    expect(cost.stakeTotal+targetValue+cost.delegationRewardStake).toBe(after.locked-before.locked);
    expect(cost.protocolFeeTotal).toBe(messages.reduce((sum,message)=>sum+message.spending.protocol,0));
    expect(cost.recommendationTotal).toBe(messages.reduce((sum,message)=>sum+message.spending.recommendation,0));
    throw rollback;
  }).catch(error=>{if(error!==rollback)throw error;});
});
