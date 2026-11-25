import {act,fireEvent,render,renderHook,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DEFAULT_MODERATION_POLICY,isRelationView,reviewContextPart,reviewReasonPart,type ModerationSummary,type NativeMessageView,type Part,type ReviewStakeItem,type WorkbenchSnapshot} from '@gonglun/core';
import ReviewPanel from '../components/ReviewPanel';
import MessageSettlementActions from '../components/MessageSettlementActions';
import {LocalReviewRecordsContext,ModerationContext} from '../components/ModerationContext';
import {WorkbenchStore} from '../data/workbench';
import {calculateSendCost} from '../hooks/useStakeCalculation';
import {contributionTypeAtReference,contributionTypeForTarget} from '../pages/workbench/model/contributions';
import type {ReviewDetail} from '../api/client';
import {projectWorkbenchSnapshot} from '../utils/workbenchProjection';
import {applyReviewSnapshots,recordsForReview,projectReviewDiscussionEdges,projectReviewVoteDecorations} from '../utils/reviewRecords';
import {ReviewDetailContext,useReviewDetail} from '../hooks/useReviewDetail';
import {useReviewVoteDecorations} from '../hooks/useReviewVoteDecorations';
import RecentWorkbenchViews from '../components/RecentWorkbenchViews';
import {convertMessagesToDemoModel} from '../utils/modelBridge';
import MessageCard from '../components/MessageCard';
import {useMessageWindow} from '../hooks/useMessageWindow';

const api=vi.hoisted(()=>({getReview:vi.fn(),sendReviewAction:vi.fn()}));
vi.mock('../api',()=>({api}));
const summary:ModerationSummary={caseId:'c',messageId:'m',revision:1,status:'pending',fee:6,deposit:10,pass:0,reject:0,reviewerCount:0,releaseAt:null,finalized:false};
const detail:ReviewDetail={summary,records:[],stakes:[],canReview:true,canAppeal:true,canSettle:true,policy:DEFAULT_MODERATION_POLICY};
beforeEach(()=>{vi.resetAllMocks();api.getReview.mockResolvedValue(detail);api.sendReviewAction.mockResolvedValue({id:'review-record',relationType:'REVIEW'});});
afterEach(()=>vi.useRealTimers());
const record=(id:string,user:string,verdict:'pass'|'reject',reason:string,sequence=1,round=1):NativeMessageView=>({
  id,revision:1,kind:'RELATION',contentType:'TEXT',content:reason,sequence,relationType:'REVIEW',sourceMessageId:null,
  sourceRefs:[],payload:{caseId:'c',reviewRound:round,verdict},updatedAt:'2026-11-08T00:00:00Z',spending:{protocol:1,wager:0,recommendation:0,reviewWager:2},
  state:{messageId:id,revision:1,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0},
  targetRefs:[{kind:'message',messageId:'m',reference:{messageId:'m',revision:1}}],
  createdBy:{id:user,username:user,createdAt:''},createdAt:'2026-11-08T00:00:00Z',parts:[
    {id:'body',type:'text',text:reason},{id:'review',type:'relation',relation:'review',roles:{target:[{id:'target',reference:{messageId:'m',revision:1}}]}},
    {id:'data',type:'data',value:{caseId:'c',reviewRound:round,verdict}}],
});
const stake=(source:NativeMessageView):ReviewStakeItem=>({id:`review-wager:${source.id}`,sourceMessageId:source.id,revision:source.revision,
  kind:'wager',side:source.payload.verdict==='pass'?'PRO':'CON',amount:source.spending.reviewWager??0,
  round:Number(source.payload.reviewRound??1),createdAt:source.createdAt,user:source.createdBy});
