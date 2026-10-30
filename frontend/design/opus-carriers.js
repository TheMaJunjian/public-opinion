// Design fixtures only. L0–L3 are manual samples, not inferred product scores.
import { levelNames, particles } from './study-theme.js';
import { createDecorationStudy } from './decoration-study.js';
const levels=['素纸','压边','洒金','鎏金装裱'];
const copy='建议周六延长开放两小时，试行四周，再根据到馆人数与值班成本共同复核。';
const cloud='<svg viewBox="0 0 36 36"><path d="M2 34V2H34M7 28V7H28M12 25V12H25M2 18h8a5 5 0 1 0 5-5V2M22 2v6h12M2 22h6v12"/></svg>';
const corners=`<span class="grade-corners" aria-hidden="true">${[0,1,2,3].map(()=>`<i>${cloud}</i>`).join('')}</span>`;
const states='<span class="grade-selection" aria-hidden="true"></span><span class="grade-location" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
const trace='<svg class="grade-trace" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100"><rect x="1" y="1" width="98" height="98" pathLength="1"/></svg>';
const meta=(id,tier,carrier)=>`class="grade-object grade-${carrier}" data-object-id="${id}" data-level="${tier}" data-carrier="${carrier}"`;
function content(id,tier,body=copy){return `<article ${meta(id,tier,'content')}><div class="grade-mount">${corners}<div class="grade-paper"><div class="grade-stance" aria-label="示例赞同 62%，反对 38%"><i></i><span>62 : 38</span></div><header><span class="grade-type">文</span><b>${id}</b><span>林舟</span><small>● 待阅</small></header><p><span class="grade-fragment">${body.slice(0,12)}</span>${body.slice(12)}</p><footer><span>公共空间 · 21:04</span><span class="grade-recommend">推荐投入 ↑</span></footer></div>${trace}${particles}</div>${states}</article>`;}
function attachment(id,tier,host){const outside=host==='A01';return `<div ${meta(id,tier,'decoration')} data-host="${host}"><svg class="attachment-cord" aria-hidden="true" viewBox="0 0 100 ${outside?120:72}"><path d="${outside?'M3 88C3 39 58 80 62 30':'M3 59C12 12 40 49 62 30'}"/><circle cx="3" cy="${outside?88:59}" r="3"/></svg><div class="attachment-mount"><span class="attachment-face"><b>标</b><small>${id}</small></span><i class="attachment-fold"></i><span class="attachment-tassels" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>${trace}${particles}${states}</div></div>`;}
function frame(id,tier,title,children){return `<details ${meta(id,tier,'frame')} open><summary><span class="frame-tab">${title}</span><small>${id}</small><i class="frame-clasp" aria-hidden="true"></i></summary><div class="grade-members">${children}</div>${corners}${trace}${particles}${states}</details>`;}
function label(id,tier,name='引用'){return `<button type="button" ${meta(id,tier,'edge-label')} data-edge-id="${id}" aria-label="选择关系 ${id}"><i class="scroll-knob"></i><span class="grade-fragment">${name}</span><small>${id}</small><i class="scroll-knob"></i>${particles}${states}</button>`;}
let svgID=0;
function edgeSVG(tier,{path='M 12 62 C 85 62 145 62 218 62',viewBox='0 0 234 110',description='来源指向目标'}={}){
  const id=`carrier-edge-${++svgID}`,origin=path.match(/M\s*([\d.]+)[ ,]+([\d.]+)/);
  return `<svg class="grade-edge-svg" viewBox="${viewBox}" aria-label="${description}"><defs><marker id="${id}-arrow" viewBox="0 0 20 20" refX="18" refY="10" markerWidth="${[9,13,19,26][tier]}" markerHeight="${[9,13,19,26][tier]}" markerUnits="userSpaceOnUse" orient="auto"><path d="${tier>=2?'M1 1L19 10L1 19L6 10Z':'M1 2L19 10L1 18Z'}" class="edge-arrow"/></marker><path id="${id}-path" d="${path}"/></defs><path class="edge-selection-outer" d="${path}"/><path class="edge-selection-inner" d="${path}"/><path class="edge-main" d="${path}" marker-end="url(#${id}-arrow)" pathLength="1"/><path class="edge-gold-core" d="${path}"/><text class="edge-braid" dy="2.2"><textPath href="#${id}-path" startOffset="15%">›　›　›　›　›　›　›　›　›　›　›　›</textPath></text><circle class="edge-origin" cx="${origin?.[1]||12}" cy="${origin?.[2]||62}" r="5"/></svg>`;
}
export function createSkinStudy({announce,select}){
  const $=selector=>document.querySelector(selector),root=$('#skin-study'),matrix=$('#carrier-matrix'),stage=$('#mixed-stage');
  let page='matrix',chosen='A01',raf=0;
  const objects=new Map(),active=new Map();
  const edges=[{id:'R1',from:'A01',to:'A02',tier:3,name:'引用'},{id:'R2',from:'A03',to:'A04',tier:1,name:'回复'},{id:'R3',from:'A02',to:'A04',tier:0,name:'引用'}];
  const carriers=[['content','可阅读内容','纸片 / 表行'],['edge','有向边','路径 + 标签'],['decoration','附着装饰','依附宿主'],['frame','容纳框架','成员 + 层级']];
  const captions={content:['素纸 · 底线','压边 · 装订线','双框 · 铜角花','锦裱 · 云纹金角'],edge:['细线 · 三角箭头','加粗 · 纸签','金芯 · 燕尾箭镞','丝绦 · 卷轴签'],decoration:['纸贴','折角签条','火漆封 · 系线','金边玉牌 · 流苏'],frame:['页签夹','牛皮纸夹','布纹函套 · 铜扣','锦盒 · 匾额页签']};
  matrix.innerHTML='<div class="matrix-axis">载体 / 等级</div>'+levels.map((name,tier)=>`<div class="matrix-grade-head" data-level="${tier}"><b>L${tier}</b><span data-level-name="${tier}">${name}</span></div>`).join('');
  for(const [carrier,name,hint] of carriers){
    matrix.insertAdjacentHTML('beforeend',`<div class="matrix-carrier-title"><strong>${name}</strong><small>${hint}</small></div>`);
    for(let tier=0;tier<4;tier++){
      let specimen;
      if(carrier==='content')specimen=content('A027',tier);
      if(carrier==='edge')specimen=`<div class="matrix-edge"><span class="edge-source">来源</span><span class="edge-target">目标</span>${edgeSVG(tier)}${label('R031',tier)}</div>`;
      if(carrier==='decoration')specimen=`<div class="matrix-host"><span>宿主 A027</span><p>建议延长周六开放时间。</p>${attachment('D032',tier,'A027')}</div>`;
      if(carrier==='frame')specimen=frame('C040',tier,'开放时间','<div class="matrix-member"><span>文</span>周六延时开放</div><div class="matrix-member"><span>总</span>试行与共同复核</div>');
      matrix.insertAdjacentHTML('beforeend',`<div class="carrier-cell" data-carrier="${carrier}" data-level="${tier}"><div class="carrier-drawing">${specimen}</div><p class="carrier-caption">${captions[carrier][tier]}</p></div>`);
    }
  }
  const nested=frame('C2',1,'Ⅱ 开放时间',content('A02',2,'先试行四周，同时记录到馆人数与新增值班成本。')+'<div class="dense-members" hidden>'+[1,2,3,4].map(n=>content(`B0${n}`,n%4,'共同补充观察记录，保留讨论依据。')).join('')+'</div>');
  stage.innerHTML=`<div class="mixed-source"><div class="mixed-host">${content('A01',1)}${attachment('D1',3,'A01')}</div>${content('A03',0,'建议补充每小时的使用人数，让试行记录更完整。')}</div><div class="mixed-container">${frame('C1',3,'Ⅰ 城市公共空间',nested+content('A04',1,'四周后汇总人数与成本，再共同复核开放安排。'))}</div><div class="mixed-edges"></div>`;
  const names={A01:'正文 · 来源',A02:'正文 · 分类内目标',A03:'正文 · 第二来源',A04:'正文 · 分类内目标',D1:'附着装饰 · 宿主 A01',C1:'外层容器',C2:'嵌套容器'};
  for(const element of stage.querySelectorAll('[data-object-id]')){const id=element.dataset.objectId;if(id.startsWith('B'))continue;objects.set(id,{element,tier:Number(element.dataset.level),description:names[id]});if(element.tagName!=='DETAILS'){element.tabIndex=0;element.setAttribute('aria-label',`${id} ${names[id]}，点击检查等级`);}}
  for(const edge of edges){const wrapper=document.createElement('div');wrapper.className='mixed-edge';wrapper.dataset.level=String(edge.tier);wrapper.dataset.edgeId=edge.id;wrapper.innerHTML=label(edge.id,edge.tier,edge.name);stage.querySelector('.mixed-edges').append(wrapper);objects.set(edge.id,{element:wrapper.querySelector('button'),wrapper,tier:edge.tier,description:`${edge.name}边 · ${edge.from} → ${edge.to}`});}
  for(const [id,object]of objects){const option=document.createElement('option');option.value=id;option.textContent=`${id} · ${object.description}`;$('#mix-object').append(option);}
  function inspect(id){chosen=id;const object=objects.get(id);$('#mix-object').value=id;$('#mix-level').value=String(object.tier);$('#mix-selection').textContent=`${id} · ${object.description} · L${object.tier} ${levelNames()[object.tier]}`;objects.forEach((item,key)=>{item.element.classList.toggle('object-focused',key===id);});}
  stage.addEventListener('click',event=>{if(event.target.closest('summary'))return;const element=event.target.closest('[data-object-id],[data-edge-id]'),id=element?.dataset.objectId||element?.dataset.edgeId;if(objects.has(id))inspect(id);});
  stage.addEventListener('keydown',event=>{if(event.target.tagName==='BUTTON'||event.target.tagName==='SUMMARY')return;if(event.key==='Enter'||event.key===' '){const id=event.target.dataset.objectId;if(objects.has(id)){event.preventDefault();inspect(id);}}});
  function endpoint(id){let element=objects.get(id).element;for(let parent=element.parentElement;parent&&parent!==stage;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open)element=parent.querySelector('summary');const r=element.getBoundingClientRect(),b=stage.getBoundingClientRect();return{element,left:r.left-b.left,right:r.right-b.left,top:r.top-b.top,bottom:r.bottom-b.top,y:r.top+r.height/2-b.top};}
  function drawEdges(){
    if(page!=='mixed'||root.hidden)return;const bounds=stage.getBoundingClientRect();
    for(const edge of edges){const object=objects.get(edge.id),from=endpoint(edge.from),to=endpoint(edge.to),wrapper=object.wrapper;wrapper.hidden=from.element===to.element;if(wrapper.hidden)continue;let path,x,y;
      if(edge.id==='R3'){
        const tx=to.left+(to.right-to.left)*.64,ty=to.top-9;
        if($('#mixed-dense').checked&&objects.get('C2').element.open){
          const container=endpoint('C2'),lane=container.right+12,midY=(container.bottom+to.top)/2;
          path=`M ${from.right+6} ${from.y} H ${lane-6} Q ${lane} ${from.y} ${lane} ${from.y+6} V ${midY-6} Q ${lane} ${midY} ${lane-6} ${midY} H ${tx+6} Q ${tx} ${midY} ${tx} ${midY+6} V ${ty}`;
          x=(lane+tx)/2;y=midY;
        }else{const sx=from.left+(from.right-from.left)*.64,sy=from.bottom+5;path=`M ${sx} ${sy} C ${sx} ${(sy+ty)/2} ${tx} ${(sy+ty)/2} ${tx} ${ty}`;x=(sx+tx)/2;y=(sy+ty)/2;}
      }
      else{const sx=from.right+8,sy=from.y,tx=to.left-8,ty=to.y,mid=sx+(tx-sx)*.52;path=`M ${sx} ${sy} C ${mid} ${sy} ${mid} ${ty} ${tx} ${ty}`;x=(from.right+stage.querySelector('.mixed-container').getBoundingClientRect().left-bounds.left)/2;y=(sy+ty)/2;}
      wrapper.querySelector('svg')?.remove();wrapper.insertAdjacentHTML('afterbegin',edgeSVG(object.tier,{path,viewBox:`0 0 ${bounds.width} ${bounds.height}`,description:`${edge.from} ${edge.name}指向 ${edge.to}`}));object.element.style.left=`${x}px`;object.element.style.top=`${y}px`;
    }
  }
  function scheduleEdges(){cancelAnimationFrame(raf);raf=requestAnimationFrame(drawEdges);}
  function stopAnimations(){for(const[element,timer]of active){clearTimeout(timer);element.classList.remove('grade-upgrade','grade-downgrade');}active.clear();}
  function animate(object,upgrade=true){const element=object.wrapper||object.element,r=object.element.getBoundingClientRect();if($('#reduced-motion').checked||matchMedia('(prefers-reduced-motion: reduce)').matches||$('#mixed-dense').checked||document.hidden||r.bottom<=0||r.top>=innerHeight||r.width===0)return false;if(active.has(element)){clearTimeout(active.get(element));active.delete(element);element.classList.remove('grade-upgrade','grade-downgrade');}if(active.size>=4)return false;void element.offsetWidth;element.classList.add(upgrade?'grade-upgrade':'grade-downgrade');active.set(element,setTimeout(()=>{element.classList.remove('grade-upgrade','grade-downgrade');active.delete(element);},upgrade?900:200));return true;}
  function setLevel(id,tier){const object=objects.get(id),old=object.tier;object.tier=tier;object.element.dataset.level=String(tier);if(object.wrapper)object.wrapper.dataset.level=String(tier);if(old!==tier)animate(object,tier>old);if(id===chosen)inspect(id);scheduleEdges();}
  $('#mix-object').addEventListener('change',event=>inspect(event.target.value));$('#mix-level').addEventListener('change',event=>setLevel(chosen,Number(event.target.value)));
  $('#mix-upgrade').addEventListener('click',()=>{const o=objects.get(chosen);if(o.tier<3)setLevel(chosen,o.tier+1);else animate(o);announce('演示一次等级提升；等级为手动样例。');});
  $('#mix-all-upgrade').addEventListener('click',()=>{for(const id of['A01','R1','D1','C1']){const o=objects.get(id);if(o.tier<3)setLevel(id,o.tier+1);else animate(o);}announce('四种载体演示升级；减少动效或密集模式下直接显示结果。');});
  $('#mixed-dense').addEventListener('change',event=>{stage.querySelector('.dense-members').hidden=!event.target.checked;stopAnimations();scheduleEdges();});$('#mixed-expand').addEventListener('click',()=>{stage.querySelectorAll('details').forEach(el=>el.open=true);scheduleEdges();});$('#reduced-motion').addEventListener('change',stopAnimations);document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAnimations();});
  stage.querySelectorAll('details').forEach(el=>el.addEventListener('toggle',scheduleEdges));new ResizeObserver(scheduleEdges).observe(stage);
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(!entry.isIntersecting){const timer=active.get(entry.target);if(timer){clearTimeout(timer);active.delete(entry.target);entry.target.classList.remove('grade-upgrade','grade-downgrade');}}});for(const o of objects.values())observer.observe(o.wrapper||o.element);
  $('#matrix-content-view').addEventListener('change',event=>matrix.dataset.contentView=event.target.value);for(const state of['selection','location','fragment','recommend','stance'])$('#carrier-'+state).addEventListener('change',event=>{root.classList.toggle('show-'+state,event.target.checked);scheduleEdges();});$('#carrier-grayscale').addEventListener('change',event=>root.classList.toggle('carrier-grayscale',event.target.checked));
  const decorationStudy=createDecorationStudy({content,frame,edgeSVG,label,announce,select});
  document.addEventListener('design-theme-change',()=>{inspect(chosen);stopAnimations();scheduleEdges();});
  document.addEventListener('design-pane-change',stopAnimations);
  function setPage(value){page=value;$('#carrier-matrix-view').hidden=value!=='matrix';$('#carrier-mixed-view').hidden=value!=='mixed';$('#carrier-decorations-view').hidden=value!=='decorations';root.querySelector('.carrier-state-controls').hidden=value==='decorations';root.querySelectorAll('[data-carrier-page]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.carrierPage===value)));document.dispatchEvent(new CustomEvent('design-pane-change'));scheduleEdges();if(value==='decorations')decorationStudy.show();}
  root.querySelectorAll('[data-carrier-page]').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.carrierPage==='decorations')setPage('decorations');else $(`[data-view="${button.dataset.carrierPage==='mixed'?'graph':'table'}"]`).click();}));inspect(chosen);setPage('matrix');return{setPage,setGraph(value){setPage(value?'mixed':'matrix');}};
}
