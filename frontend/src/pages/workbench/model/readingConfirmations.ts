import type {ReadingTask} from './readingTasks';

export type ReadingConfirmationItem={key:string;messageId:string;targets:string[];type:string};
export type ReadingConfirmationGroup={key:string;title:string;kind:'body'|'influence'|'selection';count:number;items:ReadingConfirmationItem[]};

/** Group exact confirmation events by record, showing an address only once. */
export function readingConfirmations(tasks:ReadingTask[],types:ReadonlyMap<string,string>):ReadingConfirmationGroup[]{
  const groups=new Map<string,ReadingConfirmationGroup>(),events=new Set<string>();
  for(const task of tasks){
    const influence=task.influence,id=influence?.messageId??task.destinationId,type=types.get(id)??'消息';
    const kind=!influence?'body':influence.type==='selection'?'selection':'influence';
    const event=JSON.stringify(influence?[kind,id,task.targetId,influence.key,influence.eventId,influence.resultKey]:[kind,id]);
    if(events.has(event))continue;events.add(event);
    const key=kind==='influence'?`${kind}:${type}`:kind;
    const group=groups.get(key)??{key,title:kind==='body'?'正文':kind==='selection'?'显示变化':`${type}影响`,kind,count:0,items:[]};
    group.count++;
    let item=group.items.find(item=>item.messageId===id);
    if(!item){item={key:id,messageId:id,targets:[],type};group.items.push(item);}
    if(influence&&!item.targets.includes(task.targetId))item.targets.push(task.targetId);
    groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>Number(a.kind!=='body')-Number(b.kind!=='body'));
}
