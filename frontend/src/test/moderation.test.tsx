import {act,fireEvent,render,renderHook,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DEFAULT_MODERATION_POLICY,isRelationView,type Message,type ModerationSummary,type NativeMessageView,type ReviewStakeItem,type WorkbenchSnapshot} from '@gonglun/core';
import ReviewPanel from '../components/ReviewPanel';
import MessageSettlementActions from '../components/MessageSettlementActions';
import {ModerationContext} from '../components/ModerationContext';
import {WorkbenchStore} from '../data/workbench';
import {calculateSendCost} from '../hooks/useStakeCalculation';
import {contributionTypeForTarget} from '../pages/workbench/model/contributions';
import type {ReviewDetail} from '../api/client';
import {projectWorkbenchSnapshot} from '../utils/workbenchProjection';
import {applyReviewSnapshots,recordsForReview,projectReviewDiscussionEdges} from '../utils/reviewRecords';
import {ReviewDetailContext,useReviewDetail} from '../hooks/useReviewDetail';
import RecentWorkbenchViews from '../components/RecentWorkbenchViews';
import {convertMessagesToDemoModel} from '../utils/modelBridge';
import MessageCard from '../components/MessageCard';

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
  const page:WorkbenchSnapshot={scope:{messageId:null,title:'公论'},sequence:4,users:[],stakes:{},tagCounts:{},attentionUsers:{},
    messages:[{...target,revision:2,restricted:true,content:'另一版本'},other],relations:[other].filter(isRelationView)};
  const stakes:ReviewStakeItem[]=[{...stake(target),id:'review-self:m',kind:'self',amount:10}];
  expect(applyReviewSnapshots({...detail,target,stakes},[page])).toMatchObject({target,records:[],stakes});
  const hidden={...target,restricted:true,content:'内容暂时隐藏',parts:[{id:'restricted-body',type:'text' as const,text:'内容暂时隐藏'}]};
  expect(applyReviewSnapshots({...detail,target,stakes},[{...page,messages:[hidden],relations:[]}])).toMatchObject({target:hidden,stakes:[]});
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
it('provides the reviewed target to the canvas and removes private content when this assignment expires',async()=>{
  vi.useFakeTimers({toFake:['Date','setInterval','clearInterval','setTimeout','clearTimeout']});
  const snapshot={parts:[{id:'body',type:'text',text:'需要审核的正文'},{id:'label',type:'data',value:{label:'需要审核的标签'}}]} as Message;
  const target:NativeMessageView={...record('m','author','pass','需要审核的正文'),kind:'TEXT',relationType:null,payload:{},parts:snapshot.parts};
  const records=vi.fn().mockResolvedValue(undefined);
  api.getReview.mockResolvedValue({...detail,restricted:true,summary:{...summary,status:'appeal'},snapshot,target,records:[record('r','u','pass','支持公开的理由')],stakes:[stake(record('r','u','pass',''))],assignment:{expiresAt:new Date(Date.now()+1000).toISOString(),submittedAt:null,revokedAt:null}});
  await act(async()=>{render(<ReviewPanel messageId="m" onRecords={records}/>);});
  expect(screen.queryByText('需要审核的正文')).not.toBeInTheDocument();
  expect(screen.queryByText(/需要审核的标签/)).not.toBeInTheDocument();
  expect(screen.getByText('u')).toBeVisible();
  expect(records).toHaveBeenLastCalledWith(['r'],target);
  await act(()=>vi.advanceTimersByTimeAsync(1000));
  expect(screen.queryByText('需要审核的正文')).not.toBeInTheDocument();
  expect(screen.queryByText('支持公开的理由')).not.toBeInTheDocument();
  expect(screen.queryByRole('list',{name:'审核押注记录'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'投票'})).not.toBeInTheDocument();
  expect(screen.getByText(/临时阅读权限已收回/)).toBeVisible();
  expect(records).toHaveBeenLastCalledWith([],expect.objectContaining({id:'m',revision:1,restricted:true,content:'',parts:[{id:'restricted-body',type:'text',text:''}]}));
  expect(JSON.stringify(records.mock.lastCall)).not.toMatch(/需要审核的正文|需要审核的标签/);
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
  fireEvent.click(screen.getByRole('button',{name:'审核通过 10 点，查看记录'}));expect(open).toHaveBeenLastCalledWith('m');
  fireEvent.click(screen.getByRole('button',{name:'审核不通过 2 点，查看记录'}));expect(open).toHaveBeenLastCalledWith('m');
  fireEvent.click(screen.getByRole('button',{name:/审核仲裁：/}));expect(arbitrate).toHaveBeenCalledWith('m');expect(open).toHaveBeenCalledTimes(2);
});
it('keeps public review records visible after the reviewer assignment expires',async()=>{
  vi.useFakeTimers({toFake:['Date','setInterval','clearInterval','setTimeout','clearTimeout']});
  const snapshot={parts:[{id:'body',type:'text',text:'已经公开的正文'}]} as Message;
  const records=vi.fn().mockResolvedValue(undefined);
  api.getReview.mockResolvedValue({...detail,restricted:false,snapshot,records:[record('r','u','pass','公开审核理由')],stakes:[stake(record('r','u','pass',''))],assignment:{expiresAt:new Date(Date.now()+1000).toISOString(),submittedAt:null,revokedAt:null}});
  await act(async()=>{render(<ReviewPanel messageId="m" onRecords={records}/>);});
  await act(()=>vi.advanceTimersByTimeAsync(1000));
  expect(screen.queryByText('已经公开的正文')).not.toBeInTheDocument();
  expect(screen.getByText('u')).toBeVisible();expect(records).toHaveBeenLastCalledWith(['r']);
  expect(screen.getByRole('button',{name:'投票'})).toBeEnabled();
  expect(screen.getByText(/阅读和审核资格不受影响/)).toBeVisible();
});
it('keeps a submitted voluntary reviewer able to read and review after an old random assignment expires',async()=>{
  vi.useFakeTimers({toFake:['Date','setInterval','clearInterval','setTimeout','clearTimeout']});
  api.getReview.mockResolvedValue({...detail,restricted:true,readableWithoutAssignment:true,summary:{...summary,status:'appeal'},
    records:[record('r','u','pass','本轮参与者可见的理由')],stakes:[stake(record('r','u','pass',''))],assignment:{expiresAt:new Date(Date.now()+1000).toISOString(),submittedAt:null,revokedAt:null}});
  await act(async()=>{render(<ReviewPanel messageId="m"/>);});
  await act(()=>vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText('u')).toBeVisible();expect(screen.getByRole('button',{name:'投票'})).toBeEnabled();
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
  expect(screen.getByText(/本次复核需 17 点/)).toBeVisible();
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
  const click=vi.fn(),view=render(<MessageCard msg={target} ctx={{}} onClick={click}/>);
  expect(screen.queryByText('正文一')).not.toBeInTheDocument();
  expect(screen.queryByText('正文二')).not.toBeInTheDocument();
  expect(view.container.querySelectorAll('[data-content-mask]')).toHaveLength(1);
  expect(view.container.querySelector('[data-content-mask]')).toHaveTextContent('');
  fireEvent.click(screen.getByRole('button',{name:'你已投不通过，点击展开正文'}));
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
  fireEvent.click(screen.getByRole('button',{name:'正文已遮挡，查看审核记录'}));
  expect(open).toHaveBeenCalledWith('m');expect(view.container).not.toHaveTextContent('PRIVATE');
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
  const converted=calculateSendCost({...base,relationType:'agree',relStakeAmount:2,draftUnits:[{messageId:'r'}],targetUnits:[],newMessageContent:'',relationContributionTypes:['REVIEW']},1,DEFAULT_MODERATION_POLICY)!;
  expect(converted).toMatchObject({stakeTotal:0,reviewFeeTotal:0,reviewDepositTotal:0,reviewWagerTotal:2,total:3});
  const direct=calculateSendCost({...base,relationType:'operations',secondaryRelationType:'review',scopeParentId:'category',draftUnits:[{messageId:'m'}],targetUnits:[],newMessageContent:'审核理由'},1,DEFAULT_MODERATION_POLICY)!;
  expect(direct).toMatchObject({messageCount:1,joinCount:0,refCount:0,stakeTotal:0,reviewFeeTotal:0,reviewDepositTotal:0,reviewWagerTotal:2,total:3});
  expect(direct.groups.map(group=>group.type)).toEqual(['REVIEW']);
});
