import {expect,it} from 'vitest';
import type {Message,Part,Reference} from './types.js';
import {correctionTargetReference,formatCorrectionSummary,messageCorrectionSummary} from './correction-summary.js';

const correction=(before:string,after:string,value:string|undefined,reference:Reference):Pick<Message,'parts'>=>({parts:[
  {id:'corrected-body',type:'text',text:after},
  {id:'body',type:'text',text:`建立关系：CORRECT；目标：${reference.messageId}`},
  {id:'relation',type:'relation',relation:'correct',roles:{target:[{id:'target',reference}]}},
  {id:'data',type:'data',value:{correctionBeforeContent:before,...(value!==undefined?{value}:{})}},
]});

it('describes the selected change and excludes unchanged text and generated target IDs',()=>{
  const record=correction('天气数据货币预报','天气数字货币预报','数字货币',{messageId:'target-id',revision:1,partId:'body',range:{start:2,end:6}});
  const base={parts:[{id:'body',type:'text',text:'天气数据货币预报'}] as Part[]};
  expect(messageCorrectionSummary(record,base)).toBe('将「数据货币」修改为「数字货币」');
  expect(messageCorrectionSummary(record)).toBe('将「数据货币」修改为「数字货币」');
});

it.each([
  ['甲乙','甲新乙','新',1,1,'在所选位置插入「新」'],
  ['甲旧乙','甲乙','',1,2,'删除「旧」'],
])('retains insertion/deletion semantics for %s', (before,after,value,start,end,expected)=>{
  const record=correction(before,after,value,{messageId:'target',revision:1,partId:'body',range:{start,end}});
  expect(messageCorrectionSummary(record)).toBe(expected);
});

it('uses part-local ranges and reconstructs replacements in multi-part text/code/web targets',()=>{
  const base={parts:[{id:'body',type:'text',text:'前文'}, {id:'source',type:'code',language:'text',source:'甲旧乙'},
    {id:'web',type:'web',url:'https://example.com',excerpt:'网页'}] as Part[]};
  const record=correction('前文\n甲旧乙\n网页','前文\n甲新乙\n网页',undefined,{messageId:'target',revision:2,partId:'source',range:{start:1,end:2}});
  expect(messageCorrectionSummary(record,base)).toBe('将「旧」修改为「新」');
  expect(messageCorrectionSummary(record)).toBe('将「旧」修改为「新」');
});

it('retains both sides of a long change within the reference preview budget',()=>{
  const result=formatCorrectionSummary('原'.repeat(100),'新'.repeat(100),24);
  expect(result.length).toBeLessThanOrEqual(64);
  expect(result).toBe(`将「${'原'.repeat(24)}…」修改为「${'新'.repeat(24)}…」`);
});

it('never fills historical summaries from an unpinned current target',()=>{
  const record=correction('原文','新文','新文',{messageId:'target'});
  expect(correctionTargetReference(record)).toBeUndefined();
  record.parts.push({id:'expected',type:'data',value:{expectedRevision:2}});
  expect(correctionTargetReference(record)).toEqual({messageId:'target',revision:2});
});
