import {fireEvent,render,screen,within} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import MessageAuthors from '../components/MessageAuthors';
import {MessageDisplayHintsProvider} from '../components/MessageDisplayHints';
import {computeCorrectionVersions,convertMessagesToDemoModel,type DemoMessage} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import type {DisplayHintsInput} from '../pages/workbench/model/displayHints';
import type {Relation} from '../types';

function fixture(correctionAuthor='乙'){
  const user=(name:string)=>({id:name,username:name,createdAt:''});
  const relations:Relation[]=[{id:'correction',relationType:'CORRECT',sourceMessageId:null,createdAt:'2026-10-21',createdBy:user(correctionAuthor),
    spending:{protocol:1,wager:5,recommendation:7},targetRefs:[{kind:'text-fragment',messageId:'message-id',text:'旧字',hash:'fragment',reference:{messageId:'message-id',revision:1,partId:'body',range:{start:2,end:4}}}],
    payload:{correctionBeforeContent:'开头旧字结尾',correctionAfterContent:'开头新字结尾'}}];
  const model=convertMessagesToDemoModel([{id:'message-id',revision:1,kind:'TEXT',contentType:'TEXT',content:'开头旧字结尾',parts:[{id:'body',type:'text',text:'开头旧字结尾'}],createdAt:'2026-10-20',createdBy:user('甲'),spending:{protocol:1,wager:2,recommendation:3}}],relations);
  const input:DisplayHintsInput={...model,relations,username:null,readStatus:new Map(),corrections:computeCorrectionVersions(model.messages,model.edges),personalEffect:deriveContainerEffect({...model,relations,username:null,stakeCounts:{}})};
  return {input,message:model.messages.find(message=>message.id==='message-id')!};
}

