import {act,fireEvent,render,screen,within} from '@testing-library/react';
import {useState} from 'react';
import {describe,expect,it,vi} from 'vitest';
import {bodyVersionKey,messageReadingKey,type ReadingMark} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {MessageDisplayHintsProvider,MessageDisplayMarker} from '../components/MessageDisplayHints';
import StanceReadingReminder from '../components/StanceReadingReminder';
import CorrectionComparisonPopup from '../components/CorrectionComparisonPopup';
import TraceReadingController from '../components/TraceReadingController';
import {convertMessagesToDemoModel,computeCorrectionVersions} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {deriveDisplayHints} from '../pages/workbench/model/displayHints';
import {influenceReadingMarks,readingMarksFor} from '../pages/workbench/model/readingProgress';

const writer={id:'writer',username:'writer',createdAt:''};
const text=(id:string):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:'2026-01-01',createdBy:writer});
const relation=(id:string,type:string,targets=['m'],source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,
  targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdAt:'2026-01-02',createdBy:writer,
  payload:type==='CORRECT'?{correctionBeforeContent:'m',correctionAfterContent:id}:{title:id}});
const fixture=(relations:Relation[]=[],readingMarks:ReadingMark[]=[])=>{
  const model=convertMessagesToDemoModel([text('m'),text('peer')],relations);
  const personalEffect=deriveContainerEffect({...model,relations,username:'viewer',stakeCounts:{}});
  return {...model,relations,personalEffect,readingMarks,username:'viewer',readStatus:new Map<string,'READ'|'UNREAD'>(),corrections:computeCorrectionVersions(model.messages,model.edges)};
};

