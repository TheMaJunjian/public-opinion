import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageDisplayHintsProvider, MessageDisplayMarker } from '../components/MessageDisplayHints';
import MessageCard from '../components/MessageCard';
import GraphView from '../components/GraphView';
import type { Message, Relation } from '../types';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds, convertMessagesToDemoModel } from '../utils/modelBridge';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { correctionRecordHint, deriveDisplayHints, getMessageDisplaySignature, getMessageDisplayParts, displayHintDestination, type DisplayHintsInput } from '../pages/workbench/model/displayHints';
import { getLatestUserReadStatusByMessageId } from '../pages/workbench/model/filters';

const user=(username:string)=>({id:username,username,createdAt:''});
const text=(id:string,content=id,author='bob'):Message=>({id,kind:'TEXT',content,contentType:'TEXT',createdAt:'2026-01-01',createdBy:user(author)});
const rel=(id:string,type:string,targets:string[]=[],source:string|null=null,date='2026-01-02',author='bob'):Relation=>({id,relationType:type,
  sourceMessageId:source,targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdAt:date,createdBy:user(author),payload:{title:id}});
function fixture(records:Message[],relations:Relation[],readStatus=new Map<string,'READ'|'UNREAD'>()):DisplayHintsInput {
  const model=convertMessagesToDemoModel(records,relations),username='alice';
  return {...model,relations,username,readStatus,personalEffect:deriveContainerEffect({...model,relations,username,stakeCounts:{}}),
    corrections:computeCorrectionVersions(model.messages,model.edges,computeEffectiveSuppressedRelIds(model.edges,model.messages,username),username)};
}