it('uses reason membership from the pinned case when deciding which votes need their own cards',()=>{
  const votes=[record('with-reason','u','pass',''),record('pure','u','pass','')];
  const models=convertMessagesToDemoModel(votes,votes.filter(isRelationView)).messages;
  const reason=(id:string,decision:string)=>({...models[0],id,relationType:undefined,restricted:true,parts:[reviewReasonPart({messageId:decision,revision:1})]});
  const records=[...models,reason('hidden-reason','with-reason'),reason('stale-reason','pure')];
  const {groups,voteIds}=projectReviewVoteDecorations(records,{targetId:'m',revision:1,recordIds:new Set(['with-reason','pure','hidden-reason'])});
  expect([...voteIds]).toEqual(['pure']);
  expect(groups.get('m')?.[0].votes).toMatchObject([{id:'pure',targetRevision:1,round:1,wager:2}]);
});
it('keeps reasonless ballots out of the card list when a saved view contains only relation metadata',()=>{
  const vote=record('vote','reader','reject','');
  const [model]=convertMessagesToDemoModel([vote],[vote].filter(isRelationView)).messages;
  const reject={...model,parts:undefined};
  const pass={...reject,id:'pass',relationPayload:{verdict:'pass' as const}};
  const covered={...reject,id:'covered',restricted:true,relationPayload:{}};
  const {groups,voteIds}=projectReviewVoteDecorations([reject,pass,covered],{targetId:'m',revision:1,recordIds:new Set(['vote','pass','covered'])});
  expect([...voteIds]).toEqual(['vote','pass','covered']);
  expect(groups.get('m')?.map(group=>[group.verdict,group.votes.map(vote=>vote.id)])).toEqual([['pass',['pass']],['reject',['vote']]]);
});
it('lists only funded PRO and CON stakes, including self stakes and repeated investments from earlier rounds',async()=>{
  const old=record('old','reviewer','pass','旧轮理由',1),latest=record('latest','reviewer','reject','新轮理由',2,2);
  const self:ReviewStakeItem={...stake(record('m','author','pass','')),id:'review-self:m',kind:'self',amount:10};
  const appeal:ReviewStakeItem={...stake(record('appeal','appellant','reject','',3,2)),id:'review-self:appeal',kind:'self',amount:10};
  const unrelated=record('discussion','discussion-author','pass','普通讨论与系统记录');
  api.getReview.mockResolvedValue({...detail,summary:{...summary,round:2,pass:12,reject:12,selfPass:10,selfReject:10},
    records:[old,latest,unrelated],stakes:[appeal,stake(latest),stake(old),self]});
  render(<ReviewPanel messageId="m"/>);
  const list=await screen.findByRole('list',{name:'审核押注记录'});
  expect(within(list).getAllByRole('listitem').map(item=>item.textContent)).toEqual([
    'appellantCON 10点','reviewerCON 2点','reviewerPRO 2点','authorPRO 10点',
  ]);
  expect(screen.getByText('记录 (4):')).toBeVisible();
  expect(screen.queryByText('discussion-author')).not.toBeInTheDocument();
  expect(screen.queryByText(/旧轮理由|新轮理由|普通讨论与系统记录/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'查看审核记录'})).not.toBeInTheDocument();
});
it('loads earlier votes on opening decorations in a new appeal round without counting self stakes',async()=>{
  const prior=record('previous-vote','reviewer','reject','',1,1);
  const appeal={...summary,status:'appeal' as const,round:2,pass:10,selfPass:10,reject:12,selfReject:10,reviewerCount:0};
  const source={...prior,id:'m',kind:'TEXT',relationType:null,parts:[],payload:{},targetRefs:[],moderation:appeal};
  const selfOnly={...source,id:'self-only',moderation:{...appeal,messageId:'self-only',reject:10}};
  api.getReview.mockResolvedValue({...detail,summary:appeal,records:[prior]});
  const messages=convertMessagesToDemoModel([source,selfOnly],[]).messages;
  const {result,rerender}=renderHook(({sequence})=>useReviewVoteDecorations(messages,undefined,true,'reader',sequence),{initialProps:{sequence:12}});
  expect(result.current.reviewVoteHints.has('self-only')).toBe(false);
  expect(result.current.reviewVoteHints.has('m')).toBe(true);
  expect(api.getReview).not.toHaveBeenCalled();
  act(()=>result.current.onExpandDecorations('m'));
  await waitFor(()=>expect(result.current.reviewVoteGroups.get('m')?.[0].votes).toMatchObject([{id:prior.id,author:'reviewer',wager:2}]));
  rerender({sequence:13});
  expect(result.current.reviewVoteGroups.get('m')?.[0].votes[0].id).toBe(prior.id);
  expect(api.getReview).toHaveBeenCalledExactlyOnceWith('m',expect.any(AbortSignal),1);
});
it('does not turn discussion records into stakes when the funded list is empty',async()=>{
  api.getReview.mockResolvedValue({...detail,records:[record('discussion','discussion-author','pass','审核讨论')]});
  render(<ReviewPanel messageId="m"/>);
  await screen.findByRole('button',{name:'投票'});
  expect(screen.queryByRole('list',{name:'审核押注记录'})).not.toBeInTheDocument();
  expect(screen.queryByText('discussion-author')).not.toBeInTheDocument();
});
it('keeps review preview records and totals over late live data, restores on cancel, and promotes before refresh',async()=>{
  const target:NativeMessageView={...record('m','author','pass','原正文'),kind:'TEXT',relationType:null,payload:{},targetRefs:[],
    parts:[{id:'body',type:'text',text:'原正文'}],moderation:summary};
  const existing=record('existing','reviewer','pass','原审核理由');
  const current={...detail,target,records:[existing],stakes:[stake(existing)]};
  api.getReview.mockResolvedValue(current);
  const initialProps:{pages?:WorkbenchSnapshot[]}={};
  const view=renderHook(({pages})=>useReviewDetail('m',1,pages),{initialProps});
  await waitFor(()=>expect(view.result.current.records).toEqual([existing]));
  const next={...summary,pass:2,reviewerCount:1};
  const changed={...record('existing','reviewer','pass','修订后的审核理由',2),revision:2};
  const added=record('new','second','reject','新增的审核理由',3);
  const pages:WorkbenchSnapshot[]=[{scope:{messageId:null,title:'公论'},sequence:4,users:[],stakes:{},tagCounts:{},attentionUsers:{},
    messages:[{...target,moderation:next},changed,added],relations:[changed,added].filter(isRelationView)}];
  view.rerender({pages});
  expect(view.result.current.records).toEqual([changed,added]);expect(view.result.current.detail?.summary).toEqual(next);
  expect(view.result.current.detail?.stakes).toEqual([stake(added),stake(existing)]);
  await act(()=>view.result.current.refresh());
  expect(view.result.current.records).toEqual([changed,added]);expect(view.result.current.target?.moderation).toEqual(next);
  view.rerender({pages:undefined});
  expect(view.result.current.records).toEqual([existing]);expect(view.result.current.detail?.summary).toEqual(summary);
  expect(view.result.current.detail?.stakes).toEqual([stake(existing)]);
  view.rerender({pages});
  let refresh!:(value:ReviewDetail)=>void;
  api.getReview.mockImplementationOnce(()=>new Promise(resolve=>{refresh=resolve;}));
  act(()=>window.dispatchEvent(new CustomEvent('gonglun:committed',{detail:pages})));
  view.rerender({pages:undefined});
  expect(view.result.current.records).toEqual([changed,added]);expect(view.result.current.detail?.summary).toEqual(next);
  expect(view.result.current.detail?.stakes).toEqual([stake(added),stake(existing)]);
  await act(async()=>refresh({...current,summary:next,target:{...target,moderation:next},records:[changed,added],stakes:[stake(added),stake(existing)]}));
  view.unmount();
});
it('keeps the pinned review revision while applying restricted preview bodies and excludes another review case',()=>{
  const target:NativeMessageView={...record('m','author','pass','固定版本'),kind:'TEXT',relationType:null,payload:{},targetRefs:[],moderation:summary};
  const other:NativeMessageView={...record('other','author','reject','其他审核'),parts:[{id:'body',type:'text',text:'其他审核'}]};
  const newerCase={...summary,caseId:'newer-case',revision:2,reject:20};
  const page:WorkbenchSnapshot={scope:{messageId:null,title:'公论'},sequence:4,users:[],stakes:{},tagCounts:{},attentionUsers:{},
    messages:[{...target,revision:2,restricted:true,content:'另一版本',moderation:newerCase,restrictedReviewTargets:[{messageId:'m',revision:2}]},other],relations:[other].filter(isRelationView)};
  const stakes:ReviewStakeItem[]=[{...stake(target),id:'review-self:m',kind:'self',amount:10}];
  const hiddenByNewer=applyReviewSnapshots({...detail,target,stakes},[page]);
  expect(hiddenByNewer).toMatchObject({target:{id:'m',revision:1,restricted:true,moderation:summary,restrictedReviewSummaries:[newerCase]},records:[],stakes:[],canReview:false,canSettle:false});
  expect(JSON.stringify(hiddenByNewer.target)).not.toMatch(/固定版本|另一版本/);
  const newerDetail={...detail,summary:{...summary,revision:3},target:{...target,revision:3},stakes};
  expect(applyReviewSnapshots(newerDetail,[page])).toMatchObject({target:newerDetail.target,records:[],stakes,canReview:true});
  const hidden={...target,restricted:true,content:'内容暂时隐藏',parts:[{id:'restricted-body',type:'text' as const,text:'内容暂时隐藏'}]};
  expect(applyReviewSnapshots({...detail,target,stakes},[{...page,messages:[hidden],relations:[]}])).toMatchObject({target:hidden,stakes:[]});
});
it.each(['original','reason'])('evicts every stale quote and rebuilds vote facts when a partial snapshot hides the %s',which=>{
  const scope={messageId:'m',revision:1};
  const ref={messageId:'secret-source',revision:1,partId:'body',range:{start:0,end:6}};
  const vote=record('vote','reviewer','reject','PRIVATE-VOTE-TEXT');
  vote.sourceMessageId=ref.messageId;vote.sourceRefs=[ref];
  vote.targetRefs=[{kind:'text-fragment',messageId:'m',text:'PRIVATE-TARGET',hash:'hash',reference:{...ref,messageId:'m'}}];
  vote.declaredTargetRefs=vote.targetRefs;
  vote.payload.content='PRIVATE-PAYLOAD';
  vote.parts=[
    ...vote.parts.map(part=>part.type==='relation'?{...part,roles:{...part.roles,source:[{id:'source',reference:ref}]}}:part),
    {id:'web',type:'web',url:'PRIVATE-URL',excerpt:'PRIVATE-EXCERPT'},{id:'code',type:'code',language:'js',source:'PRIVATE-CODE'},
    {id:'display',type:'display',relationPartId:'review',layout:'relation',target:ref},
  ];
  const target:NativeMessageView={...vote,id:'m',relationType:null,kind:'TEXT',content:'ORIGINAL',payload:{},sourceRefs:[],sourceMessageId:null,targetRefs:[],declaredTargetRefs:[],parts:[{id:'body',type:'text',text:'ORIGINAL'}],moderation:summary};
  const reason=(id:string,body:string,extra:Part[]=[]):NativeMessageView=>({...target,id,content:body,moderation:undefined,
    parts:[{id:'body',type:'text',text:body},reviewContextPart(scope),reviewReasonPart({messageId:vote.id,revision:1}),...extra]});
  const visible=reason('plain','独立的程序意见'),toHide=reason('reason','PRIVATE-OLD-REASON');
  visible.content='PRIVATE-LAST-KNOWN-RENDERING';
  const viaDisplay=reason('quoted','PRIVATE-DISPLAY',[{id:'d',type:'display',relationPartId:'r',layout:'relation',target:ref}]);
  const viaRole=reason('embedded','PRIVATE-ROLE',[{id:'r',type:'relation',relation:'review-context',roles:{target:[{id:'to',reference:scope}],source:[{id:'from',reference:ref}]}}]);
  const viaAlias={...reason('cached','PRIVATE-ALIAS'),targetRefs:vote.targetRefs};
  const prior=which==='original'?target:toHide;
  const hidden={...prior,content:'',parts:prior.parts.filter(part=>part.type==='relation'),restricted:true};
  const before={...detail,target,records:[vote,visible,toHide,viaDisplay,viaRole,viaAlias],snapshot:{...target,parts:[{id:'body',type:'text',text:'OLD-SNAPSHOT'}]} as unknown as ReviewDetail['snapshot']};
  const next=applyReviewSnapshots(before,[{scope:{messageId:null,title:'公论'},sequence:3,users:[],stakes:{},tagCounts:{},attentionUsers:{},messages:[hidden],relations:[]}]);
  expect(next.records.map(row=>row.id)).toEqual(['vote','plain','reason']);
  expect(next.records.find(row=>row.id==='plain')?.content).toBe('独立的程序意见');
  if(which==='original')expect(next.snapshot).toBeUndefined();else expect(next.records.find(row=>row.id==='reason')?.restricted).toBe(true);
  const cleaned=next.records.find(row=>row.id==='vote')!;
  expect(cleaned.payload).toEqual({caseId:'c',reviewRound:1,verdict:'reject'});
  expect(JSON.stringify(cleaned)).not.toMatch(/PRIVATE|secret-source|partId|range/);
  const model=convertMessagesToDemoModel([vote],[vote].filter(isRelationView));
  expect(JSON.stringify(model)).not.toMatch(/PRIVATE|secret-source|partId|range/);
  expect(model.edges).toHaveLength(1);
  expect(model.edges[0]).toMatchObject({from:{messageId:'anon:vote'},to:{messageId:'m',selection:{kind:'whole'}}});
});
it('clears a previous personal rejection when a snapshot opens a new review round',()=>{
  const before={...summary,round:1,viewerVote:{messageId:'old-vote',verdict:'reject' as const}};
  const next={...summary,round:2,status:'appeal' as const};
  const target:NativeMessageView={...record('m','author','pass','正文'),kind:'TEXT',relationType:null,payload:{},targetRefs:[],moderation:next};
  const updated=applyReviewSnapshots({...detail,summary:before,target:{...target,moderation:before}},[
    {scope:{messageId:null,title:'公论'},sequence:2,users:[],stakes:{},tagCounts:{},attentionUsers:{},messages:[target],relations:[]},
  ]);
  expect(updated.summary.viewerVote).toBeUndefined();expect(updated.target?.moderation?.viewerVote).toBeUndefined();
  expect(updated.summary.round).toBe(2);
});
it('shares review loading between the summary and arbitration and leaves unchanged poll results alone',async()=>{
  vi.useFakeTimers({toFake:['Date','setInterval','clearInterval','setTimeout','clearTimeout']});
  const onRecords=vi.fn().mockResolvedValue(undefined),onSummary=vi.fn();
  let available=100;
  api.getReview.mockImplementation(async()=>({...detail,records:[],available:++available}));
  function SharedReview(){
    const review=useReviewDetail('m');
    return <ReviewDetailContext.Provider value={review}><ReviewPanel messageId="m" revision={1} onRecords={onRecords}/></ReviewDetailContext.Provider>;
  }
  window.addEventListener('review-summary',onSummary);
  const view=render(<SharedReview/>);
  try{
    await act(async()=>{});
    expect(api.getReview).toHaveBeenCalledTimes(1);
    const notifications=onRecords.mock.calls.length;
    await act(()=>vi.advanceTimersByTimeAsync(45_000));
    expect(api.getReview).toHaveBeenCalledTimes(4);
    expect(onRecords).toHaveBeenCalledTimes(notifications);
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button',{name:'投票'})).toBeEnabled();
  }finally{view.unmount();window.removeEventListener('review-summary',onSummary);}
});
it('stops review polling while its canvas is retained in the navigation cache',async()=>{
  vi.useFakeTimers({toFake:['Date','setInterval','clearInterval','setTimeout','clearTimeout']});
  const view=render(<RecentWorkbenchViews viewKey="review"><ReviewPanel messageId="m"/></RecentWorkbenchViews>);
  await act(async()=>{});
  expect(api.getReview).toHaveBeenCalledTimes(1);
  const signal=api.getReview.mock.calls[0][1] as AbortSignal;
  view.rerender(<RecentWorkbenchViews viewKey="other"><p>其他页面</p></RecentWorkbenchViews>);
  expect(signal.aborted).toBe(true);
  await act(()=>vi.advanceTimersByTimeAsync(45_000));
  expect(api.getReview).toHaveBeenCalledTimes(1);
  view.rerender(<RecentWorkbenchViews viewKey="review"><ReviewPanel messageId="m"/></RecentWorkbenchViews>);
  await act(async()=>{});
  expect(api.getReview).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button',{name:'投票'})).toBeEnabled();
});
it('ignores a late review response after changing the reviewed message',async()=>{
  let finish!:(value:ReviewDetail)=>void;
  api.getReview.mockImplementationOnce(()=>new Promise<ReviewDetail>(resolve=>{finish=resolve;}));
  const onRecords=vi.fn().mockResolvedValue(undefined);
  const view=render(<ReviewPanel messageId="old" onRecords={onRecords}/>);
  const signal=api.getReview.mock.calls[0][1] as AbortSignal;
  view.rerender(<ReviewPanel messageId="m" onRecords={onRecords}/>);
  await act(async()=>{});
  const calls=onRecords.mock.calls.length;
  await act(()=>finish({...detail,summary:{...summary,messageId:'old'},records:[record('late','u','reject','迟到的旧消息理由')]}));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText('迟到的旧消息理由')).not.toBeInTheDocument();
  expect(onRecords).toHaveBeenCalledTimes(calls);
});
it('shows the reviewed version and its records to a reader and keeps the review form available',async()=>{
  const target:NativeMessageView={...record('m','author','pass','待审正文'),kind:'TEXT',relationType:null,payload:{},parts:[{id:'body',type:'text',text:'待审正文'}]};
  const review=record('r','u','pass','支持公开的理由'),onRecords=vi.fn().mockResolvedValue(undefined);
  api.getReview.mockResolvedValue({...detail,target,records:[review],stakes:[stake(review)]});
  render(<ReviewPanel messageId="m" onRecords={onRecords}/>);
  expect(await screen.findByRole('button',{name:'投票'})).toBeEnabled();
  expect(screen.getByText('u')).toBeVisible();
  expect(onRecords).toHaveBeenLastCalledWith(['r'],target);
});
it.each([
  ['login-required','登录后，只要能阅读被审核消息'],['closed','本轮审核窗口已结束'],['content-restricted','当前无权查看被审核正文'],
] as const)('explains the %s reason when content visibility does not grant review eligibility',async(reviewEligibility,reason)=>{
  api.getReview.mockResolvedValue({...detail,canReview:false,canAppeal:false,canSettle:false,reviewEligibility});
  render(<ReviewPanel messageId="m"/>);
  expect(await screen.findByText(new RegExp(reason))).toBeVisible();
  expect(screen.queryByRole('button',{name:'投票'})).not.toBeInTheDocument();
});
it('places separate clickable review statistics and arbitration before truth and value',()=>{
  const open=vi.fn(),arbitrate=vi.fn();const {container}=render(<ModerationContext.Provider value={{summaries:new Map([['m',{...summary,pass:10,reject:2}]]),open,arbitrate}}><MessageSettlementActions messageId="m" onTruth={vi.fn()} onValue={vi.fn()}/></ModerationContext.Provider>);
  expect([...container.querySelectorAll('button')].map(button=>button.title)).toEqual(['查看审核通过与审核不通过汇总','查看审核通过与审核不通过汇总','审核仲裁','真假仲裁','价值仲裁']);
  const marks:string[]=[];
  for(const [label,points,color] of [['通过',10,'var(--ink-4ade80)'],['不通过',2,'var(--ink-f87171)']] as const){
    const button=screen.getByRole('button',{name:`审核${label} ${points} 点，查看记录`});
    const tally=within(button).getByText(String(points)).parentElement!;
    const mark=tally.querySelector('svg')!;
    expect(mark).toHaveAttribute('aria-hidden','true');
    marks.push(mark.innerHTML);
    expect(tally.style.color).toBe(color);
    fireEvent.click(button);expect(open).toHaveBeenLastCalledWith('m',1);
  }
  expect(marks[0]).not.toBe(marks[1]);
  fireEvent.click(screen.getByRole('button',{name:/审核仲裁：/}));expect(arbitrate).toHaveBeenCalledWith('m',{messageId:'m',revision:1});expect(open).toHaveBeenCalledTimes(2);
});
it('opens each source settlement on the clicked card using the source revision and public financial entries',async()=>{
  const open=vi.fn(),arbitrate=vi.fn(),address={messageId:'source',revision:3};
  const source={...summary,...address,reject:20,status:'rejected' as const,finalized:true};
  const cast=record('vote','投票人','reject','PRIVATE INPUT');
  const hidden={...cast,id:'source',revision:3,content:'',parts:[],restricted:true};
  api.getReview.mockResolvedValue({...detail,summary:source,target:hidden,stakes:[stake(cast)],canReview:false,canSettle:false});
  render(<ModerationContext.Provider value={{summaries:new Map(),sourcesFor:()=>[source],open,arbitrate,activeId:'quote',activeTarget:address}}>
    <MessageSettlementActions messageId="quote"/><ReviewPanel messageId="quote" revision={1}/>
  </ModerationContext.Provider>);
  const shield=screen.getByRole('button',{name:'审核仲裁：审核不通过（来源 source 第 3 版）'});
  expect(shield).toHaveAttribute('aria-expanded','true');
  fireEvent.click(shield);expect(arbitrate).toHaveBeenCalledWith('quote',address);
  fireEvent.click(screen.getByRole('button',{name:'审核通过 0 点，查看记录（来源 source 第 3 版）'}));
  expect(open).toHaveBeenCalledWith('source',3);
  const entries=await screen.findByRole('list',{name:'审核押注记录'});
  expect(api.getReview).toHaveBeenCalledWith('source',expect.any(AbortSignal),3);
  expect(within(entries).getByText('投票人')).toBeVisible();
  expect(screen.queryByText('审核原文')).toBeNull();
  expect(screen.queryByText('PRIVATE INPUT')).toBeNull();
  expect(screen.queryByRole('button',{name:'投票'})).toBeNull();
  const self={...stake(cast),sourceMessageId:hidden.id,revision:hidden.revision,kind:'self' as const};
  const page:WorkbenchSnapshot={scope:{messageId:null,title:'公论'},sequence:3,users:[],stakes:{},tagCounts:{},attentionUsers:{},messages:[hidden],relations:[]};
  const refreshed=applyReviewSnapshots({...detail,summary:source,target:hidden,stakes:[self]},[page]);
  expect(refreshed.stakes).toEqual([self]);
});
it('loads the historical source settlement even when the current version of the same message is already open',async()=>{
  api.getReview.mockImplementation(async (_id:string,_signal:AbortSignal,revision?:number)=>({
    ...detail,summary:{...summary,revision:revision??3,caseId:'case-'+(revision??3)},stakes:[stake(record('vote','第'+(revision??3)+'版参与者','reject',''))],
  }));
  function View(){
    const shared=useReviewDetail('m');
    return <ModerationContext.Provider value={{summaries:new Map(),open:vi.fn(),arbitrate:vi.fn(),activeId:'quote',activeTarget:{messageId:'m',revision:1}}}>
      <ReviewDetailContext.Provider value={shared}><ReviewPanel messageId="quote" revision={2}/></ReviewDetailContext.Provider>
    </ModerationContext.Provider>;
  }
  render(<View/>);
  expect(await screen.findByText('第1版参与者')).toBeVisible();
  expect(screen.queryByText('第3版参与者')).toBeNull();
});
it('reads archived counts and opens only a case whose records were saved in the file',()=>{
  const open=vi.fn(),source={...summary,caseId:'old',messageId:'origin',revision:4,pass:1,reject:12};
  render(<LocalReviewRecordsContext.Provider value={{summaries:new Map([['m',summary]]),sourcesFor:()=>[source],open,
    available:new Set([JSON.stringify(['origin',4])])}}>
    <MessageSettlementActions messageId="m"/>
  </LocalReviewRecordsContext.Provider>);
  expect(screen.getByLabelText('审核通过 0 点')).toBeVisible();
  expect(screen.queryByRole('button',{name:'审核通过 0 点，查看记录'})).toBeNull();
  expect(screen.queryByRole('button',{name:/审核仲裁/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'审核不通过 12 点，查看记录（来源 origin 第 4 版）'}));
  expect(open).toHaveBeenCalledWith('origin',4);
  expect(api.getReview).not.toHaveBeenCalled();
});
it('projects every original review into discussion regions without merging reasons or changing native records',()=>{
  const records=[record('old','a','reject','旧理由',1),record('r1','a','pass','有依据',2),record('r2','b','pass','有依据',3),
    record('r3','c','reject','缺少依据',4),record('last-round','d','pass','上一轮',5,2)];
  const wrongCase={...record('wrong','z','reject','其他版本',6),parts:record('wrong','z','reject','其他版本',6).parts.map(part=>part.type==='data'?{...part,value:{caseId:'other',verdict:'reject'}}:part)};
  expect(recordsForReview([...records,records[0]!,wrongCase],summary)).toEqual(records);
  const {edges}=convertMessagesToDemoModel(records,records.filter(isRelationView));
  const before=JSON.stringify({records,edges});
  const projected=projectReviewDiscussionEdges(edges,records);
  expect(projected.map(edge=>[edge.relationMessageId,edge.relationType])).toEqual([
    ['old','review-reject'],['r1','review-pass'],['r2','review-pass'],['r3','review-reject'],['last-round','review-pass'],
  ]);
  expect(projected.map(edge=>[edge.id,edge.to])).toEqual(edges.map(edge=>[edge.id,edge.to]));
  expect(JSON.stringify({records,edges})).toBe(before);
});
it('lets an old pending settlement distribute immediately and blocks an unfunded appeal',async()=>{
  api.getReview.mockResolvedValue({...detail,available:16,costs:{protocol:1,reviewMinimum:2,appealFee:6,appealDeposit:10,appealTotal:17},
    summary:{...summary,status:'rejected',provisional:true,releaseAt:new Date(Date.now()+60_000).toISOString()}});
  render(<ReviewPanel messageId="m" onRecords={vi.fn().mockResolvedValue(undefined)}/>);
  expect(await screen.findByRole('button',{name:'投票'})).toBeEnabled();
  expect(screen.getByLabelText('投票投入点数')).toHaveValue(2);
  expect(screen.getByText(/本次复核需 35 点/)).toBeVisible();
  expect(screen.getByRole('button',{name:'申请复核'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'结算'})).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'结算'}));
  expect(screen.getByRole('dialog',{name:'确认结算'})).toHaveTextContent('确认后立即分配');
});
it.each([['approved','reject','不通过'],['rejected','pass','通过']] as const)('shows and submits the %s appeal self-stake side without adding a reviewer',async(status,verdict,label)=>{
  const value={...detail,canReview:false,canSettle:false,appealVerdict:verdict,available:100,
    summary:{...summary,status,pass:10,reject:0,selfPass:10,selfReject:0,passReviewers:0,rejectReviewers:0}};
  api.getReview.mockResolvedValue(value);
  render(<ReviewPanel messageId="m"/>);
  expect(await screen.findByText(new RegExp(`自押${label} 10`))).toBeVisible();
  expect(screen.getByText('含自押 10 点')).toBeVisible();
  expect(screen.getByText('投票权重（按累计押注点数计算，含自押）')).toBeVisible();
  expect(screen.queryByText(/至少.*人形成多数|第.*级|本轮投票人数/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('复核理由'),{target:{value:'申请相反结论'}});
  fireEvent.click(screen.getByRole('button',{name:'申请复核'}));
  await waitFor(()=>expect(api.sendReviewAction).toHaveBeenCalledWith(value,'review-appeal','申请相反结论',verdict,undefined));
  await screen.findByText('已记录本次审核操作');
});
it('records the reason and funded review, while a rejected author sees appeal controls only',async()=>{
  const records=vi.fn().mockResolvedValue(undefined),open=vi.fn();const rendered=render(<ModerationContext.Provider value={{summaries:new Map([['m',summary]]),open,arbitrate:vi.fn()}}><ReviewPanel messageId="m" onRecords={records}/></ModerationContext.Provider>);
  fireEvent.click(await screen.findByText('填写审核理由（可选）'));
  fireEvent.change(screen.getByLabelText('审核理由'),{target:{value:'理由保存在记录中'}});
  fireEvent.change(screen.getByLabelText('投票投入点数'),{target:{value:'4'}});
  fireEvent.click(screen.getByRole('button',{name:'投票'}));
  await waitFor(()=>expect(api.sendReviewAction).toHaveBeenCalledWith(detail,'review','理由保存在记录中','pass',4));
  await screen.findByText('投票已记录');expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole('region',{name:'审核仲裁'})).toBeVisible();
  expect(screen.queryByRole('button',{name:'查看审核记录'})).not.toBeInTheDocument();rendered.unmount();
  api.getReview.mockResolvedValue({...detail,summary:{...summary,status:'rejected'},canReview:false,canSettle:false});
  render(<ReviewPanel messageId="m" onRecords={records}/>);
  expect(await screen.findByRole('button',{name:'申请复核'})).toBeEnabled();expect(screen.queryByRole('button',{name:'投票'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'申请复核'}));expect(await screen.findByRole('alert')).toHaveTextContent('请填写复核理由');
});
it('quotes a reason under the current publication policy and keeps plain votes affordable',async()=>{
  api.getReview.mockResolvedValue({...detail,canAppeal:false,available:9,costs:{protocol:2,reviewMinimum:2,appealFee:6,appealDeposit:10,appealTotal:18,reasonFee:3,reasonDeposit:5,reasonTotal:11}});
  render(<ReviewPanel messageId="m"/>);
  const vote=await screen.findByRole('button',{name:'投票'});
  expect(vote).toBeEnabled();
  fireEvent.click(screen.getByText('填写审核理由（可选）'));
  fireEvent.change(screen.getByLabelText('审核理由'),{target:{value:'理由'}});
  expect(screen.getByText(/理由独立发布，需 11 点/)).toBeVisible();
  expect(screen.getByText(/本次投票共需 15 点/)).toBeVisible();
  expect(vote).toBeDisabled();
  fireEvent.change(screen.getByLabelText('审核理由'),{target:{value:' '}});
  expect(vote).toBeEnabled();
});
it.each(['pass','reject'] as const)('submits the selected %s review through the shared vote form and stays in arbitration',async verdict=>{
  let finish!:(value:unknown)=>void;
  api.sendReviewAction.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const open=vi.fn();
  render(<ModerationContext.Provider value={{summaries:new Map([['m',summary]]),open,arbitrate:vi.fn()}}><ReviewPanel messageId="m"/></ModerationContext.Provider>);
  const direction=await screen.findByRole('combobox',{name:'投票方向'});
  expect(within(direction).getAllByRole('option').map(option=>option.textContent)).toEqual(['通过（PRO）','不通过（CON）']);
  fireEvent.change(direction,{target:{value:verdict}});
  const amount=screen.getByRole('spinbutton',{name:'投票投入点数'});
  expect(amount).toHaveAttribute('min','2');
  fireEvent.change(amount,{target:{value:'5'}});
  const vote=screen.getByRole('button',{name:'投票'});
  fireEvent.click(vote);fireEvent.click(vote);
  expect(api.sendReviewAction).toHaveBeenCalledExactlyOnceWith(detail,'review','',verdict,5);
  expect(direction).toBeDisabled();expect(amount).toBeDisabled();expect(vote).toBeDisabled();
  const posted=record('posted','u',verdict,'');posted.spending.reviewWager=5;
  api.getReview.mockResolvedValue({...detail,records:[posted],stakes:[stake(posted)]});
  await act(()=>finish({id:posted.id,relationType:'REVIEW'}));
  expect(await screen.findByText('投票已记录')).toBeVisible();
  expect(screen.getByText(`${verdict==='pass'?'PRO':'CON'} 5点`)).toBeVisible();
  expect(amount).toHaveValue(2);expect(direction).toHaveValue(verdict);
  expect(open).not.toHaveBeenCalled();expect(api.getReview).toHaveBeenCalledTimes(2);
});
it.each([false,true])('confirms review settlement before sending the finalize=%s action',async finalizedPhase=>{
  const value={...detail,canReview:false,canAppeal:false,summary:{...summary,pass:14,reject:4,passReviewers:1,rejectReviewers:3,
    ...(finalizedPhase?{status:'approved' as const,releaseAt:'2020-01-01T00:00:00Z'}:{})}};
  api.getReview.mockResolvedValue(value);
  render(<ReviewPanel messageId="m"/>);
  fireEvent.click(await screen.findByRole('button',{name:'结算'}));
  const confirmation=screen.getByRole('dialog',{name:'确认结算'});
  expect(confirmation).toHaveTextContent('通过方押注 14 点，不通过方押注 4 点');
  expect(confirmation).toHaveTextContent('当前结果：通过（PRO）');
  expect(confirmation).not.toHaveTextContent('人形成多数');
  expect(api.sendReviewAction).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole('button',{name:'取消'}));
  expect(api.sendReviewAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'结算'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'确认结算'})).getByRole('button',{name:'确认结算'}));
  await screen.findByText('已记录本次审核操作');
  expect(api.sendReviewAction).toHaveBeenCalledExactlyOnceWith(value,finalizedPhase?'review-finalize':'review-settle','',undefined,undefined);
  expect(screen.queryByRole('dialog',{name:'确认结算'})).not.toBeInTheDocument();
});
it('hands the confirmed rejection back to the workbench after refreshing the settlement result',async()=>{
  const onSettled=vi.fn(),value={...detail,summary:{...summary,pass:10,reject:16}};
  const completed={...value,canReview:false,canSettle:false,canAppeal:false,
    summary:{...value.summary,status:'rejected' as const,finalized:true}};
  let finish!:(value:ReviewDetail)=>void;
  api.getReview.mockResolvedValueOnce(value).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  render(<ModerationContext.Provider value={{summaries:new Map(),open:vi.fn(),arbitrate:vi.fn(),onSettled}}><ReviewPanel messageId="m"/></ModerationContext.Provider>);
  fireEvent.click(await screen.findByRole('button',{name:'结算'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'确认结算'})).getByRole('button',{name:'确认结算'}));
  await waitFor(()=>expect(api.getReview).toHaveBeenCalledTimes(2));
  expect(onSettled).not.toHaveBeenCalled();
  await act(()=>finish(completed));
  expect(onSettled).toHaveBeenCalledExactlyOnceWith(completed.summary);
  expect(screen.getByRole('status')).toHaveTextContent('结算完成：审核不通过');
  expect(screen.getByRole('button',{name:'已结算'})).toBeDisabled();
});
it.each(['submit','refresh'] as const)('keeps the current review open when settlement %s fails',async failure=>{
  const onSettled=vi.fn();
  if(failure==='submit')api.sendReviewAction.mockRejectedValueOnce(new Error('提交失败'));
  else api.getReview.mockResolvedValueOnce(detail).mockRejectedValueOnce(new Error('网络中断'));
  render(<ModerationContext.Provider value={{summaries:new Map(),open:vi.fn(),arbitrate:vi.fn(),onSettled}}><ReviewPanel messageId="m"/></ModerationContext.Provider>);
  fireEvent.click(await screen.findByRole('button',{name:'结算'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'确认结算'})).getByRole('button',{name:'确认结算'}));
  expect(await screen.findByText(failure==='submit'?'提交失败':'操作已获服务器确认，但最新数据读取失败。请刷新查看，勿重复提交。')).toBeVisible();
  expect(onSettled).not.toHaveBeenCalled();
});
it('explains tied stake refunds and lets an undecided review be appealed on the selected side',async()=>{
  const value={...detail,canReview:false,canSettle:false,available:100,
    summary:{...summary,status:'unknown' as const,pass:10,reject:10,finalized:true,passReviewers:0,rejectReviewers:1}};
  api.getReview.mockResolvedValue(value);
  render(<ReviewPanel messageId="m"/>);
  expect(await screen.findByText(/当前平局，结算结果为未定/)).toBeVisible();
  expect(screen.getByRole('button',{name:'已结算'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('复核自押方向'),{target:{value:'reject'}});
  fireEvent.change(screen.getByLabelText('复核理由'),{target:{value:'继续审核'}});
  fireEvent.click(screen.getByRole('button',{name:'申请复核'}));
  await waitFor(()=>expect(api.sendReviewAction).toHaveBeenCalledWith(value,'review-appeal','继续审核','reject',undefined));
});
it('toggles a personal rejection for all body parts and resets after a new vote',()=>{
  const target={id:'m',revision:1,kind:'normal' as const,author:'author',createdAt:'',content:'正文一\n正文二',
    parts:[{id:'first',type:'text' as const,text:'正文一'},{id:'second',type:'text' as const,text:'正文二'}],
    moderation:{...summary,viewerVote:{messageId:'vote-1',verdict:'reject' as const}}};
  const click=vi.fn(),open=vi.fn();
  const view=render(<MessageCard msg={target} ctx={{}} onClick={click}/>,{wrapper:({children})=>
    <ModerationContext.Provider value={{summaries:new Map(),open,arbitrate:vi.fn()}}>{children}</ModerationContext.Provider>});
  fireEvent.click(screen.getByRole('button',{name:'查看审核记录'}));
  expect(open).toHaveBeenCalledWith('m',1);
  expect(screen.queryByText('正文一')).not.toBeInTheDocument();
  expect(screen.queryByText('正文二')).not.toBeInTheDocument();
  expect(view.container.querySelectorAll('[data-content-mask]')).toHaveLength(1);
  const showBody=screen.getByRole('button',{name:'你已投不通过，点击展开正文'});
  expect(showBody).toHaveTextContent('展开正文');
  fireEvent.click(showBody);
  expect(screen.getByText('正文一')).toBeVisible();expect(screen.getByText('正文二')).toBeVisible();expect(click).not.toHaveBeenCalled();
  expect(screen.getAllByRole('button',{name:'重新遮挡正文'})).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'重新遮挡正文'}));
  expect(screen.queryByText('正文一')).not.toBeInTheDocument();expect(screen.queryByText('正文二')).not.toBeInTheDocument();
  expect(view.container.querySelectorAll('[data-content-mask]')).toHaveLength(1);expect(click).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'你已投不通过，点击展开正文'}));
  expect(screen.getByText('正文一')).toBeVisible();
  view.rerender(<MessageCard msg={{...target,moderation:{...target.moderation,viewerVote:{messageId:'vote-2',verdict:'reject'}}}} ctx={{}}/>);
  expect(screen.queryByText('正文一')).not.toBeInTheDocument();
  view.rerender(<MessageCard msg={{...target,moderation:{...target.moderation,viewerVote:{messageId:'vote-3',verdict:'pass'}}}} ctx={{}}/>);
  expect(screen.getByText('正文一')).toBeVisible();
});
it('never reveals server-restricted content through the personal cover',()=>{
  const open=vi.fn(),target={id:'m',kind:'normal' as const,author:'author',createdAt:'',content:'PRIVATE',restricted:true,
    moderation:{...summary,viewerVote:{messageId:'vote',verdict:'reject' as const}}};
  const view=render(<ModerationContext.Provider value={{summaries:new Map(),open,arbitrate:vi.fn()}}><MessageCard msg={target} ctx={{}}>PRIVATE CHILD</MessageCard></ModerationContext.Provider>);
  expect(view.container).not.toHaveTextContent('PRIVATE');
  const openRecord=screen.getByRole('button',{name:'正文已遮挡，查看审核记录'});
  expect(openRecord).toHaveTextContent('查看审核记录');
  fireEvent.click(openRecord);
  expect(open).toHaveBeenCalledWith('m',1);expect(view.container).not.toHaveTextContent('PRIVATE');
});
it('removes cached relation payloads when a message becomes restricted',()=>{
  const store=new WorkbenchStore(),user={id:'u',username:'用户',createdAt:''};
  const message={id:'m',revision:1,kind:'RELATION',contentType:'TEXT' as const,content:'PRIVATE',parts:[],createdBy:user,createdAt:'',relationType:'TAG',payload:{label:'PRIVATE'},sourceMessageId:null,targetRefs:[]};
  const page:WorkbenchSnapshot={sequence:1,scope:{messageId:null,title:'公论'},messages:[message],relations:[message],users:[user],stakes:{},tagCounts:{},attentionUsers:{}};
  const {payload:_privatePayload,...hidden}=message;
  store.apply(page);store.apply({...page,sequence:2,messages:[{...hidden,kind:'TEXT',content:'审核不通过',relationType:null,restricted:true}],relations:[]});
  expect(store.snapshot().relations).toEqual([]);expect(JSON.stringify(store.snapshot())).not.toContain('PRIVATE');
  store.apply(page);expect(JSON.stringify(store.snapshot())).not.toContain('PRIVATE');
});
it('keeps a restricted review record navigable without drawing its private edges',()=>{
  const hidden={...record('settlement','reviewer','reject',''),restricted:true,relationType:'REVIEW_RECORD',payload:{},
    parts:[{id:'restricted-body',type:'text' as const,text:''},
      {id:'review-attachment',type:'relation' as const,relation:'review-record',roles:{target:[{id:'target',reference:{messageId:'m',revision:1}}]}}]};
  const projected=convertMessagesToDemoModel([hidden],[hidden]);
  expect(projected.messages).toEqual([expect.objectContaining({id:'settlement',restricted:true,content:'',targetRefs:hidden.targetRefs})]);
  expect(projected.edges).toEqual([]);
});
it('renders a category with whole-message addresses for redacted members after switching accounts',()=>{
  const category={...record('category','author','pass','公开分类'),relationType:'CLASSIFY',payload:{title:'公开分类'},parts:[],
    targetRefs:[{kind:'message',messageId:'m',restricted:true,reference:{messageId:'m'}},{kind:'message',messageId:'visible'}]};
  const snapshot={scope:{messageId:null,title:'公论'},sequence:1,users:[],stakes:{},tagCounts:{},attentionUsers:{},
    messages:[category],relations:[category]} as unknown as WorkbenchSnapshot;
  const projected=projectWorkbenchSnapshot(snapshot);
  const view=renderHook(()=>useMessageWindow(projected.messages,projected.edges,true,'redacted-members',[]));
  expect(projected.edges.map(edge=>edge.to.messageId)).toEqual(['m','visible']);
  expect(view.result.current.messages.map(message=>message.id)).toContain('category');
  expect(view.result.current.edges.every(edge=>typeof edge.to.messageId==='string')).toBe(true);
});
it.each([{messageId:'m',restricted:true},{messageId:'m',restricted:true,stakes:[{id:'s',restricted:true}]}])('loads previously cached restricted stake records without assuming their fields survived redaction',restricted=>{
  const snapshot={scope:{messageId:null,title:'公论'},sequence:1,relations:[],users:[],tagCounts:{},attentionUsers:{},
    messages:[{id:'m',kind:'TEXT',content:'审核不通过',restricted:true,parts:[],createdAt:'',createdBy:{id:'u',username:'用户',createdAt:''}}],
    stakes:{m:restricted}} as unknown as WorkbenchSnapshot;
  const projected=projectWorkbenchSnapshot(snapshot);
  expect(projected.messages).toHaveLength(1);expect(projected.bettors.m).toBe(0);
  expect(projected.counts.m).toEqual({truth:{pro:0,con:0},value:{pro:0,con:0}});
});
it('quotes review fees separately and converts whole-decision stances to the review investment category',()=>{
  const base={relationType:null,draftUnits:[],targetUnits:[],newMessageContent:'正文',stakeAmount:1,relStakeAmount:1} as const;
  const normal=calculateSendCost({...base,draftUnits:[],targetUnits:[]},1,DEFAULT_MODERATION_POLICY)!;
  expect(normal).toMatchObject({stakeTotal:1,reviewFeeTotal:6,reviewDepositTotal:10,reviewWagerTotal:0,total:18});
  const review={id:'r',parts:[{id:'decision',type:'relation' as const,relation:'review',roles:{}}]};
  expect(contributionTypeForTarget('agree',review,{messageId:'r'})).toBe('REVIEW');
  expect(contributionTypeForTarget('disagree',review,{messageId:'r',partId:'body'})).toBe('DISAGREE');
  const vote={...review,revision:3,kind:'relation' as const,author:'甲',createdAt:'',content:''};
  const fetched=new Map([['r',vote]]);
  expect(contributionTypeAtReference('agree',{messageId:'r',revision:3},new Map(),fetched)).toBe('REVIEW');
  expect(contributionTypeAtReference('agree',{messageId:'r',revision:2},new Map(),fetched)).toBe('AGREE');
  expect(contributionTypeAtReference('disagree',{messageId:'r',revision:3,partId:'body'},new Map(),fetched)).toBe('DISAGREE');
  expect(contributionTypeAtReference('agree',{messageId:'r',revision:3},new Map([['r',{...vote,restricted:true,parts:[]}]]),fetched)).toBe('AGREE');
  const converted=calculateSendCost({...base,relationType:'agree',relStakeAmount:2,draftUnits:[{messageId:'r'}],targetUnits:[],newMessageContent:'',relationContributionTypes:['REVIEW']},1,DEFAULT_MODERATION_POLICY)!;
  expect(converted).toMatchObject({stakeTotal:0,reviewFeeTotal:0,reviewDepositTotal:0,reviewWagerTotal:2,total:3});
  const direct=calculateSendCost({...base,relationType:'operations',secondaryRelationType:'review',scopeParentId:'category',draftUnits:[{messageId:'m'}],targetUnits:[],newMessageContent:'审核理由'},1,DEFAULT_MODERATION_POLICY)!;
  expect(direct).toMatchObject({messageCount:2,joinCount:0,refCount:0,stakeTotal:0,recommendationTotal:1,reviewFeeTotal:6,reviewDepositTotal:10,reviewWagerTotal:2,total:21});
  expect(direct.groups.map(group=>group.type)).toEqual(['REVIEW','REVIEW_REASON']);
});