describe('author label and contribution dialog',()=>{
  it('shows one person for a sender who also corrected the original, with separate source investment details',()=>{
    const {input,message}=fixture('甲'),wheel=vi.fn();
    render(<div onWheel={wheel}><MessageDisplayHintsProvider input={input} onView={vi.fn()}><MessageAuthors message={message} showSelfStake/></MessageDisplayHintsProvider></div>);
    const author=screen.getByRole('button',{name:'查看消息 message-id 的当前正文作者：甲，共 1 人'});
    expect(author).toHaveTextContent('✎ 1人');expect(author).not.toHaveTextContent('2人');
    expect(author.parentElement?.querySelector('[data-message-self-stake]')).toHaveTextContent('自押 7/10');
    fireEvent.wheel(author,{deltaY:100});expect(wheel).toHaveBeenCalledOnce();
    fireEvent.click(author);const dialog=screen.getByRole('dialog');expect(dialog).toHaveTextContent('当前正文作者 · 1 人');
    expect(dialog.querySelector('[data-author-contribution="message-id"]')).toHaveTextContent('自押 2/3');
    expect(dialog.querySelector('[data-author-contribution="correction"]')).toHaveTextContent('自押 5/7');
  });
  it('switches investments with names and shows a compact read-only detail without body text',()=>{
    const {input,message}=fixture(),select=vi.fn(),doubleClick=vi.fn(),wheel=vi.fn(),onView=vi.fn(),onMarkRead=vi.fn();
    render(<div onClick={select} onDoubleClick={doubleClick} onWheel={wheel}><MessageDisplayHintsProvider input={input} onView={onView} onMarkRead={onMarkRead}>
      <MessageAuthors message={message} showSelfStake/>
    </MessageDisplayHintsProvider></div>);
    const author=screen.getByRole('button',{name:/查看消息 message-id 的当前正文作者：甲，共 2 人/});
    expect(author.parentElement?.querySelector('[data-message-self-stake]')).toHaveTextContent('自押 2/3');
    fireEvent.wheel(author,{deltaY:100});expect(author).toHaveAccessibleName(/当前正文作者：乙，共 2 人/);expect(wheel).not.toHaveBeenCalled();
    const currentInvestment=author.parentElement!.querySelector('[data-message-self-stake]')!;
    expect(currentInvestment).toHaveTextContent('自押 5/7');expect(currentInvestment).toHaveAccessibleName(/当前正文作者 乙（对应消息 correction）/);
    expect(author).toHaveTextContent('✎ 2人');expect(author).not.toHaveTextContent('⇅');
    fireEvent.keyDown(author,{key:'ArrowUp'});fireEvent.keyDown(author,{key:'ArrowDown'});
    expect(author).toHaveAccessibleName(/当前正文作者：乙/);expect(currentInvestment).toHaveTextContent('自押 5/7');
    fireEvent.wheel(author,{deltaY:-100});expect(author).toHaveAccessibleName(/当前正文作者：甲/);
    expect(currentInvestment).toHaveTextContent('自押 2/3');
    fireEvent.mouseDown(author);fireEvent.click(author);fireEvent.mouseUp(author);fireEvent.doubleClick(author);
    const dialog=screen.getByRole('dialog',{name:'消息 message-id 的当前正文作者'});
    expect(dialog).toHaveTextContent('当前正文作者 · 2 人');expect(dialog).not.toHaveTextContent('开头');expect(dialog).not.toHaveTextContent('新字');
    expect(dialog.querySelector('[data-author-contribution="message-id"]')).toHaveTextContent('自押 2/3');
    expect(dialog.querySelector('[data-author-contribution="correction"]')).toHaveTextContent('自押 5/7');
    const investmentLine=dialog.querySelector('[data-author-contribution="correction"] [data-author-investment-details]')!;
    expect(investmentLine).toHaveTextContent('自押 5/7首次 5/7 · 追加 0/0');
    expect(select).not.toHaveBeenCalled();expect(doubleClick).not.toHaveBeenCalled();expect(onView).not.toHaveBeenCalled();expect(onMarkRead).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();expect(author).toHaveFocus();
  });
  it('updates current authors when the displayed version changes, retaining a replaced sender only as source information',()=>{
    const {input,message}=fixture();
    const current=input.corrections.get(message.id)!.current!;
    const element=(value:DisplayHintsInput)=><MessageDisplayHintsProvider input={value} onView={vi.fn()}><MessageAuthors message={message} showSelfStake/></MessageDisplayHintsProvider>;
    const view=render(element(input));fireEvent.click(screen.getByRole('button',{name:/当前正文作者：甲，共 2 人/}));
    view.rerender(element({...input,displayCorrections:new Map([[message.id,{...input.corrections.get(message.id)!,current:undefined}]])}));
    expect(screen.getByRole('dialog')).toHaveTextContent('当前正文作者 · 1 人');expect(screen.getByRole('dialog').querySelector('[data-author-contribution="correction"]')).toBeNull();
    view.rerender(element({...input,displayCorrections:new Map([[message.id,{...input.corrections.get(message.id)!,current:{...current,content:'全新正文',changes:[{start:0,end:6,replacement:'全新正文'}]}}]])}));
    const dialog=screen.getByRole('dialog');expect(dialog).toHaveTextContent('当前正文作者 · 1 人');expect(dialog).toHaveTextContent('原消息发送者：甲（当前正文未保留原文）');
    expect(screen.getByRole('button',{name:/查看消息 message-id 的当前正文作者：乙/})).toBeInTheDocument();
    expect(document.querySelector('[data-message-authors="message-id"] > [data-message-self-stake]')).toHaveTextContent('自押 5/7');
    expect(dialog).not.toHaveTextContent('全新正文');
    fireEvent.click(within(dialog).getByRole('button',{name:'关闭作者详情'}));expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('refreshes totals and the additional breakdown while the dialog is open',()=>{
    const message:DemoMessage={id:'m',kind:'normal',content:'正文',author:'甲',createdAt:'',spending:{protocol:1,wager:2,recommendation:3}};
    const view=render(<MessageAuthors message={message} showSelfStake/>);fireEvent.click(screen.getByRole('button',{name:/当前正文作者/}));
    const updated={...message,authorInvestment:{total:{truth:6,value:8},initial:{truth:2,value:3},additional:{truth:4,value:5}}};
    view.rerender(<MessageAuthors message={updated} showSelfStake/>);
    expect(screen.getByRole('dialog')).toHaveTextContent('自押 6/8');expect(screen.getByRole('dialog')).toHaveTextContent('首次 2/3 · 追加 4/5');
    expect(document.querySelector('[data-message-authors="m"] > [data-message-self-stake]')).toHaveTextContent('自押 6/8');
  });
});