describe('computed display hints',()=>{
  it('distinguishes explicit unread, unmarked and own messages without creating records',()=>{
    const input=fixture([text('pending'),text('read'),text('mine','mine','alice'),text('marked','marked','alice')],[],new Map([['read','READ'],['marked','UNREAD']]));
    const before=JSON.stringify(input.messages),status=[...input.readStatus],{hints}=deriveDisplayHints(input);
    expect(hints.get('pending')).toMatchObject({unread:true,explicitlyUnread:false});
    expect(hints.get('read')?.unread).toBe(false);expect(hints.get('mine')?.unread).toBe(false);
    expect(hints.get('marked')).toMatchObject({unread:true,explicitlyUnread:true});
    expect(JSON.stringify(input.messages)).toBe(before);expect([...input.readStatus]).toEqual(status);
    expect(deriveDisplayHints({...input,username:null}).hints.get('pending')?.unread).toBe(false);
  });

  it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE'])('routes released %s members to their rejected container',type=>{
    const relations=[rel('A','CLASSIFY',['C']),rel('C',type),rel('old','JOIN',['m'],'A','2026-01-02'),
      rel('new','JOIN',['m'],'C','2026-01-03'),rel('opposition','DISAGREE',['C'],null,'2026-01-04')];
    relations[1].state={messageId:'C',revision:1,suppressed:true,supportCount:0,oppositionCount:1,recommendationTotal:0};
    const read=new Map<string,'READ'|'UNREAD'>(['A','C','old','new','m'].map(id=>[id,'READ'])),input=fixture([text('m')],relations,read);
    expect(input.personalEffect.ownership.direct('A').textIds.has('m')).toBe(true);
    for(const id of ['C','m','A'])expect(deriveDisplayHints(input).hints.get(id)).toMatchObject({unread:false,relatedUnreadIds:['opposition']});
    expect(displayHintDestination(input,'m')).toEqual({kind:'container',id:'C'});
    expect(displayHintDestination(input,'opposition')).toEqual({kind:'container',id:'C'});
    const preview={...input,displayEffect:deriveContainerEffect({...input,stakeCounts:{},assumption:{messageId:'C',side:'agree'}})};
    expect(deriveDisplayHints(preview).hints.get('C')).toMatchObject({matchesPersonal:false,matchesRecommended:false});
    read.set('opposition','READ');
    for(const id of ['C','m','A'])expect(deriveDisplayHints(input).hints.get(id)?.relatedUnreadIds).toEqual([]);
  });

  it('compares personal/recommended membership and routes JOIN to its container',()=>{
    const relations=[rel('A','CLASSIFY'),rel('B','CLASSIFY'),rel('old','JOIN',['m'],'A','2026-01-02'),
      rel('new','JOIN',['m'],'B','2026-01-03'),rel('choice','AGREE',['old'],null,'2026-01-04','alice')];
    const input=fixture([text('m')],relations),{hints}=deriveDisplayHints(input);
    expect(hints.get('m')).toMatchObject({source:'personal',different:true,personal:{parentIds:['A']},recommended:{parentIds:['B']}});
    expect(hints.get('old')).toMatchObject({personal:{membershipActive:true},recommended:{membershipActive:false},matchesRecommended:false});
    expect(hints.get('new')).toMatchObject({personal:{membershipActive:false},recommended:{membershipActive:true},matchesRecommended:false});
    expect(displayHintDestination(input,'new')).toEqual({kind:'container',id:'B'});
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()}>
      <MessageDisplayMarker messageId="old"/><MessageDisplayMarker messageId="new"/>
    </MessageDisplayHintsProvider>);
    const oldMarker=screen.getByRole('button',{name:/显示提示 old：.*统计无效/});
    expect(oldMarker).toHaveAccessibleName(/选择生效/);
    expect(oldMarker).toHaveStyle({color:'#86efac'});
    const newMarker=screen.getByRole('button',{name:/显示提示 new：.*统计生效/});
    expect(newMarker).toHaveAccessibleName(/选择无效/);
    expect(newMarker).toHaveStyle({color:'#fca5a5'});
    fireEvent.click(oldMarker);
    expect(screen.getByRole('tooltip')).toHaveTextContent('选择生效');
    expect(screen.getByRole('tooltip')).toHaveTextContent('统计无效');
    expect(screen.getByRole('img',{name:'选择与统计不一致'})).toHaveTextContent('≠');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent(/个人选择优先|当前对你|与我的选择|当前显示与统计结果/);
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('推荐');
  });

  it('compares a correction record with the adopted body and reuses correction history/view destinations',()=>{
    const relations=[rel('first','CORRECT',['m']),rel('second','CORRECT',['m'],null,'2026-01-03'),rel('choice','AGREE',['first'],null,'2026-01-04','alice')];
    relations[0].payload={correctionBeforeContent:'原文',correctionAfterContent:'我的版本'};
    relations[1].payload={correctionBeforeContent:'原文',correctionAfterContent:'推荐版本'};
    relations[1].state={messageId:'second',revision:1,suppressed:false,supportCount:3,oppositionCount:0,recommendationTotal:0};
    const input=fixture([text('m','原文')],relations),data=deriveDisplayHints(input);
    expect(correctionRecordHint(input,data,'first')).toMatchObject({matchesPersonal:true,matchesRecommended:false});
    expect(correctionRecordHint(input,data,'second')).toMatchObject({matchesPersonal:false,matchesRecommended:true});
    expect(displayHintDestination(input,'m')).toEqual({kind:'corrections',id:'first'});
    expect(displayHintDestination(input,'second',true)).toEqual({kind:'correction',id:'second'});
    const preview=computeCorrectionVersions(input.messages,input.edges,new Set(),input.username,{previewCorrectionId:'second'});
    expect(deriveDisplayHints({...input,displayCorrections:preview}).correctionHints.get('m')).toMatchObject({
      matchesPersonal:false,matchesRecommended:true,personal:{content:'我的版本'},recommended:{content:'推荐版本'},
    });
  });

  it('groups correction unread and body differences beside corrections without duplicating the classification hint',()=>{
    const category=rel('category','CLASSIFY'),before=fixture([], [category]);
    const read=rel('read','READ',['category'],null,'2026-01-03','alice');
    read.payload={readDisplay:{category:getMessageDisplaySignature(before,'category')!},readDisplayParts:{category:getMessageDisplayParts(before,'category')!}};
    const first=rel('first','CORRECT',['category'],null,'2026-01-04'),second=rel('second','CORRECT',['category'],null,'2026-01-05');
    first.payload={correctionBeforeContent:'category',correctionAfterContent:'修改一'};
    second.payload={correctionBeforeContent:'category',correctionAfterContent:'修改二'};
    const input=fixture([], [category,first,second,read],new Map([['category','READ']])),data=deriveDisplayHints(input);
    expect(data.hints.get('category')).toMatchObject({unread:false,relatedUnreadIds:[],readChanged:false,matchesRecommended:true});
    expect(data.correctionHints.get('category')).toMatchObject({unread:false,relatedUnreadIds:['second','first'],readChanged:true});
    const onView=vi.fn(),view=render(<MessageDisplayHintsProvider input={input} onView={onView}>
      <span>category<MessageDisplayMarker messageId="category" /></span>
      <span>✏更正 2<MessageDisplayMarker messageId="category" scope="corrections" /></span>
    </MessageDisplayHintsProvider>);
    expect(view.container.querySelectorAll('[data-display-hint-scope="corrections"]')).toHaveLength(1);
    const body=screen.getByRole('button',{name:/更正显示提示 category/});expect(body.getAttribute('aria-label')).toContain('有相关未读变动');
    expect(body.getAttribute('aria-label')).toContain('与上次已读不同');fireEvent.click(body);expect(onView).not.toHaveBeenCalled();
    view.rerender(<MessageDisplayHintsProvider input={{...input,readStatus:new Map([['category','UNREAD']])}} onView={onView}>
      <MessageDisplayMarker messageId="category" /><MessageDisplayMarker messageId="category" scope="corrections" />
    </MessageDisplayHintsProvider>);
    expect(screen.getByRole('button',{name:/^显示提示 category：已标为未读/})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:/^更正显示提示 category：有相关未读变动/})).toBeInTheDocument();
  });

  it('compares only an internal fingerprint attached to the latest explicit READ message',()=>{
    const before=fixture([text('m','当时正文')],[]),signature=getMessageDisplaySignature(before,'m')!;
    expect(signature).not.toContain('当时正文');
    const read=rel('read','READ',['m'],null,'2026-01-03','alice');read.payload={readDisplay:{m:signature}};
    const unchanged=fixture([text('m','当时正文')],[read]);
    expect(deriveDisplayHints(unchanged).hints.get('m')?.readChanged).toBe(false);
    expect(deriveDisplayHints(fixture([text('m','后来正文')],[read])).hints.get('m')?.readChanged).toBe(true);
    expect(deriveDisplayHints(before).hints.get('m')?.readChanged).toBeUndefined();
    const newer=rel('newer','READ',['m'],null,'2026-01-04','alice');
    newer.payload={readDisplay:{m:getMessageDisplaySignature(fixture([text('m','后来正文')],[]),'m')!}};
    expect(deriveDisplayHints(fixture([text('m','后来正文')],[newer,read])).hints.get('m')?.readChanged).toBe(false);
    const withoutCode={...newer,id:'newest',createdAt:'2026-01-05',payload:{}};
    expect(deriveDisplayHints(fixture([text('m','后来正文')],[read,withoutCode])).hints.get('m')?.readChanged).toBeUndefined();
  });

  it('detects arrangement order and layout changes without storing their content in the read annotation',()=>{
    const arrangement=rel('a','ARRANGE',['first','second']);arrangement.payload={targetLayout:'single-row'};
    const input=fixture([text('first'),text('second')],[arrangement]);
    const original=getMessageDisplaySignature(input,'a');
    expect(getMessageDisplaySignature(fixture([text('first'),text('second')],[{...arrangement,targetRefs:[...arrangement.targetRefs].reverse()}]),'a')).not.toBe(original);
    expect(getMessageDisplaySignature(fixture([text('first'),text('second')],[{...arrangement,payload:{targetLayout:'single-column'}}]),'a')).not.toBe(original);
  });

  it('keeps read annotations out of unread notifications and respects only the viewer’s own status',()=>{
    const relations=[rel('r','READ',['m'],null,'2026-01-02','alice'),rel('u','UNREAD',['m'],null,'2026-01-03','alice'),rel('other','READ',['m'],null,'2026-01-04','bob')];
    const status=getLatestUserReadStatusByMessageId(relations,item=>item.createdBy.username==='alice'),data=deriveDisplayHints(fixture([text('m')],relations,status));
    expect(status.get('m')).toBe('UNREAD');expect(data.hints.get('m')).toMatchObject({unread:true,explicitlyUnread:true,relatedUnreadIds:[]});
    for(const id of ['r','u','other'])expect(data.hints.has(id)).toBe(false);
  });
});