describe('one reading confirmation with separate message and influence records',()=>{
  it.each(['AGREE','DISAGREE','TAG','RECOMMEND','ARCHIVE'])('does not list the current text as its own influence target when reading an inline %s',async type=>{
    const input=fixture([relation('event',type,['m','peer'])]),save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    const scope=new Set(['m']);
    const element=(value:typeof input)=><MessageDisplayHintsProvider input={value} onView={vi.fn()} onMarkRead={save}>
      <MessageDisplayMarker messageId="m"/>
      <TraceReadingController scopeKey="self-target" scopeIds={scope} allowedIds={scope} direction="both" order="discussion" onOrder={vi.fn()}
        path={[]} focusId="m" focusLocated incoming={[]} ready onNavigate={vi.fn(async()=>{})} onBack={vi.fn()}/>
    </MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    const popup=within(screen.getByRole('tooltip')),influences=popup.getByRole('region',{name:'相关影响'});
    expect(influences).not.toHaveTextContent('影响目标 · m');
    expect(within(influences).getByRole('button',{name:'收起未阅影响（1 条）'})).toBeVisible();
    await act(async()=>fireEvent.click(popup.getByRole('button',{name:'标记当前消息已阅'})));
    const marks=save.mock.calls[0][0];
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m']);
    expect(marks.filter(mark=>mark.scope==='influence')).toEqual([expect.objectContaining({messageId:'m',eventId:expect.stringContaining('event')})]);
    const after={...input,readingMarks:marks};view.rerender(element(after));
    expect(popup.getByRole('button',{name:'当前消息已阅'})).toBeDisabled();
    expect(deriveDisplayHints(after).hints.get('peer')?.pendingInfluences.some(item=>item.messageId==='event')).toBe(true);
  });
  it('keeps other affected targets when a reference is read at its source text',async()=>{
    const input=fixture([relation('reference','REFERENCE',['peer'],'m')]),save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    const scope=new Set(['m','peer']);
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={save}>
      <MessageDisplayMarker messageId="m"/>
      <TraceReadingController scopeKey="source-targets" scopeIds={scope} allowedIds={scope} direction="both" order="discussion" onOrder={vi.fn()}
        path={[]} focusId="m" focusLocated incoming={[]} ready onNavigate={vi.fn(async()=>{})} onBack={vi.fn()}/>
    </MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    const popup=within(screen.getByRole('tooltip')),influences=popup.getByRole('region',{name:'相关影响'});
    expect(influences).not.toHaveTextContent('影响目标 · m');
    expect(within(influences).getByRole('button',{name:'影响目标 · peer'})).toBeVisible();
    await act(async()=>fireEvent.click(popup.getByRole('button',{name:'标记当前消息已阅'})));
    const marks=save.mock.calls[0][0],hints=deriveDisplayHints({...input,readingMarks:marks});
    expect(hints.hints.get('m')?.pendingInfluences).toEqual([]);
    expect(hints.hints.get('peer')?.pendingInfluences).toEqual([]);
    expect(hints.hints.get('peer')?.unread).toBe(true);
  });
  it('preserves old shared selection keys without inventing new pending content',()=>{
    const input=fixture([relation('correction','CORRECT')]),hint=deriveDisplayHints(input).hints.get('m')!;
    const marks=readingMarksFor(input,'m',hint.displayed),own=marks.find(mark=>mark.scope==='message')!;
    own.selection={...own.selection!,versionKey:messageReadingKey('m')};
    const after=deriveDisplayHints({...input,readingMarks:marks}).hints.get('m')!;
    expect(after.unread).toBe(false);expect(after.selectionChanged).toBe(false);expect(after.pendingInfluences).toEqual([]);
  });
  it('confirms the displayed body and listed events without reading correction bodies, other targets or members',async()=>{
    const relations=[relation('correction','CORRECT'),relation('tag','TAG',['m','peer']),relation('reply','REPLY'),relation('container','CLASSIFY',[]),relation('join','JOIN',['m'],'container')];
    const input=fixture(relations),save=vi.fn<(_marks:ReadingMark[])=>Promise<void>>(async()=>{});
    const element=(value:typeof input)=><MessageDisplayHintsProvider input={value} onView={vi.fn()} onMarkRead={save}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    expect(screen.queryByText(/首次已阅前/)).toBeNull();
    const message=screen.getByRole('region',{name:'消息阅读确认'});
    const influences=screen.getByRole('region',{name:'相关影响'});
    const combined=screen.getByRole('region',{name:'消息与影响'});
    expect(combined).toContainElement(message);expect(combined).toContainElement(influences);
    expect(combined).not.toHaveTextContent('同时确认');
    expect(within(combined).getAllByRole('button',{name:'收起未阅影响（4 条）'})).toHaveLength(1);
    expect(within(influences).getByRole('button',{name:'收起未阅影响（4 条）'})).toHaveAttribute('aria-expanded','true');
    expect(within(influences).getByRole('button',{name:'更正 · correction'})).toBeVisible();
    expect(within(influences).queryByRole('button',{name:'correction'})).toBeNull();
    expect(within(combined).getAllByRole('button',{name:'对比'})).toHaveLength(1);
    await act(async()=>fireEvent.click(within(message).getByRole('button',{name:'标记当前消息已阅'})));
    const marks=save.mock.calls[0][0];
    expect(marks.filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m']);
    expect(marks.find(mark=>mark.scope==='message')?.version?.corrections.map(item=>item.messageId)).toEqual(['correction']);
    expect(new Set(marks.filter(mark=>mark.scope==='influence').map(mark=>JSON.parse(mark.eventId!)[0]))).toEqual(new Set(['correction','tag','reply','join']));
    const after={...input,readingMarks:marks};view.rerender(element(after));
    expect(screen.getByRole('button',{name:'当前消息已阅'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','unread');
    const hints=deriveDisplayHints(after);
    expect(hints.hints.get('m')?.pendingInfluences).toEqual([]);
    expect(hints.hints.get('correction')?.unread).toBe(true);
    expect(hints.hints.get('peer')?.pendingInfluences.some(item=>item.messageId==='tag')).toBe(true);
  });
  it('splits same-type influences by reading state, navigates by ID and moves confirmed items into the read group',async()=>{
    const base=fixture([relation('read-agree','AGREE'),relation('new-agree','AGREE')]),hints=deriveDisplayHints(base);
    const marks=[...readingMarksFor(base,'m',hints.hints.get('m')!.displayed,'message',{automaticInfluences:false}),
      ...influenceReadingMarks('m',hints.reading.influences.get('m')!.filter(item=>item.messageId==='read-agree'))];
    const input={...base,readingMarks:marks},save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{}),onView=vi.fn();
    const element=(value:typeof input)=><MessageDisplayHintsProvider input={value} onView={onView} onMarkRead={save}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    const unread=screen.getByRole('region',{name:'未阅影响'}),read=screen.getByRole('region',{name:'已阅影响'});
    expect(within(unread).getByRole('button',{name:'收起未阅影响（1 条）'})).toHaveAttribute('aria-expanded','true');
    expect(within(unread).getByRole('button',{name:'展开赞同（1 条）'})).toHaveAttribute('aria-expanded','false');
    expect(within(unread).getByTitle('查看赞同 new-agree')).not.toBeVisible();
    fireEvent.click(within(unread).getByRole('button',{name:'展开赞同（1 条）'}));
    expect(within(unread).getByTitle('查看赞同 new-agree')).toBeVisible();
    expect(within(read).getByRole('button',{name:'展开已阅影响（1 条）'})).toHaveAttribute('aria-expanded','false');
    expect(within(read).getByTitle('查看赞同 read-agree')).not.toBeVisible();
    expect(screen.queryByRole('button',{name:'跳转未读'})).toBeNull();
    fireEvent.click(within(read).getByRole('button',{name:'展开已阅影响（1 条）'}));
    expect(within(read).getByTitle('查看赞同 read-agree')).not.toBeVisible();
    fireEvent.click(within(read).getByRole('button',{name:'展开赞同（1 条）'}));
    fireEvent.click(within(read).getByTitle('查看赞同 read-agree'));expect(onView).toHaveBeenCalledWith('read-agree',expect.anything(),true);
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'确认新影响'})));
    expect(save.mock.calls[0][0].filter(mark=>mark.scope==='influence').map(mark=>JSON.parse(mark.eventId!)[0])).toEqual(['new-agree']);
    view.rerender(element({...input,readingMarks:[...marks,...save.mock.calls[0][0]]}));
    expect(screen.queryByRole('region',{name:'未阅影响'})).toBeNull();
    expect(screen.getByRole('button',{name:'收起已阅影响（2 条）'})).toHaveAttribute('aria-expanded','true');
    expect(screen.getByRole('button',{name:'当前消息已阅'})).toBeDisabled();
  });
  it.each(['correction','stance'])('confirms only the frozen comparison after a failed save and retry, leaving a later %s unread',async change=>{
    const input=fixture([relation('first','CORRECT')]);
    const save=vi.fn<(marks:ReadingMark[])=>Promise<void>>().mockRejectedValueOnce(new Error('保存失败')).mockResolvedValue(undefined);
    const element=(value:typeof input)=><MessageDisplayHintsProvider input={value} onView={vi.fn()} onMarkRead={save}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));fireEvent.click(screen.getByRole('button',{name:'对比'}));
    const later=fixture([...input.relations,{...relation('later',change==='correction'?'CORRECT':'AGREE',change==='correction'?['m']:['first']),createdAt:'2026-01-03'}]);view.rerender(element(later));
    const dialog=screen.getByRole('dialog',{name:'原文与当前版本正文对比'});
    expect(within(dialog).getByRole('region',{name:'当前版本正文'})).toHaveTextContent('first');
    const confirm=within(dialog).getByRole('button',{name:'已阅'});
    expect(dialog.querySelector('[data-shortcut-confirm]')).toBe(confirm);
    expect(within(dialog).queryByRole('button',{name:'关闭'})).toBeNull();
    expect(within(dialog).getAllByRole('button',{name:'已阅'})).toHaveLength(1);
    await act(async()=>fireEvent.click(confirm));expect(within(dialog).getByRole('alert')).toHaveTextContent('保存失败');
    await act(async()=>fireEvent.click(confirm));
    expect(screen.queryByRole('dialog')).toBeNull();
    const marks=save.mock.calls[1][0];
    expect(marks).toEqual(save.mock.calls[0][0]);
    expect(marks).toHaveLength(1);expect(marks[0]).toMatchObject({scope:'comparison',messageId:'m'});
    expect(marks[0].version?.corrections.map(item=>item.messageId)).toEqual(['first']);
    const hint=deriveDisplayHints({...later,readingMarks:marks}).hints.get('m')!;
    expect(hint.unread).toBe(true);expect(new Set(hint.pendingInfluences.map(item=>item.messageId))).toEqual(new Set(['first','later']));
    expect(screen.getByRole('button',{name:'标记当前消息已阅'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','unread');
  });
  it('shares version-specific comparison reads with the correction decoration and restores them independently of message reading',async()=>{
    const input=fixture([relation('correction','CORRECT')]),save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    function Harness({source=input,initialMarks=[]}:{source?:typeof input;initialMarks?:ReadingMark[]}){
      const [marks,setMarks]=useState(initialMarks),[decoration,setDecoration]=useState(false);
      return <MessageDisplayHintsProvider input={{...source,readingMarks:marks}} onView={vi.fn()} onMarkRead={async batch=>{await save(batch);setMarks(previous=>[...previous,...batch]);}}>
        <MessageDisplayMarker messageId="m"/><button onClick={()=>setDecoration(true)}>更正装饰</button>
        {decoration&&<CorrectionComparisonPopup popup={{relMsgId:'correction',x:0,y:0,compareCurrent:true}} messages={source.messages} edges={source.edges}
          displayedBodies={source.corrections} onClose={()=>setDecoration(false)}/>}
      </MessageDisplayHintsProvider>;
    }
    const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'取消'}));
    expect(save).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','unread');
    fireEvent.click(screen.getByRole('button',{name:'更正装饰'}));
    await act(async()=>fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'已阅'})));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(save.mock.calls[0][0]).toEqual([expect.objectContaining({scope:'comparison',messageId:'m'})]);
    expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','read');
    expect(screen.getByRole('button',{name:'对比'})).toHaveStyle({color:'var(--ink-64748b)'});
    expect(screen.getByRole('button',{name:'标记当前消息已阅'})).toBeEnabled();
    expect(screen.getByRole('region',{name:'未阅影响'})).toHaveTextContent('未阅影响（1 条）');
    const saved=save.mock.calls[0][0];view.unmount();
    const restored=render(<Harness initialMarks={saved}/>);fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','read');
    fireEvent.click(screen.getByRole('button',{name:'对比'}));
    await act(async()=>fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'已阅'})));
    expect(save).toHaveBeenCalledOnce();
    const stakeChange={...input,personalEffect:{...input.personalEffect,stakeCounts:{correction:{truth:{pro:2,con:0},value:{pro:0,con:0}}}}};
    const ownChoice={...relation('own-choice','AGREE',['correction']),createdBy:{id:'viewer',username:'viewer',createdAt:''}};
    for(const source of [stakeChange,fixture([...input.relations,ownChoice]),fixture([...input.relations,relation('new-bet','AGREE',['correction'])]),
      fixture([...input.relations,relation('settlement','ROUND',['correction'])]),fixture([...input.relations,relation('result','ROUND_RESULT',['correction'])])]){
      expect(deriveDisplayHints(source).hints.get('m')?.displayed.content).toBe(deriveDisplayHints(input).hints.get('m')?.displayed.content);
      expect(bodyVersionKey(deriveDisplayHints(source).hints.get('m')!.displayed.version!)).toBe(bodyVersionKey(deriveDisplayHints(input).hints.get('m')!.displayed.version!));
      restored.rerender(<Harness source={source} initialMarks={saved}/>);
      expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','read');
      expect(screen.getByRole('button',{name:'标记当前消息已阅'})).toBeEnabled();
    }
    const later=fixture([...input.relations,{...relation('later','CORRECT'),createdAt:'2026-01-03'}]);
    restored.rerender(<Harness source={later} initialMarks={saved}/>);
    expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','unread');
    expect(screen.getByRole('button',{name:'对比'})).toHaveStyle({color:'var(--ink-bae6fd)'});
  });
  it('remembers both effective and ineffective comparison results and recognizes returning to either one',async()=>{
    const input=fixture([relation('correction','CORRECT')]),save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
    function Harness({source}:{source:typeof input}){
      const [marks,setMarks]=useState<ReadingMark[]>([]);
      return <MessageDisplayHintsProvider input={{...source,readingMarks:marks}} onView={vi.fn()} onMarkRead={async batch=>{await save(batch);setMarks(previous=>[...previous,...batch]);}}>
        <MessageDisplayMarker messageId="m"/>
      </MessageDisplayHintsProvider>;
    }
    const view=render(<Harness source={input}/>);fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    const compare=async()=>{fireEvent.click(screen.getByRole('button',{name:'对比'}));await act(async()=>fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'已阅'})));};
    await compare();expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','read');
    const inactive={...input,corrections:computeCorrectionVersions(input.messages,input.edges,new Set(['correction']))};
    view.rerender(<Harness source={inactive}/>);expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','unread');
    await compare();expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','read');
    view.rerender(<Harness source={input}/>);expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','read');
    view.rerender(<Harness source={inactive}/>);expect(screen.getByRole('button',{name:'对比'})).toHaveAttribute('data-comparison-reading','read');
    expect(save).toHaveBeenCalledTimes(2);expect(screen.getByRole('button',{name:'标记当前消息已阅'})).toBeEnabled();
  });
  it('keeps classification members visible and independently unread',async()=>{
    const input=fixture([relation('container','CLASSIFY',['m','peer'])]),save=vi.fn<(_marks:ReadingMark[])=>Promise<void>>(async()=>{}),onView=vi.fn();
    render(<MessageDisplayHintsProvider input={input} onView={onView} onMarkRead={save}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 container：/}));
    const members=screen.getByRole('region',{name:'成员消息'});
    expect(within(members).getByRole('button',{name:'查看成员消息 m'})).toBeVisible();
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'标记当前消息已阅'})));
    expect(save.mock.calls[0][0].some(mark=>['m','peer'].includes(mark.messageId))).toBe(false);
    fireEvent.click(within(members).getByRole('button',{name:'查看成员消息 m'}));expect(onView).toHaveBeenCalledWith('m',expect.anything(),false);
  });
  it('omits empty influence and member sections',()=>{
    const input=fixture();render(<MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="m"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
    expect(screen.queryByRole('region',{name:'相关影响'})).toBeNull();expect(screen.queryByRole('region',{name:'成员消息'})).toBeNull();
  });
  it('omits the member section of an empty classification',()=>{
    const input=fixture([relation('container','CLASSIFY',[])]);
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageDisplayMarker messageId="container"/></MessageDisplayHintsProvider>);
    fireEvent.click(screen.getByRole('button',{name:/^显示提示 container：/}));expect(screen.queryByRole('region',{name:'成员消息'})).toBeNull();
    expect(screen.queryByRole('region',{name:'相关影响'})).toBeNull();
  });
});

