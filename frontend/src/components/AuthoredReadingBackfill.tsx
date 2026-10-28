import {useEffect,useMemo,useRef,useState} from 'react';
import {useReadingDisplayContext} from './MessageDisplayHints';
import {displaySignature} from '../pages/workbench/model/displayHintSnapshot';
import {authoredReadingBackfill} from '../pages/workbench/model/authoredReadingBackfill';

/** Acknowledgments are private and batched; this never changes the public messages. */
export default function AuthoredReadingBackfill({enabled,userId}:{enabled:boolean;userId?:string}){
  const context=useReadingDisplayContext(),active=useRef(false);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [revision,setRevision]=useState(0);
  const marks=useMemo(()=>enabled&&userId&&context?authoredReadingBackfill(context.readingInput,userId,id=>{
    const displayed=context.data.hints.get(id)?.displayed;
    return displayed?displaySignature(displayed):undefined;
  },context.data.reading):[],[enabled,userId,context?.readingInput,context?.data]);
  useEffect(()=>{
    if(active.current||!enabled||!marks.length||!context?.onMarkRead)return;
    active.current=true;
    let saved=false;
    void context.onMarkRead(marks.slice(0,500)).then(()=>{saved=true;})
      .catch(()=>{/* The request feedback retains the failure; new data permits a retry. */})
      .finally(()=>{active.current=false;if(saved&&mounted.current)setRevision(value=>value+1);});
  },[enabled,userId,marks,context?.onMarkRead,revision]);
  return null;
}
