import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageDisplayHintsProvider, MessageDisplayHintsScope, MessageDisplayMarker,useViewedBodyReference } from '../components/MessageDisplayHints';
import MessageCard from '../components/MessageCard';
import MessageReferenceControl from '../components/MessageReferenceControl';
import GraphView from '../components/GraphView';
import type { Message, Relation } from '../types';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds, convertMessagesToDemoModel } from '../utils/modelBridge';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { correctionRecordHint, deriveDisplayHints, getMessageDisplaySignature, getMessageDisplayParts, displayHintDestination, type DisplayHintsInput } from '../pages/workbench/model/displayHints';
import { getLatestUserReadStatusByMessageId } from '../pages/workbench/model/filters';
import {createDisplayHintWindow} from '../pages/workbench/model/displayHintWindow';
import {createCurrentContainerLookup} from '../pages/workbench/model/displayHintContainers';
import {readingMarksFor,deriveReadingProgress,influenceReadingMarks} from '../pages/workbench/model/readingProgress';
import type {ReadingMark} from '@gonglun/core';
import {withFixtureReadingMarks} from './readingFixture';
import {WorkbenchDrawingContext,createWorkbenchDrawingTasks} from '../context/WorkbenchDrawingContext';

function expandEffects(){
  for(const button of screen.queryAllByRole('button',{name:/^展开(?:未阅|已阅)影响/}))fireEvent.click(button);
  const effects=screen.queryByRole('region',{name:'相关影响'});
  for(const category of effects?.querySelectorAll<HTMLElement>('[data-influence-category]')??[]){
    const button=within(category).queryByRole('button',{name:/^展开/});if(button)fireEvent.click(button);
  }
}
function effectDetails(){expandEffects();return screen.getByRole('region',{name:'相关影响'});}
function effectButton(name:string|RegExp){expandEffects();return screen.getByRole('button',{name});}
const user=(username:string)=>({id:username,username,createdAt:''});
const text=(id:string,content=id,author='bob'):Message=>({id,kind:'TEXT',content,contentType:'TEXT',createdAt:'2026-01-01',createdBy:user(author)});
const rel=(id:string,type:string,targets:string[]=[],source:string|null=null,date='2026-01-02',author='bob'):Relation=>({id,relationType:type,
  sourceMessageId:source,targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdAt:date,createdBy:user(author),payload:{title:id}});
function fixture(records:Message[],relations:Relation[],readStatus=new Map<string,'READ'|'UNREAD'>()):DisplayHintsInput {
  const model=convertMessagesToDemoModel(records,relations),username='alice';
  return withFixtureReadingMarks({...model,relations,username,readStatus,personalEffect:deriveContainerEffect({...model,relations,username,stakeCounts:{}}),
    corrections:computeCorrectionVersions(model.messages,model.edges,computeEffectiveSuppressedRelIds(model.edges,model.messages,username),username)});
}

