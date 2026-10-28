import {messageReadingKey,type ReadingMark} from '@gonglun/core';
import {authoredReadingMark,deriveReadingProgress,influenceReadingMarks,type ReadingInput} from './readingProgress';

const identity=(mark:ReadingMark)=>JSON.stringify([mark.messageId,mark.scope,mark.key,mark.eventId,mark.resultKey]);

/** Restore missing author confirmations without overriding explicit unread choices. */
export function authoredReadingBackfill(input:ReadingInput,userId:string,signature:(id:string)=>string|undefined,
  progress=deriveReadingProgress(input)):ReadingMark[]{
  const own=new Set(input.messages.filter(message=>!!message.sequence&&message.sequence>0
    &&(message.authorId?message.authorId===userId:message.author===input.username)).map(message=>message.id));
  const existing=new Set((input.marks??[]).filter(mark=>mark.format===3&&(!mark.unknownContext||mark.state==='UNREAD')).map(identity));
  const result=new Map<string,ReadingMark>();
  const add=(mark:ReadingMark)=>{const key=identity(mark);if(!existing.has(key))result.set(key,mark);};
  for(const message of input.messages)if(own.has(message.id)){
    const key=JSON.stringify([message.id,'message',messageReadingKey(message.id),null,null]);
    if(existing.has(key))continue;
    const displayed=signature(message.id);
    if(displayed)add(authoredReadingMark(message,displayed));
  }
  for(const [target,items] of progress.influences){
    const authored=items.filter(item=>own.has(item.messageId));
    for(const mark of influenceReadingMarks(target,authored))add(mark);
    const selection=progress.selectionChanges.get(target);
    if(authored.length&&selection?.causes?.length&&selection.causes.every(id=>own.has(id)))
      for(const mark of influenceReadingMarks(target,[selection]))add(mark);
  }
  return [...result.values()];
}
