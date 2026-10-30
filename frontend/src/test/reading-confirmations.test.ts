import {expect,it} from 'vitest';
import {readingConfirmations} from '../pages/workbench/model/readingConfirmations';
import type {ReadingTask} from '../pages/workbench/model/readingTasks';

it('deduplicates confirmation events and groups repeated records with all affected messages',()=>{
  const body:ReadingTask={key:'body',kind:'body',destinationId:'current',targetId:'current',reason:'正文未读',location:'inside',createdAt:''};
  const reference:ReadingTask={...body,key:'ref',kind:'influence',influence:{messageId:'reference',type:'reference',key:'reference',eventId:'event'}};
  const groups=readingConfirmations([body,{...body,key:'predecessor',kind:'predecessor'},reference,{...reference,key:'duplicate'},
    {...reference,key:'second-target',targetId:'other'}],new Map([['current','文本'],['reference','引用']]));
  expect(groups).toHaveLength(2);expect(groups[0]).toMatchObject({kind:'body',count:1});
  expect(groups[1]).toMatchObject({title:'引用影响',count:2,items:[{messageId:'reference',targets:['current','other']}]});
});