describe('optional reminders before stance and value actions',()=>{
  it('identifies opposition to the correction itself without implying opposition to its original',()=>{
    const input=fixture([relation('correction','CORRECT')]);
    render(<MessageDisplayHintsProvider input={input} onView={vi.fn()}><StanceReadingReminder relationType="disagree" targetIds={['correction']}/></MessageDisplayHintsProvider>);
    expect(screen.getByRole('note')).toHaveTextContent('当前目标是更正消息本身');expect(screen.getByRole('note')).not.toHaveTextContent('针对原文的站队表态');
  });
  it.each(['agree','disagree','recommend','archive'])('reminds for unread %s targets and never blocks sending',async action=>{
    const input=fixture([relation('correction','CORRECT')]),send=vi.fn(),onView=vi.fn();
    const element=(value:typeof input)=><MessageDisplayHintsProvider input={value} onView={onView}>
      <StanceReadingReminder relationType={['recommend','archive'].includes(action)?'tag':action} secondaryRelationType={action} targetIds={['m']}/>
      <button onClick={send}>发送</button>
    </MessageDisplayHintsProvider>;
    const view=render(element(input));expect(screen.getByRole('note')).toHaveTextContent('请先阅读目标消息');
    fireEvent.click(screen.getByRole('button',{name:'查看更正 correction'}));expect(onView).toHaveBeenCalledWith('correction',expect.anything(),true);
    fireEvent.click(screen.getByRole('button',{name:'发送'}));expect(send).toHaveBeenCalledOnce();
    const hints=deriveDisplayHints(input),marks=[...readingMarksFor(input,'m',hints.hints.get('m')!.displayed),...readingMarksFor(input,'correction',hints.hints.get('correction')!.displayed)];
    view.rerender(element({...input,readingMarks:marks}));expect(screen.queryByRole('note')).toBeNull();
    const later=fixture([...input.relations,{...relation('new-correction','CORRECT'),createdAt:'2026-01-03'}],marks);view.rerender(element(later));
    expect(screen.getByRole('note')).toHaveTextContent('更正消息待阅');expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();
  });
});
