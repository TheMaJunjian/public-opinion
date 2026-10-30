import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import PromptModal from './PromptModal';
import {dialogStyles} from './dialogStyles';

/** Only recognizable complete IDs trigger navigation without another click. */
export function isClipboardMessageId(value:string,knownIds:ReadonlySet<string>):boolean {
  return knownIds.has(value)||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ||/^c[a-z0-9]{24}$/.test(value)||/^migration:(?:lock:)?[0-9a-f]{32}$/.test(value);
}

export default function MessageJumpControl({knownIds,onJump}:{knownIds:ReadonlySet<string>;onJump:(id:string)=>void}) {
  const [open,setOpen]=useState(false),[value,setValue]=useState(''),[reading,setReading]=useState(false),[notice,setNotice]=useState('');
  const input=useRef<HTMLInputElement>(null),trigger=useRef<HTMLButtonElement>(null),generation=useRef(0),edited=useRef(false);
  const latest=useRef({knownIds,onJump});latest.current={knownIds,onJump};
  useEffect(()=>()=>{generation.current++;},[]);
  useLayoutEffect(()=>{if(open&&!edited.current){input.current?.focus({preventScroll:true});if(!reading)input.current?.select();}},[open,reading]);
  const close=()=>{generation.current++;setOpen(false);trigger.current?.focus({preventScroll:true});};
  const jump=(id:string)=>{close();latest.current.onJump(id);};
  const show=()=>{
    const current=++generation.current;edited.current=false;setValue('');setNotice('');setReading(true);setOpen(true);
    // Read while the trigger still has user activation; never overwrite an edit or a later opening.
    void (async()=>{
      try{
        const text=await navigator.clipboard.readText();
        if(current!==generation.current||edited.current)return;
        setValue(text);
        const id=text.trim();
        if(id&&isClipboardMessageId(id,latest.current.knownIds)){jump(id);return;}
        setNotice(id?'剪贴板内容不是完整消息 ID，已全选，可直接修改。':'剪贴板为空，请输入消息 ID。');
      }catch{if(current===generation.current&&!edited.current)setNotice('未能读取剪贴板，请粘贴或输入消息 ID。');}
      finally{if(current===generation.current)setReading(false);}
    })();
  };
  const confirm=()=>{
    const id=value.trim();
    if(!/^[a-z0-9][a-z0-9:_-]{0,99}$/i.test(id)){setNotice(id?'请输入完整的消息 ID。':'请输入消息 ID。');input.current?.focus();input.current?.select();return;}
    jump(id);
  };
  return <>
    <button ref={trigger} type="button" className="workbench-jump-button" onClick={show} aria-haspopup="dialog" aria-expanded={open} title="从剪贴板跳转到消息">跳转</button>
    <PromptModal open={open} title="跳转消息" confirmText="跳转" onConfirm={confirm} onCancel={close}
      dialogProps={{onKeyDown:event=>{
        event.stopPropagation();
        if(event.key==='Escape'){event.preventDefault();close();}
        if(event.key==='Tab'){
          const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input,button:not(:disabled)'));
          const first=controls[0],last=controls[controls.length-1];
          if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
          else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
        }
      }}}
      message={<div style={{display:'grid',gap:10,whiteSpace:'normal'}}>
        <label htmlFor="message-jump-id">消息 ID</label>
        <input id="message-jump-id" ref={input} className="message-jump-input" value={value} placeholder="粘贴或输入消息 ID"
          style={dialogStyles.input} onFocus={event=>event.currentTarget.select()} onClick={event=>event.currentTarget.select()}
          onChange={event=>{edited.current=true;setValue(event.target.value);setNotice('');}}
          onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();confirm();}}}/>
        <div role="status" style={{color:'var(--text-secondary)',fontSize:12}}>{reading?'正在读取剪贴板…':notice||'输入消息 ID 后点击跳转。'}</div>
      </div>}/>
  </>;
}