describe('shared display markers',()=>{
  it('only explains status without navigating, selecting the card or marking read',()=>{
    const input=fixture([text('m')],[]),onView=vi.fn(),onClick=vi.fn(),onMouseDown=vi.fn(),before=[...input.readStatus];
    render(<MessageDisplayHintsProvider input={input} onView={onView}><MessageCard msg={input.messages[0]} ctx={{}} onClick={onClick} onMouseDown={onMouseDown}/></MessageDisplayHintsProvider>);
    const marker=screen.getByRole('button',{name:/显示提示 m：待阅/});fireEvent.mouseDown(marker);fireEvent.click(marker);fireEvent.doubleClick(marker);
    expect(onView).not.toHaveBeenCalled();expect(onClick).not.toHaveBeenCalled();expect(onMouseDown).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();expect([...input.readStatus]).toEqual(before);
  });

  it('shows the same compact hint on hover and click, without navigation instructions',()=>{
    const input=fixture([text('m')],[]),onView=vi.fn();
    render(<MessageDisplayHintsProvider input={input} onView={onView}><MessageDisplayMarker messageId="m" /></MessageDisplayHintsProvider>);
    const marker=screen.getByRole('button',{name:/显示提示 m：待阅/});
    fireEvent.mouseEnter(marker);
    const tooltip=screen.getByRole('tooltip'),hintText=tooltip.textContent;
    expect(tooltip).toHaveTextContent('待阅，尚未标为已读');expect(tooltip).toHaveTextContent('选择生效');
    expect(tooltip).toHaveTextContent('统计生效');expect(tooltip).not.toHaveTextContent(/与我的选择|当前显示与统计结果|推荐|仅提示状态|不自动跳转|查看沿用/);
    expect(screen.getByRole('img',{name:'选择与统计一致'})).toHaveTextContent('=');
    expect(marker).toHaveAttribute('aria-describedby',tooltip.id);expect(marker).not.toHaveAttribute('title');
    fireEvent.mouseLeave(marker);expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(marker);expect(screen.getByRole('tooltip').textContent).toBe(hintText);
    fireEvent.mouseLeave(marker);expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(marker,{key:'Escape'});expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(marker);fireEvent.pointerDown(document.body);expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(marker);expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.blur(marker);expect(screen.queryByRole('tooltip')).toBeNull();expect(onView).not.toHaveBeenCalled();
  });

  it('offers a small View tag and shows consistency only in the existing hint',()=>{
    const input=fixture([text('m')],[]),onView=vi.fn();
    render(<MessageDisplayHintsProvider input={input} onView={onView}><MessageDisplayMarker messageId="m" viewTag/></MessageDisplayHintsProvider>);
    const tag=screen.getByRole('button',{name:/查看消息 m/});expect(tag).toHaveTextContent('查看');expect(tag.getAttribute('aria-label')).toContain('选择生效');
    fireEvent.click(tag);expect(onView).toHaveBeenCalledWith('m',expect.anything(),true);expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the arrangement message card when using the existing preview',()=>{
    const input=fixture([text('m')],[rel('arrangement','ARRANGE',['m'])]),noop=vi.fn();
    render(<MessageDisplayHintsProvider input={input} onView={noop}><GraphView messages={input.messages} edges={input.edges}
      draftUnits={[]} activeTextSelectId={null} lastClickedMessageId={null}
      comparisonSingle comparisonDisplay="agree" comparisonTargetId="arrangement"
      onMessageClick={noop} onMessageDoubleClick={noop} onTextMouseUp={noop} onEdgeLabelSingleClick={noop}
      onEdgeLabelDoubleClick={noop} onFragmentAnchorClick={noop} isFragmentSelected={()=>false}/></MessageDisplayHintsProvider>);
    expect(screen.getByRole('group',{name:'组织消息 arrangement'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:/显示提示 arrangement/}));expect(noop).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('img',{name:'选择与统计一致'})).toHaveTextContent('=');
  });
});
