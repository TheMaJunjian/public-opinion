import {describe,expect,it} from 'vitest';
import {displayHintPosition} from '../utils/displayHintPosition';

describe('status hint visible viewport placement',()=>{
  it.each([
    {left:20,top:20,placement:'below'},
    {left:450,top:560,placement:'above'},
    {left:450,top:290,placement:'right'},
    {left:600,top:290,placement:'left'},
  ])('uses $placement without clipping the wider reading window',({left,top,placement})=>{
    const result=displayHintPosition({left,top,right:left+14,bottom:top+14},{left:0,top:0,width:1000,height:600},true);
    expect(result.placement).toBe(placement);expect(result.width).toBe(420);
    const actualTop=result.placement==='above'?result.top-result.maxHeight:result.top;
    expect(result.left).toBeGreaterThanOrEqual(8);expect(result.left+result.width).toBeLessThanOrEqual(992);
    expect(actualTop).toBeGreaterThanOrEqual(8);expect(actualTop+result.maxHeight).toBeLessThanOrEqual(592);
  });
  it.each([{left:0,top:0,width:280,height:500},{left:120,top:80,width:320,height:300}])('shrinks within the actual visible viewport $width/$height, including zoom offsets',viewport=>{
    const result=displayHintPosition({left:viewport.left+viewport.width-42,top:viewport.top+viewport.height/2,right:viewport.left+viewport.width-28,bottom:viewport.top+viewport.height/2+14},viewport,true);
    const actualTop=result.placement==='above'?result.top-result.maxHeight:result.top;
    expect(result.width).toBe(viewport.width-16);expect(result.left).toBeGreaterThanOrEqual(viewport.left+8);
    expect(result.left+result.width).toBeLessThanOrEqual(viewport.left+viewport.width-8);
    expect(actualTop).toBeGreaterThanOrEqual(viewport.top+8);expect(actualTop+result.maxHeight).toBeLessThanOrEqual(viewport.top+viewport.height-8);
  });
});
