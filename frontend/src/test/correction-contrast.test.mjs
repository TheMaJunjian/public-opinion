import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import CorrectionTextComparison from '../components/CorrectionTextComparison';
import CorrectionComparisonPopup from '../components/CorrectionComparisonPopup';
import {THEMES} from '../theme/theme';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const readCss=file=>readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'../theme',file),'utf8');
const palettes=THEMES.map(({id,base})=>[id,readCss(`${base}.css`)+(id===base?'':readCss(`${id}.css`))]);
afterEach(cleanup);

function colors(css){
  const tokens=new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match=>[match[1],match[2].trim()]));
  const read=value=>{
    const variable=value.match(/^var\((--[\w-]+)\)$/);
    if(variable){const token=tokens.get(variable[1]);if(!token)throw new Error(`Missing ${variable[1]}`);return read(token);}
    const mix=value.match(/^color-mix\(in srgb,\s*(var\(--[\w-]+\))\s+([\d.]+)%,\s*transparent\)$/);
    if(mix){const color=read(mix[1]);return [color[0],color[1],color[2],Number(mix[2])/100];}
    if(/^#[\da-f]{3,6}$/i.test(value)){
      const hex=value.length===4?value.slice(1).split('').map(char=>char+char).join(''):value.slice(1);
      return [parseInt(hex.slice(0,2),16),parseInt(hex.slice(2,4),16),parseInt(hex.slice(4,6),16),1];
    }
    const rgb=value.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
    if(rgb)return [Number(rgb[1]),Number(rgb[2]),Number(rgb[3]),Number(rgb[4]??1)];
    throw new Error(`Unsupported comparison color: ${value}`);
  };
  return read;
}
const over=(foreground,background)=>[
  foreground[0]*foreground[3]+background[0]*(1-foreground[3]),
  foreground[1]*foreground[3]+background[1]*(1-foreground[3]),
  foreground[2]*foreground[3]+background[2]*(1-foreground[3]),1,
];
const luminance=color=>color.slice(0,3).map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4)
  .reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
const contrast=(first,second)=>(Math.max(luminance(first),luminance(second))+.05)/(Math.min(luminance(first),luminance(second))+.05);

function expectReadable(css){
  const read=colors(css),bodies=document.querySelectorAll('pre');expect(bodies.length).toBe(2);
  for(const body of bodies){
    const background=read(body.parentElement.style.background),foreground=read(body.style.color);
    expect(contrast(foreground,background),'unchanged body text').toBeGreaterThanOrEqual(4.5);
    for(const span of body.querySelectorAll('span')){
      const fill=span.style.background?over(read(span.style.background),background):background;
      const text=span.style.color?read(span.style.color):foreground;
      expect(contrast(text,fill),`highlighted text: ${span.textContent}`).toBeGreaterThanOrEqual(4.5);
    }
  }
}

it.each(palettes)('keeps full correction bodies and insertion/deletion highlights readable in %s',(_theme,css)=>{
  render(createElement(CorrectionTextComparison,{before:'共同正文：旧版本。',after:'共同正文：新版本。'}));
  expectReadable(css);
});

it.each(palettes)('keeps selected and other correction highlights readable in %s',(_theme,css)=>{
  const message=(id,content,kind,day)=>({id,content,kind,author:'writer',createdAt:`2026-01-0${day}`});
  const original=message('original','原甲，原乙。','normal',1);
  const first={...message('first','新甲，原乙。','relation',2),relationPayload:{correctionContent:'新甲，原乙。'}};
  const second={...message('second','原甲，新乙。','relation',3),relationPayload:{correctionContent:'原甲，新乙。'}};
  const edge=(id,start)=>({id,relationMessageId:id,relationType:'correct',relationLabel:'更正',
    from:{messageId:`anon:${id}`,selection:{kind:'whole'}},to:{messageId:'original',selection:{kind:'text',start,len:2,text:original.content.slice(start,start+2)}}});
  render(createElement(CorrectionComparisonPopup,{popup:{relMsgId:'second',x:0,y:0},messages:[original,first,second],edges:[edge('first',0),edge('second',3)],onClose:vi.fn()}));
  expect(screen.getByText('更正影响预览')).toBeVisible();
  expect(document.querySelector('pre span[style*="--ink-fbbf24"]')).not.toBeNull();
  expectReadable(css);
});