describe('computed display hints',()=>{
  it('lists received JOIN records only among members, without duplicating them or the container in automatic influences',async()=>{
    const input=fixture([text('member')],[rel('outer','CLASSIFY'),rel('container','CLASSIFY'),
      rel('parent-join','JOIN',['container'],'outer'),rel('member-join','JOIN',['member'],'container')]);
    const saved=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={saved}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 container：/}));
    const effects=effectDetails();
    expect(effects).not.toHaveTextContent('member-join');expect(effects).toHaveTextContent('被加入 · parent-join');
    expect(effects).not.toHaveTextContent('分类 · container');expect(effects).toHaveTextContent('未阅影响（1 条）');
    const members=screen.getByRole('region',{name:'成员消息'});
    expect(members.querySelector('[data-reading-join-record="member-join"]')).not.toBeNull();
    expect(within(members).getByRole('button',{name:'查看被加入目标 member'})).toBeVisible();
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'})));
    const marks=saved.mock.calls[0][0];
    expect(marks.some(mark=>mark.messageId==='member-join')).toBe(false);
    expect(marks).toContainEqual(expect.objectContaining({messageId:'parent-join',scope:'influence',key:'join:outer:parent-join'}));
    expect(marks.some(mark=>mark.messageId==='container'&&mark.scope==='influence')).toBe(false);
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['container']);
  });
  it('shares one status window between repeated reading and staging references to the same message',async()=>{
    const input=fixture([text('m')],[]),windows=createDisplayHintWindow();
    const view=render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} windowState={windows}>
      <MessageDisplayMarker messageId="m"/>
      <MessageReferenceControl messageId="m" type="文本" summary="正文"/>
      <MessageReferenceControl messageId="m" type="文本" summary="正文"/>
    </MessageDisplayHintsProvider>);
    await waitFor(()=>expect(view.container.querySelectorAll('[data-display-hint="m"]')).toHaveLength(3));
    const markers=view.container.querySelectorAll('[data-display-hint="m"]');
    for(const marker of markers){
      fireEvent.click(marker);
      expect(screen.getAllByRole('tooltip')).toHaveLength(1);
      expect(view.container.querySelectorAll('[data-display-hint="m"][aria-expanded="true"]')).toHaveLength(1);
      expect(marker).toHaveAttribute('aria-expanded','true');
    }
    expect(view.container.querySelectorAll('[data-message-reference-value]')).toHaveLength(2);
  });
  it('keeps the status header accessible and confirms displayed votes and annotations without navigation',async()=>{
    const input=fixture([text('m')],[rel('up','AGREE',['m']),rel('down','DISAGREE',['m']),{...rel('label','TAG',['m']),payload:{label:'标签'}}]);
    const save=vi.fn().mockResolvedValue(undefined),navigate=vi.fn();
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={save} onReadNavigate={navigate}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/显示提示 m：/}));
    const tooltip=screen.getByRole('tooltip'),header=tooltip.querySelector('[data-display-hint-header]')!;
    expect(header).toHaveStyle({position:'sticky',top:0});
    expect(within(tooltip).getByRole('button',{name:'展开状态标志说明'})).toHaveAttribute('aria-expanded','false');
    const legend=within(tooltip).getByText('蓝点：消息待阅 · 蓝空心点：影响或成员待阅 · 橙角：显示变化');
    expect(legend).not.toBeVisible();fireEvent.click(within(tooltip).getByRole('button',{name:'展开状态标志说明'}));
    expect(legend).toBeVisible();fireEvent.click(within(tooltip).getByRole('button',{name:'收起状态标志说明'}));expect(legend).not.toBeVisible();
    fireEvent.scroll(tooltip,{target:{scrollTop:600}});
    fireEvent.click(within(tooltip).getByRole('button',{name:'标记当前消息已阅'}));
    await waitFor(()=>expect(save).toHaveBeenCalledOnce());
    const marks=save.mock.calls[0][0] as ReadingMark[];
    expect(marks.some(mark=>mark.messageId==='m'&&mark.scope==='message')).toBe(true);
    for(const key of ['agree:','disagree:','tag:'])expect(marks.some(mark=>mark.scope==='influence'&&mark.key.startsWith(key))).toBe(true);
    expect(navigate).not.toHaveBeenCalled();expect(screen.getByRole('tooltip')).toBe(tooltip);
    fireEvent.click(within(header as HTMLElement).getByRole('button',{name:'关闭消息提示'}));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it.each(['source','target'])('jumps to the reference record from the %s hint instead of highlighting its source',targetId=>{
    const input=fixture([text('source'),text('target')],[rel('reference','REFERENCE',['target'],'source')]),onReadNavigate=vi.fn(),onView=vi.fn();
    render(<MessageDisplayHintsProvider input={input} onView={onView} onReadNavigate={onReadNavigate}><MessageDisplayMarker messageId={targetId}/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:new RegExp(`显示提示 ${targetId}：`)}));
    fireEvent.click(screen.getByTitle('查看引用 reference'));
    expect(onView).toHaveBeenCalledWith('reference',expect.anything(),true);
    expect(onReadNavigate).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'跳转未读'})).toBeNull();
  });
  it('freezes the exact original base revision and keeps it after an authorized base update',()=>{
    const base={...text('m','原文'),revision:1,parts:[{id:'body',type:'text' as const,text:'原文'}]};
    const edit={...rel('c','CORRECT',['m']),revision:1,targetRefs:[{kind:'message' as const,messageId:'m',reference:{messageId:'m',revision:1,partId:'body'}}],payload:{correctionBeforeContent:'原文',correctionAfterContent:'更正版'}};
    function Probe(){return <output data-testid="viewed-version">{JSON.stringify(useViewedBodyReference('m'))}</output>;}
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={vi.fn()}><Probe/><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(fixture([base],[edit])));
    fireEvent.click(screen.getByRole('button',{name:'切换消息 m 的版本'}));fireEvent.click(screen.getByRole('radio',{name:'原文'}));
    fireEvent.click(screen.getByRole('button',{name:'固定查看此正文'}));
    expect(screen.getByRole('button',{name:'切换消息 m 的版本'})).toHaveAccessibleDescription(/当前固定查看此正文/);
    view.rerender(element(fixture([{...base,revision:2,content:'后来修改',parts:[{id:'body',type:'text',text:'后来修改'}]}],[edit])));
    expect(JSON.parse(screen.getByTestId('viewed-version').textContent!).context.version).toMatchObject({messageId:'m',revision:1,corrections:[]});
    expect(screen.getByRole('button',{name:'切换消息 m 的版本'})).toHaveAttribute('data-reading-version-override','true');
    fireEvent.click(screen.getByRole('button',{name:'恢复默认显示 m'}));
    expect(JSON.parse(screen.getByTestId('viewed-version').textContent!).context.version.revision).toBe(2);
    view.unmount();
  });
  it('hides version navigation when personal and recommended history entries resolve to the same body',()=>{
    const records=[text('m','原文')],corrections=[{...rel('c1','CORRECT',['m']),payload:{correctionBeforeContent:'原文',correctionAfterContent:'个人正文'}},
      {...rel('c2','CORRECT',['m'],null,'2026-01-03'),state:{messageId:'c2',revision:1,suppressed:false,supportCount:3,oppositionCount:0,recommendationTotal:0},payload:{correctionBeforeContent:'原文',correctionAfterContent:'推荐正文'}}];
    const relations=[...corrections,rel('choice-1','AGREE',['c1'],null,'2026-01-04','alice')];
    const first=fixture(records,relations),next=fixture(records,[...relations,rel('choice-2','AGREE',['c2'],null,'2026-01-05','alice')]);
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(first));fireEvent.click(screen.getByRole('button',{name:'切换消息 m 的版本'}));
    expect(screen.queryByRole('button',{name:'版本后退 m'})).toBeNull();expect(screen.queryByRole('button',{name:'版本前进 m'})).toBeNull();
    fireEvent.click(screen.getByRole('radio',{name:'推荐选择'}));expect(screen.getByRole('button',{name:'版本后退 m'})).toBeEnabled();
    view.rerender(element(next));
    expect(screen.queryByRole('button',{name:'版本后退 m'})).toBeNull();expect(screen.queryByRole('button',{name:'版本前进 m'})).toBeNull();
    fireEvent.click(screen.getByRole('radio',{name:'原文'}));expect(screen.getByRole('button',{name:'版本后退 m'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'版本后退 m'}));expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('推荐选择');
    expect(screen.getByRole('button',{name:'版本后退 m'})).toBeDisabled();expect(screen.getByRole('button',{name:'版本前进 m'})).toBeEnabled();
  });
  it('shows only recommendation until this viewer actually chooses a correction, including on their own message',()=>{
    const records=[text('m','原文','alice')],correction={...rel('c','CORRECT',['m']),payload:{correctionBeforeContent:'原文',correctionAfterContent:'推荐更正'}};
    const relations=[correction,rel('other-choice','AGREE',['c'],null,'2026-01-03','bob'),rel('body-choice','AGREE',['m'],null,'2026-01-03','alice')];
    const input=fixture(records,relations),next=fixture(records,[...relations,rel('own-choice','DISAGREE',['c'],null,'2026-01-04','alice')]);
    const element=(value:DisplayHintsInput)=><MessageDisplayHintsProvider input={value} onView={vi.fn()}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:'切换消息 m 的版本'}));
    const popup=screen.getByRole('dialog');
    expect(popup).toHaveTextContent('当前用户尚未选择，默认跟随推荐选择');
    expect(popup).not.toHaveTextContent('当前用户选择');expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('推荐选择');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    view.rerender(element(next));expect(popup).not.toHaveTextContent('尚未选择');
    expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('当前用户选择相同');
    view.rerender(element(input));expect(popup).toHaveTextContent('尚未选择');expect(popup).not.toHaveTextContent('当前用户选择');
  });
  it.each(['TEXT','MEANING'] as const)('recognizes publishing a %s correction as a choice and follows later sends and stances',correctionKind=>{
    const records=[text('m','原文')],publicCorrection={...rel('public','CORRECT',['m']),
      state:{messageId:'public',revision:1,suppressed:false,supportCount:10,oppositionCount:0,recommendationTotal:0},
      payload:{correctionBeforeContent:'原文',correctionAfterContent:'推荐正文'}};
    const ownCorrection={...rel('own','CORRECT',['m'],null,'2026-01-03','alice'),
      state:{messageId:'own',revision:1,suppressed:true,supportCount:1,oppositionCount:5,recommendationTotal:0},
      payload:{correctionKind,correctionBeforeContent:'原文',correctionAfterContent:'本人更正'}};
    const initial=fixture(records,[publicCorrection]),published=fixture(records,[publicCorrection,ownCorrection]);
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(initial));fireEvent.click(screen.getByRole('button',{name:'切换消息 m 的版本'}));
    expect(screen.getByRole('dialog')).toHaveTextContent('当前用户尚未选择');
    view.rerender(element(published));
    expect(deriveDisplayHints(published).personalCorrectionChoices.has('m')).toBe(true);
    expect(screen.getByRole('dialog')).not.toHaveTextContent('当前用户尚未选择');
    expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('当前用户选择');
    expect(deriveDisplayHints(published).hints.get('m')?.personal.content).toBe('本人更正');
    expect(deriveDisplayHints(published).hints.get('m')?.recommended.content).toBe('推荐正文');
    const laterChoice=rel('choice','AGREE',['public'],null,'2026-01-04','alice');
    view.rerender(element(fixture(records,[publicCorrection,ownCorrection,laterChoice])));
    expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('与当前用户选择相同');
    const newer={...ownCorrection,id:'newer',createdAt:'2026-01-05',state:undefined,payload:{...ownCorrection.payload,correctionAfterContent:'新发更正'}};
    const sentAgain=fixture(records,[publicCorrection,ownCorrection,laterChoice,newer]);
    view.rerender(element(sentAgain));expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('当前用户选择');
    expect(deriveDisplayHints(sentAgain).hints.get('m')?.personal.content).toBe('新发更正');
    const rejected=fixture(records,[publicCorrection,ownCorrection,laterChoice,newer,rel('reject','DISAGREE',['newer'],null,'2026-01-06','alice')]);
    view.rerender(element(rejected));expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('与当前用户选择相同');
    expect(deriveDisplayHints(rejected).hints.get('m')?.personal.content).toBe('推荐正文');
    expect(deriveDisplayHints(rejected).hints.get('newer')).toMatchObject({personalActive:false,recommendedActive:false});
    const restored=fixture(records,[publicCorrection,ownCorrection,laterChoice,newer,rel('reject','DISAGREE',['newer'],null,'2026-01-06','alice'),
      rel('restore','AGREE',['newer'],null,'2026-01-07','alice')]);
    view.rerender(element(restored));expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('当前用户选择');
    expect(deriveDisplayHints(restored).hints.get('m')?.personal.content).toBe('新发更正');
    expect(deriveDisplayHints(restored).hints.get('newer')).toMatchObject({personalActive:true,recommendedActive:false});
  });
  it('marks a manual version override and follows new personal choices when viewing the personal/default source',()=>{
    const corrections=[{...rel('c1','CORRECT',['m']),payload:{correctionBeforeContent:'原文',correctionAfterContent:'用户版本一'}},
      {...rel('c2','CORRECT',['m'],null,'2026-01-03'),state:{messageId:'c2',revision:1,suppressed:false,supportCount:3,oppositionCount:0,recommendationTotal:0},payload:{correctionBeforeContent:'原文',correctionAfterContent:'推荐版本二'}}];
    const first=fixture([text('m','原文')],[...corrections,rel('choice-1','AGREE',['c1'],null,'2026-01-04','alice')]);
    const next=fixture([text('m','原文')],[...corrections,rel('choice-1','AGREE',['c1'],null,'2026-01-04','alice'),rel('choice-2','AGREE',['c2'],null,'2026-01-05','alice')]);
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(first)),marker=screen.getByRole('button',{name:'切换消息 m 的版本'});
    expect(marker).toHaveAttribute('data-reading-version-override','false');
    expect(marker).toHaveAttribute('data-reading-version-recommendation','different');
    expect(marker.querySelector('[data-reading-version-recommendation-difference]')).not.toBeNull();fireEvent.click(marker);
    fireEvent.click(screen.getByRole('radio',{name:'推荐选择'}));
    expect(marker).toHaveAttribute('data-reading-version-override','true');expect(marker).toHaveAttribute('title',expect.stringContaining('与默认显示不同'));
    expect(marker).toHaveAttribute('data-reading-version-recommendation','same');
    expect(marker.querySelector('span')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'恢复默认显示 m'}));
    expect(marker).toHaveAttribute('data-reading-version-override','false');expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('当前用户选择');
    expect(marker.querySelector('[data-reading-version-recommendation-difference]')).not.toBeNull();
    view.rerender(element(next));
    expect(marker).toHaveAttribute('data-reading-version-override','false');expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('与当前用户选择相同');expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(marker.querySelector('[data-reading-version-recommendation-difference]')).toBeNull();
    fireEvent.click(screen.getByRole('radio',{name:'原文'}));expect(marker).toHaveAttribute('data-reading-version-override','true');
    expect(marker.querySelector('[data-reading-version-recommendation-difference]')).not.toBeNull();
    view.rerender(element(first));
    expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('原文');expect(marker).toHaveAttribute('data-reading-version-override','true');
    fireEvent.click(screen.getByRole('radio',{name:'当前用户选择'}));
    view.rerender(element(next));expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('与当前用户选择相同');expect(marker).toHaveAttribute('data-reading-version-override','false');
  });
  it.each([
    ['原文','原文',1,'与推荐选择、当前用户选择相同'],
    ['相同更正','相同更正',2,'与当前用户选择相同'],
    ['个人版本','原文',2,'与推荐选择相同'],
    ['原文','推荐版本',2,'与当前用户选择相同'],
    ['个人版本','推荐版本',3,null],
  ])('shows at most three source rows, merging personal=%s and recommended=%s',(personal,recommended,count,explanation)=>{
    const input=fixture([text('m','原文')],[...Array.from({length:5},(_,index)=>({...rel(`c${index}`,'CORRECT',['m']),payload:{correctionBeforeContent:'原文',correctionAfterContent:`历史版本${index}`}})),rel('choice','AGREE',['c0'],null,'2026-01-04','alice')]);
    const entry=input.corrections.get('m')!,personalVersion={...entry.versions[0],content:personal as string},recommendedVersion={...entry.versions[1],content:recommended as string};
    input.corrections=new Map([['m',{...entry,current:personalVersion}]]);input.recommendedCorrections=new Map([['m',{...entry,current:recommendedVersion}]]);
    const onView=vi.fn();render(<MessageDisplayHintsProvider input={input} onView={onView}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:'切换消息 m 的版本'}));
    const popup=screen.getByRole('dialog'),radios=within(popup).getAllByRole('radio');
    expect(radios).toHaveLength(6);void count;void explanation;expect(within(popup).getAllByRole('radio',{checked:true})).toHaveLength(1);
    expect(within(popup).getAllByText('显示')).toHaveLength(1);expect(popup).not.toHaveTextContent('历史版本');expect(screen.queryByRole('combobox')).toBeNull();
    expect(radios.map(radio=>radio.getAttribute('data-reading-version-choice'))).toContain('c4');
    for(const radio of radios){fireEvent.click(radio);expect(radio).toHaveAttribute('aria-checked','true');expect(within(popup).getAllByText('显示')).toHaveLength(1);}
    expect(onView).not.toHaveBeenCalled();
  });
  it('confirms a corrected display without prerequisites and keeps per-message version history',async()=>{
    const records=[text('m','原文')],relations=[{...rel('c1','CORRECT',['m']),payload:{correctionBeforeContent:'原文',correctionAfterContent:'更正一'}},
      {...rel('c2','CORRECT',['m'],null,'2026-01-03'),state:{messageId:'c2',revision:1,suppressed:false,supportCount:3,oppositionCount:0,recommendationTotal:0},payload:{correctionBeforeContent:'原文',correctionAfterContent:'更正二'}},
      rel('choice','AGREE',['c1'],null,'2026-01-04','alice')];
    const input=fixture(records,relations),onView=vi.fn(),onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={onView} onMarkRead={onMarkRead}>
      <MessageDisplayMarker messageId="m"/><MessageDisplayMarker messageId="m" scope="corrections"/>
    </MessageDisplayHintsProvider>;
    const view=render(element(input));
    const openVersions=()=>fireEvent.click(screen.getByRole('button',{name:'切换消息 m 的版本'}));
    const displayed=()=>screen.getByRole('radio',{checked:true});
    expect(screen.queryByRole('radiogroup')).toBeNull();expect(screen.queryByRole('button',{name:'版本后退 m'})).toBeNull();
    const versionMarker=screen.getByRole('button',{name:'切换消息 m 的版本'}),statusMarker=screen.getByRole('button',{name:/^显示提示 m：/});
    expect(versionMarker.compareDocumentPosition(statusMarker)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    openVersions();expect(displayed()).toHaveTextContent('当前用户选择');expect(screen.getAllByRole('radio')).toHaveLength(3);expect(screen.queryByRole('button',{name:'版本后退 m'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    expect(screen.getByRole('button',{name:'标记当前消息已阅'})).toBeEnabled();
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'})));
    const marks=onMarkRead.mock.calls[0][0];
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m']);
    expect(marks[0].version?.corrections.map(item=>item.messageId)).toEqual(['c1']);
    view.rerender(element({...input,readingMarks:marks}));
    openVersions();fireEvent.click(screen.getByRole('radio',{name:'原文'}));
    expect(versionMarker).toHaveAttribute('title',expect.stringContaining('原文'));expect(onView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'版本后退 m'}));expect(displayed()).toHaveTextContent('当前用户选择');
    fireEvent.click(screen.getByRole('radio',{name:'推荐选择'}));expect(displayed()).toHaveTextContent('推荐选择');
    fireEvent.click(screen.getByRole('button',{name:'版本后退 m'}));expect(displayed()).toHaveTextContent('当前用户选择');
    fireEvent.click(screen.getByRole('button',{name:'版本前进 m'}));expect(displayed()).toHaveTextContent('推荐选择');
    fireEvent.keyDown(displayed(),{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();
    openVersions();fireEvent.pointerDown(document.body);expect(screen.queryByRole('dialog')).toBeNull();
    openVersions();fireEvent.click(screen.getByRole('button',{name:'关闭版本选择'}));expect(screen.queryByRole('dialog')).toBeNull();
    expect(onView).not.toHaveBeenCalled();
  });
  it.each(['A','R'])('confirms listed nested placement effects without reading their source bodies when viewing %s',async currentContainerId=>{
    const input=fixture([text('m')],[rel('A','CLASSIFY'),rel('R','ARRANGE'),rel('S','SUMMARY'),
      rel('frame-in-category','JOIN',['R'],'A'),rel('sibling-in-category','JOIN',['S'],'A'),
      rel('old-classification','JOIN',['m'],'A','2026-01-02'),rel('old-sibling','JOIN',['m'],'S','2026-01-01'),rel('active','JOIN',['m'],'R','2026-01-03')]);
    const onView=vi.fn(),onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    const element=(value:DisplayHintsInput)=><MessageDisplayHintsProvider input={value} onView={onView} onMarkRead={onMarkRead} currentContainerId={currentContainerId}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(input));
    fireEvent.click(screen.getByRole('button',{name:/显示提示 m：/}));
    const tooltip=screen.getByRole('tooltip');
    expect(within(tooltip).getByText('分类：A（当前）')).toBeInTheDocument();
    expect(within(tooltip).getByText('排列：R（当前）')).toBeInTheDocument();
    expect(within(tooltip).getByText('总结：S')).toBeInTheDocument();
    expect(within(tooltip).queryByRole('button',{name:/^被加入 · (old-classification|active)/})).toBeNull();
    fireEvent.click(effectButton(/^被加入 · old-sibling/));
    expect(onView).toHaveBeenCalledWith('old-sibling',expect.anything(),true);
    await act(async()=>fireEvent.click(within(tooltip).getByRole('button',{name:'标记当前消息已阅'})));
    const marks=onMarkRead.mock.calls[0][0];
    expect(new Set(marks.filter(mark=>mark.scope!=='influence').map(mark=>mark.messageId))).toEqual(new Set(['m']));
    view.rerender(element({...input,readingMarks:marks}));
    const after=screen.getByRole('tooltip');
    expect(after).toHaveTextContent('加入 · old-sibling');expect(after).toHaveTextContent('加入 · active');
    expect(deriveDisplayHints({...input,readingMarks:marks}).hints.get('m')?.relatedUnreadIds).toEqual([]);
  });
  it('keeps the complete effective path current without including the container message itself or its historical members',()=>{
    const input=fixture([text('member')],[rel('A','CLASSIFY'),rel('R','ARRANGE'),rel('category','CLASSIFY',['member']),rel('other','SUMMARY'),
      rel('frame-in-A','JOIN',['R'],'A'),rel('category-was-in-A','JOIN',['category'],'A'),rel('category-in-R','JOIN',['category'],'R','2026-01-03'),
      rel('old-member','JOIN',['member'],'category'),rel('moved-member','JOIN',['member'],'other','2026-01-04')]);
    const lookup=createCurrentContainerLookup(input.personalEffect,'A');
    expect(lookup('category')).toEqual(new Set(['R','A']));expect(lookup('category-in-R')).toEqual(new Set(['R','A']));
    expect(createCurrentContainerLookup(input.personalEffect,'other')('category')).toEqual(new Set());
    const onView=vi.fn();render(<MessageDisplayHintsProvider input={input} onView={onView} currentContainerId="A"><MessageDisplayMarker messageId="category"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 category：/}));
    const tooltip=screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('分类：A（当前）');expect(tooltip).toHaveTextContent('排列：R（当前）');
    expect(tooltip).not.toHaveTextContent('分类：category（当前）');
    fireEvent.click(within(tooltip).getByRole('button',{name:'查看被加入目标 member'}));
    expect(onView).toHaveBeenCalledWith('member',expect.anything(),false);
  });
  it('restores the version anchor only after asynchronous graph measurements finish',async()=>{
    const input=fixture([text('m','原文')],[{...rel('c','CORRECT',['m']),payload:{correctionBeforeContent:'原文',correctionAfterContent:'更正'}}]);
    const tasks=createWorkbenchDrawingTasks(),view=render(<WorkbenchDrawingContext.Provider value={tasks}>
      <MessageDisplayHintsProvider input={input} onView={vi.fn()}><div data-workbench-left-panel="true" style={{overflow:'auto'}}><MessageDisplayMarker messageId="m"/></div></MessageDisplayHintsProvider>
    </WorkbenchDrawingContext.Provider>);
    const pane=view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!,marker=screen.getByRole('button',{name:'切换消息 m 的版本'});
    let layoutTop=400;pane.scrollTop=200;
    vi.spyOn(marker,'getBoundingClientRect').mockImplementation(()=>new DOMRect(30,layoutTop-pane.scrollTop,18,16));
    fireEvent.click(marker);
    const measurement=tasks.begin('measurement');
    fireEvent.click(screen.getByRole('radio',{name:'原文'}));
    layoutTop=1000;
    await act(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    expect(pane.scrollTop).toBe(200);
    act(()=>measurement.release());
    await waitFor(()=>expect(pane.scrollTop).toBe(800));
    expect(marker.getBoundingClientRect().top).toBe(200);
    await waitFor(()=>expect(tasks.pending).toBe(0));
  });
  it('uses the active nested path after a frame moves, rather than its historical JOIN or a rejected frame',()=>{
    const relations=[rel('A','CLASSIFY'),rel('B','CLASSIFY'),rel('R','ARRANGE'),
      rel('old-frame','JOIN',['R'],'A','2026-01-02'),rel('old-member','JOIN',['m'],'A','2026-01-01'),rel('active','JOIN',['m'],'R','2026-01-03')];
    const before=fixture([text('m')],relations);
    expect(createCurrentContainerLookup(before.personalEffect,'A')('m')).toEqual(new Set(['A','R']));
    const moved=fixture([text('m')],[...relations,rel('new-frame','JOIN',['R'],'B','2026-01-04')]);
    const lookup=createCurrentContainerLookup(moved.personalEffect,'B');
    expect(lookup('m')).toEqual(new Set(['B','R']));expect(lookup('active')).toEqual(new Set(['B','R']));
    const rejected=deriveContainerEffect({...before,stakeCounts:{},assumption:{messageId:'R',side:'disagree'}});
    expect(createCurrentContainerLookup(rejected,'A')('m')).toEqual(new Set(['A']));
  });
  it('supports legacy nested declarations, a root canvas and malformed cycles without expanding to siblings',()=>{
    const input=fixture([text('m')],[rel('A','CLASSIFY',['R','S']),rel('R','ARRANGE',['m']),rel('S','SUMMARY')]);
    expect(createCurrentContainerLookup(input.personalEffect,'A')('m')).toEqual(new Set(['A','R']));
    expect(createCurrentContainerLookup(input.personalEffect,'root')('m')).toEqual(new Set(['R','A']));
    const cyclic={...input.personalEffect,memberships:[...input.personalEffect.memberships,{containerId:'R',relationType:'arrange' as const,targetIds:['A','m']}]};
    expect(createCurrentContainerLookup(cyclic,'A')('m')).toEqual(new Set(['A','R']));
  });
  it.each([false,true])('combines a JOIN and its container into one actionable placement, JOIN previously read=%s',async alreadyRead=>{
    const records=[text('m'),text('sibling')],relations=[rel('container','CLASSIFY',['m','sibling']),rel('join','JOIN',['m'],'container')];
    const input=fixture(records,relations,alreadyRead?new Map([['join','READ']]):new Map()),onView=vi.fn(),onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    expect(deriveDisplayHints(input).hints.get('m')?.relatedUnreadIds).toEqual(alreadyRead?[]:['join']);
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={onView} onMarkRead={onMarkRead} currentContainerId="container"><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/显示提示 m：/}));
    const tooltip=screen.getByRole('tooltip');
    if(alreadyRead)expect(tooltip).not.toHaveTextContent('条影响待阅');
    else{expect(tooltip).toHaveTextContent('未阅影响（1 条）');expect(tooltip).toHaveTextContent('加入 · join');}
    expect(tooltip).not.toHaveTextContent('分类 · container');
    await act(async()=>fireEvent.click(within(tooltip).getByRole('button',{name:'标记当前消息已阅'})));
    const marks=onMarkRead.mock.calls[0][0];
    expect(marks.filter(mark=>mark.scope==='message')).toHaveLength(1);expect(marks[0]).toMatchObject({messageId:'m',scope:'message'});
    const after={...input,readingMarks:[...input.readingMarks??[],...marks]};
    expect(deriveDisplayHints(after).hints.get('container')).toMatchObject({unread:true,unreadMemberCount:1});
    view.rerender(element(after));expect(screen.getByRole('button',{name:/显示提示 m：消息已阅/})).toHaveAttribute('data-display-reading','read');
    if(!alreadyRead)expect(screen.getByRole('tooltip')).toHaveTextContent('影响已阅');expect(onView).not.toHaveBeenCalled();
  });
  it('records the body and current JOIN effect separately in one confirmation',async()=>{
    const input=fixture([text('m')],[rel('container','CLASSIFY',['m']),rel('join','JOIN',['m'],'container')]),onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={onMarkRead} currentContainerId="container"><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/显示提示 m：/}));
    const automatic=screen.getByRole('region',{name:'消息阅读确认'});
    expect(within(automatic).getAllByRole('button',{name:'标记当前消息已阅'})).toHaveLength(1);
    expect(screen.queryByRole('button',{name:'标记加入 join 已阅'})).toBeNull();
    await act(async()=>fireEvent.click(within(automatic).getByRole('button',{name:'标记当前消息已阅'})));
    const marks=onMarkRead.mock.calls[0][0];
    expect(marks.filter(mark=>mark.scope!=='influence')).toHaveLength(1);expect(marks.some(mark=>mark.messageId==='join'&&mark.scope==='message')).toBe(false);
    expect(marks).toContainEqual(expect.objectContaining({messageId:'join',scope:'influence',resultKey:'effective'}));
    expect(marks).toContainEqual(expect.objectContaining({messageId:'m',scope:'message'}));
    expect(marks.some(mark=>mark.messageId==='container'&&mark.scope!=='influence')).toBe(false);
    expect(deriveDisplayHints({...input,readingMarks:marks}).hints.get('m')).toMatchObject({unread:false,relatedUnreadIds:[]});
  });
  it('keeps different placement records separate while folding their shared container context',()=>{
    const input=fixture([text('m')],[rel('container','CLASSIFY',['m']),rel('old','JOIN',['m'],'container','2026-01-02'),rel('new','JOIN',['m'],'container','2026-01-03')]);
    expect(new Set(deriveDisplayHints(input).hints.get('m')?.relatedUnreadIds)).toEqual(new Set(['old','new']));
  });
  it('labels the current classification itself without linking back into it',()=>{
    const input=fixture([text('member')],[rel('container','CLASSIFY',['member'])]),onView=vi.fn();
    render(<MessageDisplayHintsProvider input={input} onView={onView} currentContainerId="container"><MessageDisplayMarker messageId="member"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/显示提示 member/}));
    const tooltip=screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('分类 · container（当前）');expect(tooltip).not.toHaveTextContent('当前容器');
    expect(within(tooltip).queryByRole('button',{name:/查看分类|分类 · container/})).toBeNull();
    expect(onView).not.toHaveBeenCalled();
  });
  it.each([['CLASSIFY','分类'],['SUMMARY','总结'],['MERGE','归并'],['ARRANGE','排列']])('shows a pending member count and the actual %s type in its viewing instruction',(type,label)=>{
    const input=fixture([text('member')],[rel('container',type,['member'])]),onView=vi.fn(),onMarkRead=vi.fn(async()=>{});
    input.readingMarks=readingMarksFor({...input,memberships:input.personalEffect.memberships},'container',deriveDisplayHints(input).hints.get('container')!.displayed);
    render(<MessageDisplayHintsProvider input={input} onView={onView} onMarkRead={onMarkRead}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>);
    const marker=screen.getByRole('button',{name:/显示提示 container/});
    expect(marker).toHaveAttribute('data-display-reading','related-unread');fireEvent.click(marker);
    const tooltip=screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('1 条成员消息待阅');
    if(type==='CLASSIFY')expect(tooltip).toHaveTextContent(`双击进入${label}查看。`);
    else expect(tooltip).not.toHaveTextContent('双击进入');
    expect(within(tooltip).getByRole('button',{name:'查看成员消息 member'})).toBeInTheDocument();
    const explanation=within(tooltip).getByText(`消息 · 【${label}】 container`),confirm=within(tooltip).getByRole('button',{name:'当前消息已阅'});
    expect(confirm).toBeDisabled();
    expect(explanation.compareDocumentPosition(confirm)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tooltip).getByText('选择显示')).toHaveStyle({textAlign:'left'});
    expect(onView).not.toHaveBeenCalled();expect(onMarkRead).not.toHaveBeenCalled();
  });
  it('confirms listed annotation, placement and reply effects without reading their bodies',async()=>{
    const tag={...rel('tag','TAG',['m']),payload:{label:'有趣'}};
    const input=fixture([text('m')],[rel('container','CLASSIFY',['m']),rel('join','JOIN',['m'],'container'),tag,rel('reply','REPLY',['m'])]);
    const onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={onMarkRead}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/显示提示 m：/}));
    const automatic=screen.getByRole('region',{name:'消息阅读确认'}),individual=effectDetails();
    expect(automatic.compareDocumentPosition(individual)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(automatic).toHaveTextContent('消息 · 【文本】 m');expect(automatic).not.toHaveTextContent('加入 · join');expect(automatic).not.toHaveTextContent('标注「有趣」');
    expect(individual).toHaveTextContent('标注「有趣」');
    expect(automatic).not.toHaveTextContent('回复 · reply');expect(individual).toHaveTextContent('回复 · reply');expect(individual).toHaveTextContent('加入 · join');
    expect(within(automatic).getAllByRole('button',{name:'标记当前消息已阅'})).toHaveLength(1);
    expect(within(individual).queryByRole('button',{name:/已阅/})).toBeNull();
    expect(individual).toHaveTextContent('影响待阅');
    await act(async()=>fireEvent.click(within(automatic).getByRole('button',{name:'标记当前消息已阅'})));
    const marks=onMarkRead.mock.calls[0][0];
    expect(marks).toHaveLength(4);expect(marks[0]).toMatchObject({messageId:'m',scope:'message'});
    expect(marks).toContainEqual(expect.objectContaining({messageId:'m',scope:'influence',key:'tag:有趣'}));
    expect(marks.some(mark=>mark.messageId==='reply'||mark.messageId==='tag'&&mark.scope!=='influence')).toBe(false);
  });
  it('shows received JOIN targets and their progress without confirming them from the container',async()=>{
    const records=[text('direct'),text('nested-member'),text('outside')];
    const relations=[rel('container','CLASSIFY'),rel('nested','CLASSIFY'),rel('elsewhere','CLASSIFY'),rel('nested-join','JOIN',['nested'],'container'),
      rel('old-direct','JOIN',['direct'],'container'),rel('current-direct','JOIN',['direct'],'container','2026-01-03'),
      rel('old-nested','JOIN',['nested-member'],'container'),rel('current-nested','JOIN',['nested-member'],'nested','2026-01-03'),
      rel('old-outside','JOIN',['outside'],'container'),rel('current-outside','JOIN',['outside'],'elsewhere','2026-01-03')];
    const input=fixture(records,relations),onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{}),onView=vi.fn();
    const element=(value:DisplayHintsInput)=><MessageDisplayHintsProvider input={value} onView={onView} onMarkRead={onMarkRead}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/显示提示 container：/}));
    const adopted=screen.getByRole('region',{name:'当前采用的被加入目标'}),unadopted=screen.getByRole('region',{name:'未采用的被加入目标'});
    expect(adopted).toHaveTextContent('当前采用（2 条）');expect(unadopted).toHaveTextContent('未采用（3 条）');
    expect(adopted.querySelector('[data-display-hint-members]')).not.toBeNull();
    expect(unadopted.querySelector('[data-display-hint-members]')).toBeNull();
    expect(within(adopted).getByRole('button',{name:'查看被加入目标 direct'})).toHaveTextContent('【文本】 ID：direct');
    expect(within(adopted).getByRole('button',{name:'查看被加入目标 nested'})).toHaveTextContent('【分类】 ID：nested');
    for(const [id,label] of [['old-direct','本容器'],['old-nested','嵌套容器中'],['old-outside','范围外']]){
      const rows=unadopted.querySelectorAll(`[data-reading-join-record="${id}"]`);expect(rows).toHaveLength(1);
      expect(rows[0].querySelector('[data-join-target-location]')).toHaveTextContent(label);
    }
    expect(screen.getByRole('region',{name:'消息阅读确认'}).querySelector('[data-reading-received-joins]')).toBeNull();
    fireEvent.click(within(unadopted).getByRole('button',{name:'查看被加入目标 nested-member'}));expect(onView).toHaveBeenCalledWith('nested-member',expect.anything(),false);
    const changed=fixture(records,[...relations,rel('choice','AGREE',['old-nested'],null,'2026-01-04','alice')]);
    view.rerender(element(changed));
    const moved=screen.getByRole('region',{name:'当前采用的被加入目标'}).querySelector('[data-reading-join-record="old-nested"]');
    expect(moved).not.toBeNull();expect(moved!.querySelector('[data-join-target-location]')).toHaveTextContent('本容器');
    view.rerender(element(input));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'})));
    const mainMarks=onMarkRead.mock.calls[0][0];expect(mainMarks.some(mark=>mark.scope!=='influence'&&['nested-join','current-direct','direct','nested-member','outside'].includes(mark.messageId))).toBe(false);
    const received=screen.getByRole('tooltip').querySelector('[data-reading-received-joins]')!;
    expect(within(received as HTMLElement).queryAllByRole('button',{name:/已阅|跳转未读/})).toHaveLength(0);
    expect(received).toHaveTextContent('消息待阅');expect(received).toHaveTextContent('条新影响待确认');
    expect(received).not.toHaveTextContent('被加入 · old-nested');
    const targetHint=deriveDisplayHints(input).hints.get('nested-member')!;
    const targetMarks=[...readingMarksFor({...input,memberships:input.personalEffect.memberships,displays:new Map([['nested-member',targetHint.displayed]])},'nested-member',targetHint.displayed),
      ...influenceReadingMarks('nested-member',targetHint.pendingInfluences)];
    view.rerender(element({...input,readingMarks:[...mainMarks,...targetMarks]}));
    const targetRow=screen.getByRole('tooltip').querySelector('[data-reading-join-record="old-nested"]')!;
    expect(targetRow).toHaveTextContent('消息已阅 · 暂无新影响');
    expect(onMarkRead).toHaveBeenCalledOnce();
  });
  it.each(['CLASSIFY','SUMMARY'])('retains %s member reminders across original and corrected bodies without confirming members',async type=>{
    const correction={...rel('correction','CORRECT',['container']),payload:{correctionBeforeContent:'container',correctionAfterContent:'修正标题'}};
    const input=fixture([text('member')],[rel('container',type,['member']),correction]),onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={onMarkRead}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>);
    expect(deriveDisplayHints(input).hints.get('container')).toMatchObject({unreadMemberCount:1,displayed:{content:'修正标题',memberIds:['member']}});
    fireEvent.click(screen.getByRole('button',{name:/显示提示 container：/}));
    expect(screen.getByRole('region',{name:'当前采用的被加入目标'})).toHaveTextContent('成员消息：共 1 条 · 1 条成员消息待阅');
    expect(screen.getByRole('region',{name:'消息阅读确认'})).not.toHaveTextContent('成员消息');
    fireEvent.click(screen.getByRole('button',{name:'切换消息 container 的版本'}));fireEvent.click(screen.getByRole('radio',{name:'原文'}));
    fireEvent.click(screen.getByRole('button',{name:/显示提示 container：/}));
    expect(screen.getByRole('region',{name:'成员消息'})).toHaveTextContent('1 条成员消息待阅');
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'})));
    expect(onMarkRead.mock.calls[0][0].some(mark=>mark.messageId==='member'&&mark.scope!=='influence')).toBe(false);
  });
  it.each([false,true])('groups classification members by body reading and new effects, including explicit JOIN: %s',async joined=>{
    const records=[text('stable'),text('changed'),text('unread')],ids=records.map(message=>message.id);
    const relations=[rel('container','CLASSIFY',joined?[]:ids),...(joined?[rel('join-all','JOIN',ids,'container')]:[])];
    const before=fixture(records,relations),hints=deriveDisplayHints(before).hints;
    const baselineMarks=['stable','changed'].flatMap(id=>readingMarksFor({...before,memberships:before.personalEffect.memberships},id,hints.get(id)!.displayed));
    const input={...fixture(records,[...relations,rel('new-reply','REPLY',['changed']),rel('unread-reply','REPLY',['unread'])]),readingMarks:baselineMarks};
    const onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{}),onView=vi.fn();
    const element=(value:DisplayHintsInput)=><MessageDisplayHintsProvider input={value} onView={onView} onMarkRead={onMarkRead}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/^显示提示 container：/}));
    const read=screen.getByRole('region',{name:'已阅无新影响的成员消息'}),changed=screen.getByRole('region',{name:'已阅有新影响的成员消息'}),unread=screen.getByRole('region',{name:'未阅的成员消息'});
    const expandRead=within(read).getByRole('button',{name:'展开已阅无新影响（1 条）'});
    expect(expandRead).toHaveAttribute('aria-expanded','false');
    expect(read.querySelector('[data-member-reading-id="stable"]')).not.toBeVisible();
    expect(within(changed).getByRole('button',{name:'收起已阅有新影响（1 条）'})).toHaveAttribute('aria-expanded','true');
    expect(changed.querySelector('[data-member-reading-id="changed"]')).toBeVisible();
    expect(within(unread).getByRole('button',{name:'收起未阅（1 条）'})).toHaveAttribute('aria-expanded','true');
    expect(unread.querySelector('[data-member-reading-id="unread"]')).toBeVisible();
    fireEvent.click(expandRead);expect(read.querySelector('[data-member-reading-id="stable"]')).toBeVisible();
    fireEvent.click(within(read).getByRole('button',{name:'收起已阅无新影响（1 条）'}));
    expect(read.querySelector('[data-member-reading-id="stable"]')).not.toBeVisible();
    for(const [group,id,label] of [[read,'stable','已阅无新影响'],[changed,'changed','已阅有新影响'],[unread,'unread','未阅']] as const){
      expect(group).toHaveTextContent(`${label}（1 条）`);
      expect([...group.querySelectorAll('[data-member-reading-id]')].map(element=>element.getAttribute('data-member-reading-id'))).toEqual([id]);
    }
    const members=screen.getByRole('region',{name:'成员消息'});
    expect(members.querySelectorAll('[data-member-reading-id]')).toHaveLength(3);
    if(joined)for(const row of members.querySelectorAll('[data-reading-join-target]'))expect(row.querySelector('[data-join-target-location]')).toHaveTextContent('本容器');
    fireEvent.click(within(changed).getByRole('button',{name:joined?'查看被加入目标 changed':'查看成员消息 changed'}));
    expect(onView).toHaveBeenCalledWith('changed',expect.anything(),false);expect(onMarkRead).not.toHaveBeenCalled();
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'})));
    const containerMarks=onMarkRead.mock.calls[0][0];expect(containerMarks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['container']);
    expect(containerMarks.every(mark=>mark.messageId==='container')).toBe(true);
    const currentHint=deriveDisplayHints(input).hints.get('changed')!;
    const after={...input,readingMarks:[...baselineMarks,...containerMarks,...readingMarksFor({...input,memberships:input.personalEffect.memberships},'changed',currentHint.displayed)]};
    view.rerender(element(after));
    expect(screen.queryByRole('region',{name:'已阅有新影响的成员消息'})).toBeNull();
    expect(screen.getByRole('region',{name:'已阅无新影响的成员消息'})).toHaveTextContent('已阅无新影响（2 条）');
    expect(screen.getByRole('region',{name:'未阅的成员消息'}).querySelector('[data-member-reading-id="unread"]')).not.toBeNull();
    const later={...fixture(records,[...input.relations,rel('later-reply','REPLY',['stable'])]),readingMarks:after.readingMarks};
    view.rerender(element(later));
    expect(screen.getByRole('region',{name:'已阅有新影响的成员消息'}).querySelector('[data-member-reading-id="stable"]')).not.toBeNull();
    expect(screen.getByRole('region',{name:'已阅无新影响的成员消息'}).querySelector('[data-member-reading-id="changed"]')).not.toBeNull();
  });
  it.each([0,1])('shows a corrected classification member section only when it has %s actual members',members=>{
    const correction={...rel('correction','CORRECT',['container']),payload:{correctionBeforeContent:'container',correctionAfterContent:'修正标题'}};
    const input=fixture([text('member')],[rel('container','CLASSIFY',members?['member']:[]),correction],new Map([['member','READ']]));
    input.readingMarks=readingMarksFor({...input,memberships:input.personalEffect.memberships},'member',deriveDisplayHints(input).hints.get('member')!.displayed);
    input.readingMarks.push(...influenceReadingMarks('member',deriveReadingProgress({...input,marks:input.readingMarks,memberships:input.personalEffect.memberships}).pendingInfluences.get('member')??[]));
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/显示提示 container：/}));
    if(!members){expect(screen.queryByRole('region',{name:'成员消息'})).toBeNull();return;}
    const adopted=screen.getByRole('region',{name:'当前采用的被加入目标'});
    expect(adopted).toHaveTextContent(`成员消息：共 ${members} 条`);
    expect(adopted).toHaveTextContent(members?'成员消息暂无待阅':'当前无有效成员消息');
  });
  it('keeps target reading, display comparison and unread influences independent',()=>{
    const earlier=rel('earlier','REPLY',['m'],null,'2026-01-02');
    const before=fixture([text('m')],[earlier]);
    expect(deriveDisplayHints(before).hints.get('m')?.relatedUnreadIds).toEqual(['earlier']);
    const read=rel('read','READ',['m'],null,'2026-01-03','alice');
    read.payload={readDisplay:{m:getMessageDisplaySignature(before,'m')!}};
    expect(deriveDisplayHints(fixture([text('m')],[earlier,{...read,createdBy:user('bob')}])).hints.get('m')?.relatedUnreadIds).toEqual(['earlier']);
    const input=fixture([text('m')],[earlier,read],new Map([['m','READ']])),data=deriveDisplayHints(input);
    expect(data.hints.get('m')).toMatchObject({unread:false,relatedUnreadIds:['earlier'],readChanged:false});
    expect(data.hints.get('earlier')?.unread).toBe(true);
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="m" /></MessageDisplayHintsProvider>);
    const marker=screen.getByRole('button',{name:/显示提示 m：消息已阅；/});
    expect(marker).toHaveAttribute('data-display-reading','related-unread');
    fireEvent.click(marker);
    expect(screen.getByRole('tooltip')).toHaveTextContent('未阅影响（1 条）');
    expect(screen.getByRole('region',{name:'消息状态'})).not.toHaveTextContent(/正文|已读/);
    expect(screen.getByRole('img',{name:'当前显示与上次已阅一致'})).toHaveTextContent('=');
  });

  it('clears only explicitly read influences and keeps other influences pending',()=>{
    const time='2026-01-03T00:00:00.000Z';
    const earlier={...rel('earlier','REPLY',['m'],null,time),sequence:9};
    const read={...rel('read','READ',['m'],null,time,'alice'),sequence:10};
    const later={...rel('later','REPLY',['m'],null,time),sequence:11};
    const status=new Map<string,'READ'|'UNREAD'>([['m','READ']]);
    const seen=deriveDisplayHints(fixture([text('m')],[read,earlier],status));
    expect(seen.hints.get('m')?.relatedUnreadIds).toEqual(['earlier']);
    const updated=fixture([text('m')],[later,read,earlier],status);
    expect(new Set(deriveDisplayHints(withFixtureReadingMarks(updated)).hints.get('m')?.relatedUnreadIds)).toEqual(new Set(['earlier','later']));
    const nextRead={...read,id:'next-read',sequence:12};
    expect(deriveDisplayHints(fixture([text('m')],[later,nextRead,read,earlier],status)).hints.get('m')?.relatedUnreadIds).toHaveLength(2);
    status.set('earlier','READ');
    expect(deriveDisplayHints(withFixtureReadingMarks(updated)).hints.get('m')?.relatedUnreadIds).toEqual(['later']);
    status.set('earlier','UNREAD');
    expect(deriveDisplayHints(withFixtureReadingMarks(updated)).hints.get('m')?.relatedUnreadIds).toHaveLength(2);
    render(<MessageDisplayHintsProvider input={updated} onView={vi.fn()}><MessageDisplayMarker messageId="m" /></MessageDisplayHintsProvider>);
    expect(screen.getByRole('button',{name:/显示提示 m：消息已阅；.*2 条影响待阅/})).toHaveAttribute('data-display-reading','related-unread');
  });

  it.each(['RECOMMEND','JOIN','CORRECT'])('requires an explicit read on the %s influence itself',type=>{
    const category=rel('category','CLASSIFY',[],null,'2026-01-01','alice');
    const impact=rel('impact',type,['m'],type==='JOIN'?'category':null,'2026-01-02');
    if(type==='CORRECT')impact.payload={correctionBeforeContent:'m',correctionAfterContent:'更正后的正文'};
    const targetRead=rel('read-target','READ',['m'],null,'2026-01-03','alice');
    const before=[category,impact,targetRead];
    const input=(relations:Relation[])=>fixture([text('m')],relations,getLatestUserReadStatusByMessageId(relations,item=>item.createdBy.username==='alice'));
    const pending=deriveDisplayHints(input(before));
    expect((type==='CORRECT'?pending.correctionHints:pending.hints).get('m')?.relatedUnreadIds).toContain('impact');
    const impactRead=rel('read-impact','READ',['impact'],null,'2026-01-04','alice');
    const acknowledged=deriveDisplayHints(input([...before,impactRead]));
    expect((type==='CORRECT'?acknowledged.correctionHints:acknowledged.hints).get('m')?.relatedUnreadIds).toEqual([]);
    expect(acknowledged.hints.get('impact')?.unread).toBe(false);
    const impactUnread=rel('unread-impact','UNREAD',['impact'],null,'2026-01-05','alice');
    const reopened=deriveDisplayHints(input([...before,impactRead,impactUnread]));
    expect((type==='CORRECT'?reopened.correctionHints:reopened.hints).get('m')?.relatedUnreadIds).toContain('impact');
  });

  it('keeps correction notifications until those correction records are read individually',()=>{
    const category=rel('category','CLASSIFY'),first=rel('first','CORRECT',['category']);
    first.payload={correctionBeforeContent:'category',correctionAfterContent:'修改一'};
    const before=fixture([], [category,first]);
    const read=rel('read','READ',['category'],null,'2026-01-03','alice');
    read.payload={readDisplay:{category:getMessageDisplaySignature(before,'category')!},readDisplayParts:{category:getMessageDisplayParts(before,'category')!}};
    const status=new Map<string,'READ'|'UNREAD'>([['category','READ']]);
    const seen=deriveDisplayHints(fixture([], [category,first,read],status));
    expect(seen.correctionHints.get('category')).toMatchObject({relatedUnreadIds:['first'],readChanged:false});
    expect(seen.hints.get('first')?.unread).toBe(true);
    const second=rel('second','CORRECT',['category'],null,'2026-01-04');
    second.payload={correctionBeforeContent:'category',correctionAfterContent:'修改二'};
    status.set('first','READ');
    const updated=deriveDisplayHints(fixture([], [category,first,read,second],status));
    expect(updated.hints.get('category')?.relatedUnreadIds).toEqual(['second']);
    expect(updated.correctionHints.get('category')).toMatchObject({relatedUnreadIds:['second'],readChanged:true});
  });

  it('does not treat reading a container as reading its member messages',()=>{
    const time='2026-01-03T00:00:00.000Z';
    const category={...rel('category','CLASSIFY',['earlier','later']),sequence:1};
    const read={...rel('read','READ',['category'],null,time,'alice'),sequence:10};
    const input=fixture([{...text('earlier'),createdAt:time},{...text('later'),createdAt:time}],
      [category,read],new Map([['category','READ']]));
    const {hints}=deriveDisplayHints(input);
    expect(hints.get('category')).toMatchObject({relatedUnreadIds:[],unreadMemberCount:2});
    expect(hints.get('earlier')?.unread).toBe(true);
    expect(hints.get('later')?.unread).toBe(true);
  });

  it('distinguishes explicit unread, unmarked and own messages without creating records',()=>{
    const input=fixture([text('pending'),text('read'),text('mine','mine','alice'),text('marked','marked','alice')],[],new Map([['read','READ'],['marked','UNREAD']]));
    const before=JSON.stringify(input.messages),status=[...input.readStatus],{hints}=deriveDisplayHints(input);
    expect(hints.get('pending')).toMatchObject({unread:true,explicitlyUnread:false});
    expect(hints.get('read')?.unread).toBe(false);expect(hints.get('mine')?.unread).toBe(false);
    expect(hints.get('marked')).toMatchObject({unread:true,explicitlyUnread:true});
    expect(JSON.stringify(input.messages)).toBe(before);expect([...input.readStatus]).toEqual(status);
    expect(deriveDisplayHints({...input,username:null}).hints.get('pending')?.unread).toBe(false);
  });

  it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE'])('keeps released %s members as the destination and summarizes their progress on parents',type=>{
    const relations=[rel('A','CLASSIFY',['C']),rel('C',type),rel('old','JOIN',['m'],'A','2026-01-02'),
      rel('new','JOIN',['m'],'C','2026-01-03'),rel('opposition','DISAGREE',['C'],null,'2026-01-04')];
    relations[1].state={messageId:'C',revision:1,suppressed:true,supportCount:0,oppositionCount:1,recommendationTotal:0};
    const read=new Map<string,'READ'|'UNREAD'>(['A','C','old','new','m'].map(id=>[id,'READ'])),input=fixture([text('m')],relations,read);
    expect(input.personalEffect.ownership.direct('A').textIds.has('m')).toBe(true);
    for(const id of ['C','m'])expect(deriveDisplayHints(input).hints.get(id)).toMatchObject({unread:false,relatedUnreadIds:['opposition']});
    expect(deriveDisplayHints(input).hints.get('A')).toMatchObject({relatedUnreadIds:[],unreadMemberCount:2});
    expect(displayHintDestination(input,'m')).toEqual({kind:'related',id:'m'});
    expect(displayHintDestination(input,'opposition')).toEqual({kind:'container',id:'C'});
    expect(displayHintDestination(input,'opposition',true)).toEqual({kind:'related',id:'opposition'});
    const preview={...input,displayEffect:deriveContainerEffect({...input,stakeCounts:{},assumption:{messageId:'C',side:'agree'}})};
    expect(deriveDisplayHints(preview).hints.get('C')).toMatchObject({matchesPersonal:false,matchesRecommended:false});
    read.set('opposition','READ');
    for(const id of ['C','m','A'])expect(deriveDisplayHints(withFixtureReadingMarks(input)).hints.get(id)?.relatedUnreadIds).toEqual([]);
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
    const oldMarker=screen.getByRole('button',{name:/显示提示 old：.*推荐不显示/});
    expect(oldMarker).toHaveAccessibleName(/选择显示/);
    expect(oldMarker).toHaveStyle({color:'var(--ink-fca5a5)'});
    const newMarker=screen.getByRole('button',{name:/显示提示 new：.*推荐显示/});
    expect(newMarker).toHaveAccessibleName(/选择不显示/);
    expect(newMarker).toHaveStyle({color:'var(--ink-86efac)'});
    fireEvent.click(oldMarker);
    expect(screen.getByRole('tooltip')).toHaveTextContent('选择显示');
    expect(screen.getByRole('tooltip')).toHaveTextContent('推荐不显示');
    expect(screen.getByRole('group',{name:'选择与推荐不一致'})).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).not.toHaveTextContent(/个人选择优先|当前对你|与我的选择|当前显示与统计结果/);
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('统计');
  });

  it('compares a correction record with the adopted body and reuses correction history/view destinations',()=>{
    const relations=[rel('first','CORRECT',['m']),rel('second','CORRECT',['m'],null,'2026-01-03'),rel('choice','AGREE',['first'],null,'2026-01-04','alice')];
    relations[0].payload={correctionBeforeContent:'原文',correctionAfterContent:'我的版本'};
    relations[1].payload={correctionBeforeContent:'原文',correctionAfterContent:'推荐版本'};
    relations[1].state={messageId:'second',revision:1,suppressed:false,supportCount:3,oppositionCount:0,recommendationTotal:0};
    const input=fixture([text('m','原文')],relations),data=deriveDisplayHints(input);
    expect(correctionRecordHint(input,data,'first')).toMatchObject({matchesPersonal:true,matchesRecommended:false});
    expect(correctionRecordHint(input,data,'second')).toMatchObject({matchesPersonal:false,matchesRecommended:true});
    expect(displayHintDestination(input,'m')).toEqual({kind:'related',id:'m'});
    expect(displayHintDestination(input,'second',true)).toEqual({kind:'corrections',id:'second'});
    const preview=computeCorrectionVersions(input.messages,input.edges,new Set(),input.username,{previewCorrectionId:'second'});
    expect(deriveDisplayHints({...input,displayCorrections:preview}).correctionHints.get('m')).toMatchObject({
      matchesPersonal:false,matchesRecommended:true,personal:{content:'我的版本'},recommended:{content:'推荐版本'},
    });
  });

  it('shows shared influences across all display versions in both message and correction hints',()=>{
    const category=rel('category','CLASSIFY'),before=fixture([], [category]);
    const read=rel('read','READ',['category'],null,'2026-01-03','alice');
    read.payload={readDisplay:{category:getMessageDisplaySignature(before,'category')!},readDisplayParts:{category:getMessageDisplayParts(before,'category')!}};
    const first=rel('first','CORRECT',['category'],null,'2026-01-04'),second=rel('second','CORRECT',['category'],null,'2026-01-05');
    first.payload={correctionBeforeContent:'category',correctionAfterContent:'修改一'};
    second.payload={correctionBeforeContent:'category',correctionAfterContent:'修改二'};
    const input=fixture([], [category,first,second,read],new Map([['category','READ']])),data=deriveDisplayHints(input);
    expect(data.hints.get('category')).toMatchObject({unread:false,relatedUnreadIds:['second','first'],otherVersionUnreadCount:0,readChanged:true,matchesRecommended:true});
    expect(data.correctionHints.get('category')).toMatchObject({unread:false,relatedUnreadIds:['second','first'],otherVersionUnreadCount:0,readChanged:true});
    const onView=vi.fn(),view=render(<MessageDisplayHintsProvider input={input} onView={onView}>
      <span>category<MessageDisplayMarker messageId="category" /></span>
      <span>✏更正 2<MessageDisplayMarker messageId="category" scope="corrections" /></span>
    </MessageDisplayHintsProvider>);
    expect(view.container.querySelectorAll('[data-display-hint-scope="corrections"]')).toHaveLength(1);
    const body=screen.getByRole('button',{name:/更正显示提示 category/});expect(body.getAttribute('aria-label')).toContain('2 条影响待阅');
    expect(body.getAttribute('aria-label')).toContain('与上次已阅不同');fireEvent.click(body);expect(onView).not.toHaveBeenCalled();
    view.rerender(<MessageDisplayHintsProvider input={{...input,readStatus:new Map([['category','UNREAD']]),readingMarks:[...input.readingMarks??[],{...input.readingMarks!.find(mark=>mark.messageId==='category'&&mark.scope==='message')!,state:'UNREAD',position:100,firstConfirmedAt:'2026-01-03'}]}} onView={onView}>
      <MessageDisplayMarker messageId="category" /><MessageDisplayMarker messageId="category" scope="corrections" />
    </MessageDisplayHintsProvider>);
    expect(screen.getByRole('button',{name:/^显示提示 category：消息待阅/})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:/^更正显示提示 category：.*2 条影响待阅/})).toBeInTheDocument();
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
    expect(deriveDisplayHints(fixture([text('m','后来正文')],[read,withoutCode])).hints.get('m')?.readChanged).toBe(false);
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
  it.each(['source','m'])('updates the original influence after opening its ID from the %s hint in a comparison pane',async targetId=>{
    const input=fixture([text('source'),text('m')],[rel('reference','REFERENCE',['m'],'source')]);
    const onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{}),windowState=createDisplayHintWindow();
    const element=(value:DisplayHintsInput,comparison:boolean)=><MessageDisplayHintsProvider input={value} onView={vi.fn()} onMarkRead={onMarkRead} onReadNavigate={vi.fn()} windowState={windowState}>
      {comparison?<MessageDisplayHintsScope messageId="m" side="agree"><MessageDisplayMarker messageId={targetId}/></MessageDisplayHintsScope>:<><MessageDisplayMarker messageId="source"/><MessageDisplayMarker messageId="m"/><MessageDisplayMarker messageId="reference"/></>}
    </MessageDisplayHintsProvider>;
    const view=render(element(input,true));fireEvent.click(screen.getByRole('button',{name:new RegExp(`^显示提示 ${targetId}：`)}));
    fireEvent.click(screen.getByTitle('查看引用 reference'));
    view.rerender(element(input,false));fireEvent.click(screen.getByRole('button',{name:/^显示提示 reference：/}));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'})));
    const updated={...input,readingMarks:[...input.readingMarks??[],...onMarkRead.mock.calls[0][0]]};
    view.rerender(element(updated,false));
    expect(screen.getByRole('button',{name:'当前消息已阅'})).toBeDisabled();
    expect(screen.getByRole('button',{name:/^显示提示 reference：消息已阅/})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:new RegExp(`^显示提示 ${targetId}：`)}));
    expect(effectDetails()).toHaveTextContent('已阅影响（1 条）');
    expect(screen.queryByRole('button',{name:'跳转未读'})).toBeNull();
    expect(deriveDisplayHints(updated).hints.get(targetId)?.relatedUnreadIds).toEqual([]);
    expect(deriveDisplayHints(updated).hints.get(targetId==='source'?'m':'source')?.relatedUnreadIds).toContain('reference');
    expect(onMarkRead).toHaveBeenCalledOnce();
  });
  it('disables completed message and influence confirmation and enables newly arrived effects',async()=>{
    const input=fixture([text('m')],[rel('reply','REPLY',['m'])]),onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    const element=(value:DisplayHintsInput)=><MessageDisplayHintsProvider input={value} onView={vi.fn()} onMarkRead={onMarkRead}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'})));
    const read={...input,readingMarks:onMarkRead.mock.calls[0][0]};view.rerender(element(read));
    const completed=screen.getByRole('button',{name:'当前消息已阅'});expect(completed).toBeDisabled();
    expect(completed).toHaveStyle({color:'var(--ink-64748b)',background:'var(--surface-26303d)'});fireEvent.click(completed);
    expect(onMarkRead).toHaveBeenCalledOnce();
    const message=screen.getByRole('region',{name:'消息阅读确认'});
    expect(message).toHaveTextContent('消息 · 【文本】 m');expect(message).not.toHaveTextContent('（已阅）');
    expect(within(screen.getByRole('tooltip')).queryByText('消息已阅')).toBeNull();
    expect(screen.getByRole('button',{name:/^展开已阅影响/})).toHaveAttribute('aria-expanded','false');
    expect(within(screen.getByRole('region',{name:'相关影响'})).getByText('影响已阅')).not.toBeVisible();
    const changed={...fixture([text('m')],[...input.relations,rel('vote','AGREE',['m'])]),readingMarks:read.readingMarks};view.rerender(element(changed));
    expect(screen.getByRole('button',{name:/^收起未阅影响/})).toHaveAttribute('aria-expanded','true');
    const confirmNew=screen.getByRole('button',{name:'确认新影响'});
    expect(confirmNew).toBeEnabled();expect(confirmNew).toHaveStyle({color:'var(--ink-bae6fd)',background:'var(--surface-243448)'});
    await act(async()=>fireEvent.click(confirmNew));
    expect(onMarkRead.mock.calls[1][0].filter(mark=>mark.scope==='influence').map(mark=>JSON.parse(mark.eventId!)[0])).toEqual(['vote']);
    view.rerender(element({...changed,readingMarks:[...read.readingMarks,...onMarkRead.mock.calls[1][0]]}));
    expect(screen.getByRole('button',{name:'当前消息已阅'})).toBeDisabled();
    expect(effectDetails()).toHaveTextContent('影响已阅');
  });
  it('confirms a pending origin separately when its record was already read, and preserves it after a failed save',async()=>{
    const initial=fixture([text('source'),text('m')],[rel('reference','REFERENCE',['m'],'source')]);
    const input={...initial,readingMarks:readingMarksFor(initial,'reference',deriveDisplayHints(initial).hints.get('reference')!.displayed)};
    const onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>().mockRejectedValueOnce(new Error('保存失败')).mockResolvedValue(undefined);
    const element=(value:DisplayHintsInput)=><MessageDisplayHintsProvider input={value} onView={vi.fn()} onMarkRead={onMarkRead} onReadNavigate={vi.fn()}>
      <MessageDisplayMarker messageId="source"/><MessageDisplayMarker messageId="reference"/>
    </MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/^显示提示 source：/}));
    fireEvent.click(screen.getByTitle('查看引用 reference'));fireEvent.click(screen.getByRole('button',{name:/^显示提示 reference：/}));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'确认本次影响'})));
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败');expect(screen.getByRole('button',{name:'确认本次影响'})).toBeEnabled();
    expect(deriveDisplayHints(input).hints.get('source')?.relatedUnreadIds).toContain('reference');
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'确认本次影响'})));
    view.rerender(element({...input,readingMarks:[...input.readingMarks,...onMarkRead.mock.calls[1][0]]}));
    expect(screen.getByRole('button',{name:'当前消息已阅'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 source：/}));expect(effectDetails()).toHaveTextContent('影响已阅');
  });
  it('confirms the original influence only after jumping to and reading its record, preserving other targets and newer events',async()=>{
    const records=[text('source'),text('m'),text('peer')],relations=[rel('reference','REFERENCE',['m','peer'],'source')];
    const before=fixture(records,relations),onMarkRead=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={onMarkRead} onReadNavigate={vi.fn()}>
      <MessageDisplayMarker messageId="m"/><MessageDisplayMarker messageId="reference" viewTag/>
    </MessageDisplayHintsProvider>;
    const view=render(element(before));fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    expect(within(effectDetails()).queryByRole('button',{name:/已阅/})).toBeNull();
    fireEvent.click(screen.getByTitle('查看引用 reference'));expect(onMarkRead).not.toHaveBeenCalled();
    const later=fixture(records,[...relations,rel('later-reference','REFERENCE',['m'],'source')]);view.rerender(element(later));
    fireEvent.click(screen.getByRole('button',{name:/^查看消息 reference：/}));
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 reference：/}));
    const confirm=screen.getByRole('button',{name:'标记当前消息已阅'});expect(effectDetails()).toHaveTextContent('影响目标 · m');
    await act(async()=>fireEvent.click(confirm));
    const marks=onMarkRead.mock.calls[0][0],after=deriveDisplayHints({...later,readingMarks:marks});
    expect(after.hints.get('reference')?.unread).toBe(false);
    expect(after.hints.get('m')?.relatedUnreadIds).toEqual(['later-reference']);
    expect(after.hints.get('peer')?.relatedUnreadIds).toContain('reference');
    expect(marks.some(mark=>mark.messageId==='peer')).toBe(false);
  });
  it('collapses confirmation and membership sections and restores them with the saved window',()=>{
    const input=fixture([text('member')],[rel('container','CLASSIFY'),rel('join','JOIN',['member'],'container'),rel('vote','AGREE',['container']),rel('reply','REPLY',['container'])]);
    const windowState=createDisplayHintWindow(),onReadNavigate=vi.fn(),onMarkRead=vi.fn(async()=>{});
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onReadNavigate={onReadNavigate} onMarkRead={onMarkRead} windowState={windowState}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 container：/}));
    const automatic=screen.getByRole('region',{name:'消息阅读确认'}),individual=screen.getByRole('region',{name:'成员消息'});
    expandEffects();
    expect(within(automatic).queryByRole('button',{name:'跳转未读'})).toBeNull();
    expect(within(individual).queryByRole('button',{name:/已阅/})).toBeNull();
    expect(individual).toHaveTextContent('消息待阅');
    for(const name of [/^收起当前采用/,/^收起未采用/,/^收起成员消息/,/^收起未阅影响/])fireEvent.click(screen.getByRole('button',{name}));
    expect(within(individual).queryByRole('button',{name:'查看被加入目标 member'})).toBeNull();
    expect(within(automatic).getByRole('button',{name:'标记当前消息已阅'})).toBeVisible();
    const saved=windowState.capture();expect(new Set(saved?.collapsedSections)).toEqual(new Set(['members-read','read-influences','legend','adopted','unadopted','individual','automatic']));
    act(()=>{windowState.suspend();});expect(screen.queryByRole('tooltip')).toBeNull();
    act(()=>{windowState.restore(saved);});
    expect(screen.getByRole('button',{name:/^展开未阅影响/})).toHaveAttribute('aria-expanded','false');
    fireEvent.click(screen.getByRole('button',{name:/^展开未阅影响/}));
    expect(screen.getByRole('button',{name:'收起赞同（1 条）'})).toHaveAttribute('aria-expanded','true');
    expect(screen.getByTitle('查看赞同 vote')).toBeVisible();
    expect(screen.getByRole('button',{name:'展开状态标志说明'})).toHaveAttribute('aria-expanded','false');
    fireEvent.click(screen.getByRole('button',{name:'展开成员消息'}));
    expect(screen.getByRole('button',{name:/^展开当前采用/})).toHaveAttribute('aria-expanded','false');
    expect(onMarkRead).not.toHaveBeenCalled();expect(onReadNavigate).not.toHaveBeenCalled();
  });
  it('restores a pinned hint and both scroll positions after its message remounts, and remembers an explicit close',()=>{
    const input=fixture([text('m'),text('destination')],Array.from({length:12},(_,index)=>rel(`impact-${index}`,'REPLY',['m'])));
    const windowState=createDisplayHintWindow(),onView=vi.fn(),element=(id:string)=><MessageDisplayHintsProvider input={input} onView={onView} windowState={windowState}>
      <MessageDisplayMarker key={id} messageId={id}/>
    </MessageDisplayHintsProvider>;
    const view=render(element('m'));
    fireEvent.click(screen.getByRole('button',{name:/显示提示 m：/}));
    const tooltip=screen.getByRole('tooltip'),list=tooltip.querySelector<HTMLElement>('[data-display-hint-influences]')!;
    tooltip.scrollTop=21;list.scrollTop=93;fireEvent.scroll(list);
    fireEvent.click(effectButton('回复 · impact-5'));
    expect(onView).toHaveBeenCalledWith('impact-5',expect.anything(),true);
    const saved=windowState.capture();act(()=>{windowState.suspend();});view.rerender(element('destination'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    view.rerender(element('m'));act(()=>{windowState.restore(saved);});
    const restored=screen.getByRole('tooltip');
    expect(restored.scrollTop).toBe(21);expect(restored.querySelector('[data-display-hint-influences]')!.scrollTop).toBe(93);
    fireEvent.pointerDown(document.body);view.rerender(element('destination'));view.rerender(element('m'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('labels a JOIN into the current container and keeps its explicit influence confirmation',async()=>{
    const input=fixture([text('m')],[rel('A','CLASSIFY'),rel('B','CLASSIFY'),rel('here','JOIN',['m'],'A','2026-01-03'),rel('other','JOIN',['m'],'B')]);
    const onView=vi.fn(),onMarkRead=vi.fn(async()=>{});
    render(<MessageDisplayHintsProvider input={input} onView={onView} onMarkRead={onMarkRead} currentContainerId="A"><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/显示提示 m：/}));
    const tooltip=screen.getByRole('tooltip');
    expect(within(tooltip).getByText('分类：A（当前）')).toBeInTheDocument();
    expect(within(tooltip).getByText('分类：B')).toBeInTheDocument();
    expect(within(tooltip).queryByRole('button',{name:/^被加入 · here/})).toBeNull();
    expect(within(tooltip).queryByRole('button',{name:'标记加入 here 已阅'})).toBeNull();
    expect(within(effectDetails()).queryByRole('button',{name:/已阅/})).toBeNull();
    await act(async()=>fireEvent.click(within(tooltip).getByRole('button',{name:'标记当前消息已阅'})));
    expect(onMarkRead).toHaveBeenCalledOnce();expect(onView).not.toHaveBeenCalled();
    fireEvent.click(effectButton(/^被加入 · other/));expect(onView).toHaveBeenCalledWith('other',expect.anything(),true);
  });
  it('updates the marker and tooltip through unread, read and explicitly unread without removing the read marker',()=>{
    const pending=fixture([text('m')],[]),onView=vi.fn();
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={onView}><MessageDisplayMarker messageId="m" /></MessageDisplayHintsProvider>;
    const view=render(element(pending));
    expect(screen.getByRole('button',{name:/显示提示 m：消息待阅/})).toHaveAttribute('data-display-reading','unread');
    const read=rel('read','READ',['m'],null,'2026-01-03','alice');
    read.payload={readDisplay:{m:getMessageDisplaySignature(pending,'m')!}};
    const readInput=fixture([text('m')],[read],new Map([['m','READ']]));
    view.rerender(element(readInput));
    const marker=screen.getByRole('button',{name:/显示提示 m：消息已阅；/});
    expect(marker).toHaveAttribute('data-display-reading','read');
    fireEvent.click(marker);
    expect(screen.getByRole('tooltip')).toHaveTextContent('已阅');
    expect(screen.getByRole('tooltip')).toHaveTextContent('与上次已阅一致');
    const unread=rel('unread','UNREAD',['m'],null,'2026-01-04','alice');
    view.rerender(element(fixture([text('m')],[read,unread],new Map([['m','UNREAD']]))));
    expect(screen.getByRole('button',{name:/显示提示 m：消息待阅/})).toHaveAttribute('data-display-reading','unread');
    expect(screen.getByRole('tooltip')).toHaveTextContent('消息待阅');
    expect(onView).not.toHaveBeenCalled();
  });

  it.each([true,false].flatMap(personal=>[true,false].flatMap(statistical=>[true,false].map(unread=>({personal,statistical,unread})))))(
    'encodes the target outcome independently: choice $personal, statistics $statistical, unread $unread',({personal,statistical,unread})=>{
      const target=rel('target','CLASSIFY'),stance=rel('stance','AGREE',['target']);
      target.state={messageId:'target',revision:1,suppressed:!statistical,supportCount:statistical?2:0,oppositionCount:statistical?0:2,recommendationTotal:0};
      const input=fixture([], [target,stance],unread?new Map():new Map([['stance','READ']]));
      input.personalEffect=deriveContainerEffect({...input,stakeCounts:{},assumption:{messageId:'target',side:personal?'agree':'disagree'}});
      const view=render(<MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="stance" /></MessageDisplayHintsProvider>);
      const marker=screen.getByRole('button',{name:/显示提示 stance/});
      expect(marker).toHaveAttribute('data-display-personal',personal?'active':'inactive');
      expect(marker).toHaveAttribute('data-display-statistical',statistical?'active':'inactive');
      expect(marker).toHaveAttribute('data-display-reading',unread?'unread':'read');
      expect(marker.querySelector(statistical?'circle':'rect')).not.toBeNull();
      expect(marker).toHaveStyle({color:statistical?'var(--ink-86efac)':'var(--ink-fca5a5)'});
      expect(marker).toHaveAttribute('data-display-comparison',personal!==statistical?'different':'same');
      expect(marker.querySelector('path')).toHaveAttribute('stroke',personal!==statistical?'var(--ink-7dd3fc)':'var(--ink-94a3b8)');
      expect(marker.querySelector('path')).toHaveAttribute('d',`M5 6.5h6M5 9.5h6${personal!==statistical?'M9.5 4.5l-3 7':''}`);
      expect(marker.querySelector('[data-display-hint-mismatch]')).toBeNull();
      expect(marker).toHaveAccessibleName(new RegExp(`${personal?'选择显示':'选择不显示'}；${statistical?'推荐显示':'推荐不显示'}`));
      view.unmount();
    });

  it('resolves chained opposition and JOIN selection instead of using the stance record state',()=>{
    const relations=[rel('A','CLASSIFY'),rel('B','CLASSIFY'),rel('old','JOIN',['m'],'A','2026-01-02'),
      rel('new','JOIN',['m'],'B','2026-01-03'),rel('choice','AGREE',['old'],null,'2026-01-04','alice'),
      rel('opposition','DISAGREE',['choice'],null,'2026-01-05','bob')];
    const data=deriveDisplayHints(fixture([text('m')],relations));
    expect(data.hints.get('choice')).toMatchObject({personalActive:true,recommendedActive:false});
    expect(data.hints.get('opposition')).toMatchObject({personalActive:false,recommendedActive:true});
  });

  it('keeps a message ID status independent from its correction choices and reading versions',()=>{
    const category={...rel('category','CLASSIFY'),parts:[{id:'body',type:'text' as const,text:'原文'}]};
    const own={...rel('own','CORRECT',['category'],null,'2026-01-03','alice'),payload:{correctionBeforeContent:'原文',correctionAfterContent:'个人正文'}};
    const recommended={...rel('public','CORRECT',['category']),payload:{correctionBeforeContent:'原文',correctionAfterContent:'推荐正文'},
      state:{messageId:'public',revision:1,suppressed:false,supportCount:10,oppositionCount:0,recommendationTotal:0}};
    const element=(input:DisplayHintsInput)=><MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="category"/><MessageDisplayMarker messageId="own"/></MessageDisplayHintsProvider>;
    const view=render(element(fixture([],[category,own,recommended]))),marker=screen.getByRole('button',{name:/显示提示 category/});
    expect(marker).toHaveAttribute('data-display-personal','active');expect(marker).toHaveAttribute('data-display-statistical','active');
    expect(marker).toHaveAttribute('data-display-comparison','same');
    const correctionStatus=screen.getByRole('button',{name:/显示提示 own/});
    expect(correctionStatus).toHaveAttribute('data-display-comparison','different');expect(correctionStatus.querySelector('rect')).not.toBeNull();
    expect(screen.getByRole('button',{name:'切换消息 category 的版本'}).querySelector('[data-reading-version-recommendation-difference]')).not.toBeNull();
    fireEvent.click(marker);expect(screen.getByRole('group',{name:'选择与推荐一致'})).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent('内部 = / ≠：本消息在选择与推荐下显示相同／不同');
    expect(screen.getByRole('tooltip')).toHaveTextContent('外框圆形实线／方形虚线：推荐有效／无效');
    view.rerender(element(fixture([],[category,own,recommended,rel('choice','AGREE',['public'],null,'2026-01-04','alice')])));
    expect(marker).toHaveAttribute('data-display-comparison','same');
    expect(screen.getByRole('group',{name:'选择与推荐一致'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'切换消息 category 的版本'}).querySelector('[data-reading-version-recommendation-difference]')).toBeNull();
    const hidden={...category,state:{messageId:'category',revision:1,suppressed:true,supportCount:0,oppositionCount:5,recommendationTotal:0}};
    view.rerender(element(fixture([],[hidden,own,recommended])));
    expect(marker).toHaveAttribute('data-display-personal','inactive');expect(marker).toHaveAttribute('data-display-statistical','inactive');
    expect(marker).toHaveAttribute('data-display-comparison','same');expect(marker.querySelector('rect')).not.toBeNull();
    expect(screen.getByRole('group',{name:'选择与推荐一致'})).toHaveTextContent('选择不显示');
    expect(screen.getByRole('group',{name:'选择与推荐一致'})).toHaveTextContent('推荐不显示');
  });

  it('keeps equal corrected bodies consistent when the container has different selected and recommended members',()=>{
    const category={...rel('category','CLASSIFY'),parts:[{id:'body',type:'text' as const,text:'原文'}]};
    const relations=[category,rel('other','CLASSIFY'),rel('old','JOIN',['child'],'category','2026-01-02'),
      rel('new','JOIN',['child'],'other','2026-01-03'),rel('choice','AGREE',['old'],null,'2026-01-04','alice'),
      {...rel('correction','CORRECT',['category'],null,'2026-01-05','alice'),payload:{correctionBeforeContent:'原文',correctionAfterContent:'相同更正正文'}}];
    const input=fixture([text('child')],relations),hint=deriveDisplayHints(input).hints.get('category')!;
    expect(hint.personal.content).toBe('相同更正正文');expect(hint.recommended.content).toBe('相同更正正文');
    expect(hint.personal.memberIds).toEqual(['child']);expect(hint.recommended.memberIds).toEqual([]);
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="category"/></MessageDisplayHintsProvider>);
    const marker=screen.getByRole('button',{name:/显示提示 category/});expect(marker).toHaveAttribute('data-display-comparison','same');
    expect(marker.querySelector('circle')).not.toBeNull();expect(marker.querySelector('[data-display-hint-mismatch]')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'切换消息 category 的版本'}));
    expect(screen.getByRole('radio',{checked:true})).toHaveTextContent('与当前用户选择相同');
  });

  it('uses the displayed container result when stake totals override its stored suppression flag',()=>{
    const target=rel('target','CLASSIFY'),stance=rel('stance','AGREE',['target']);
    target.state={messageId:'target',revision:1,suppressed:true,supportCount:3,oppositionCount:1,recommendationTotal:0};
    const input=fixture([], [target,stance]);
    input.personalEffect=deriveContainerEffect({...input,stakeCounts:{target:{truth:{pro:31,con:1},value:{pro:1,con:10}}}});
    const data=deriveDisplayHints(input);
    expect(data.recommendedEffect.suppressed.has('target')).toBe(false);
    expect(data.hints.get('stance')).toMatchObject({personalActive:true,recommendedActive:true});
  });

  it('only explains status without navigating, selecting the card or marking read',()=>{
    const input=fixture([text('m')],[]),onView=vi.fn(),onClick=vi.fn(),onMouseDown=vi.fn(),before=[...input.readStatus];
    render(<MessageDisplayHintsProvider input={input} onView={onView}><MessageCard msg={input.messages[0]} ctx={{}} onClick={onClick} onMouseDown={onMouseDown}/></MessageDisplayHintsProvider>);
    const marker=screen.getByRole('button',{name:/显示提示 m：消息待阅/});fireEvent.mouseDown(marker);fireEvent.click(marker);fireEvent.doubleClick(marker);
    expect(onView).not.toHaveBeenCalled();expect(onClick).not.toHaveBeenCalled();expect(onMouseDown).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();expect([...input.readStatus]).toEqual(before);
  });

  it('shows a non-interactive summary on hover or focus and expands pinned details only on click',()=>{
    const input=fixture([text('m')],[rel('reply','REPLY',['m'])]),onView=vi.fn(),onMarkRead=vi.fn(async()=>{});
    render(<MessageDisplayHintsProvider input={input} onView={onView} onMarkRead={onMarkRead}><MessageDisplayMarker messageId="m" /></MessageDisplayHintsProvider>);
    const marker=screen.getByRole('button',{name:/显示提示 m：消息待阅/});
    fireEvent.mouseEnter(marker);
    const tooltip=screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('消息待阅');expect(tooltip).toHaveTextContent('选择显示');
    expect(tooltip).toHaveTextContent('推荐显示');expect(tooltip).toHaveTextContent('1 条影响待阅');expect(tooltip).toHaveTextContent('点击展开详情');
    expect(tooltip).toHaveAttribute('data-display-hint-mode','summary');expect(tooltip).toHaveStyle({pointerEvents:'none'});
    expect(within(tooltip).queryByRole('button')).toBeNull();expect(tooltip).not.toHaveTextContent('回复 · reply');
    expect(marker).toHaveAttribute('aria-expanded','false');expect(marker).toHaveStyle({cursor:'pointer'});
    expect(marker).toHaveAttribute('aria-describedby',tooltip.id);expect(marker).not.toHaveAttribute('title');
    fireEvent.mouseLeave(marker);expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(marker);
    const details=screen.getByRole('tooltip');expect(details).toHaveAttribute('data-display-hint-mode','details');
    expect(details).toHaveTextContent('消息状态与影响');expect(details).not.toHaveTextContent('点击展开详情');
    expect(within(details).getByRole('button',{name:'标记当前消息已阅'})).toBeInTheDocument();
    expandEffects();expect(details).toHaveTextContent('确认影响不代替阅读对应消息本身。');
    expect(within(details).getByRole('button',{name:'回复 · reply'})).toBeInTheDocument();
    expect(within(details).queryByRole('button',{name:'标记回复 reply 已阅'})).toBeNull();
    expect(details).toHaveTextContent('影响待阅');
    expect(screen.getByRole('group',{name:'选择与推荐一致'})).toBeInTheDocument();expect(marker).toHaveAttribute('aria-expanded','true');
    fireEvent.mouseLeave(marker);expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(marker,{key:'Escape'});expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(marker);fireEvent.pointerDown(document.body);expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(marker);expect(screen.getByRole('tooltip')).toHaveAttribute('data-display-hint-mode','summary');
    fireEvent.blur(marker);expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(marker);fireEvent.click(screen.getByRole('button',{name:'关闭消息提示'}));expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onView).not.toHaveBeenCalled();expect(onMarkRead).not.toHaveBeenCalled();
  });

  it('offers a small View tag and shows consistency only in the existing hint',()=>{
    const input=fixture([text('m')],[]),onView=vi.fn();
    render(<MessageDisplayHintsProvider input={input} onView={onView}><MessageDisplayMarker messageId="m" viewTag/></MessageDisplayHintsProvider>);
    const tag=screen.getByRole('button',{name:/查看消息 m/});expect(tag).toHaveTextContent('查看');expect(tag.getAttribute('aria-label')).toContain('选择显示');
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
    expect(screen.getByRole('group',{name:'选择与推荐一致'})).toBeInTheDocument();
  });
});
