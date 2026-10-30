import { levelNames, particles } from './study-theme.js';

const thumb = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 20H5V10h4m0 10h9l3-10h-7l1-6-2-1-4 7v10Z"/></svg>';
const hosts = [
  { id:'A110', kind:'content', title:'正文消息', body:'建议周六延长开放两小时，试行四周，记录到馆人数与值班成本。' },
  { id:'R130', kind:'edge', title:'有向边标签', body:'A110 → 引用 → A120' },
  { id:'C140', kind:'frame', title:'分类框架', body:'开放时间 · 2 条成员' },
  { id:'T150', kind:'tag', title:'标注消息', body:'需要数据 · 附着于 A110' },
];
const selected = new Map();

function voteMarkup(host,kind,count,tier,{mini=false,suffix=''}={}) {
  const name=kind==='agree'?'赞同':'反对',key=`${host}-${suffix}${kind}`;
  if(mini)return `<span class="action-vote mini-vote" data-kind="${kind}" data-level="${tier}"><span class="vote-quick">${thumb}</span><span class="vote-select">${name} <b>${count}</b></span></span>`;
  return `<div class="action-vote" data-kind="${kind}" data-level="${tier}" data-record-host="${host}" data-decoration-key="${key}">
    <button class="vote-quick" data-quick="${key}" data-action-name="${name}" aria-label="快速${name} ${host}" title="单击图标：演示快速${name}">${thumb}</button>
    <button class="vote-select" data-select="${key}" data-unit-label="${host} · ${name}记录" aria-pressed="false" title="单击选中，双击查看临时分类"><span>${name}</span><b>${count}</b></button>
    <button class="vote-records" data-records="${name}" data-record-host="${host}" aria-label="查看${host}的${name}记录" title="查看记录">↗</button>${particles}
  </div>`;
}
function tagMarkup(host,label,count,tier,{mini=false,index=0}={}) {
  if(mini)return `<span class="action-tag" data-level="${tier}"><i aria-hidden="true"></i><span>${label}</span><b>${count}</b></span>`;
  return `<button class="action-tag" data-level="${tier}" data-select="${host}-tag-${index}" data-unit-label="${host} · 标注「${label}」" aria-pressed="false" title="单击选中，双击查看临时分类"><i aria-hidden="true"></i><span>${label}</span><b>${count}</b>${particles}</button>`;
}
function correctionMarkup(host,tier,{mini=false}={}) {
  const text='<span class="correction-symbol" aria-hidden="true">↶</span><span>更正</span><b>2<span>/3</span></b>';
  return mini?`<span class="action-correction" data-level="${tier}">${text}</span>`:`<button class="action-correction" data-level="${tier}" data-correction="${host}" title="单击对比正文，双击查看更正历史">${text}${particles}</button>`;
}
function groupMarkup(id,name,contents,{open=true,summary='',nested=false}={}) {
  return `<section class="dec-group${nested?' nested-votes':''}"><button type="button" class="dec-toggle" aria-expanded="${open}" aria-controls="${id}"><span class="dec-chevron" aria-hidden="true">${open?'▾':'▸'}</span><strong>${name}</strong><small>${summary}</small><span class="dec-toggle-label">${open?'收起':'展开'}</span></button><div id="${id}" class="dec-group-body" ${open?'':'hidden'}>${contents}</div></section>`;
}
function rackMarkup(host) {
  const votes=voteMarkup(host.id,'agree',31,2)+voteMarkup(host.id,'disagree',19,2);
  const tags=['需要数据','补充到馆统计口径'].map((label,index)=>`<div class="dec-tag-row"><div class="dec-tag-line">${tagMarkup(host.id,label,index?12:3,2,{index})}<button class="dec-record-link" data-records="标注「${label}」" data-record-host="${host.id}">记录 ↗</button></div>${index===0?groupMarkup(`nested-${host.id}`,'这条标注的赞同／反对',voteMarkup(`${host.id}-tag-0`,'agree',4,1,{suffix:'nested-'})+voteMarkup(`${host.id}-tag-0`,'disagree',1,1,{suffix:'nested-'}),{open:false,summary:'4 / 1',nested:true}):''}</div>`).join('');
  return `<div class="dec-rack"><div class="dec-rack-title"><span>附着于 <b>${host.id}</b></span><span>装饰等级 · 手动示例</span></div>
    ${groupMarkup(`votes-${host.id}`,'赞同／反对',votes,{summary:'31 / 19'})}
    ${groupMarkup(`tags-${host.id}`,'标注',tags,{summary:'2 组'})}
    <div class="dec-correction-row">${correctionMarkup(host.id,2)}<span class="correction-count-label">有效 / 总数</span><button data-compare="${host.id}">正文对比</button><button data-history="${host.id}">历史</button></div>
  </div>`;
}

export function createDecorationStudy({content,frame,edgeSVG,label,announce,select}) {
  const root=document.querySelector('#carrier-decorations-view'),board=root.querySelector('#dec-host-scenes');
  let hostId='A110';
  const timers=new Map(),effects=new Map();
  for(const host of hosts) {
    let specimen;
    if(host.kind==='content')specimen=content(host.id,1,host.body);
    if(host.kind==='frame')specimen=frame(host.id,2,'开放时间','<div class="matrix-member"><span>文</span>延长周六开放时间</div><div class="matrix-member"><span>总</span>试行四周后复核</div>');
    if(host.kind==='edge')specimen=`<div class="dec-edge-host"><span class="dec-edge-endpoint">A110</span>${edgeSVG(2,{path:'M 20 80 C 110 80 235 80 325 80',viewBox:'0 0 350 160',description:host.body})}${label(host.id,2)}<span class="dec-edge-endpoint">A120</span></div>`;
    if(host.kind==='tag')specimen=`<div class="dec-tag-host"><div class="dec-parent-paper"><small>宿主 A110</small><p>建议延长周六开放时间。</p></div><div class="dec-parent-stem" aria-hidden="true"></div><div class="dec-host-tag">${tagMarkup('A110','需要数据',3,2,{mini:true})}<small>T150 · 标注也是消息</small></div></div>`;
    const scene=document.createElement('div');scene.className='dec-host-scene';scene.dataset.host=host.id;scene.hidden=host.id!==hostId;
    scene.innerHTML=`<div class="dec-host-column"><div class="dec-host-caption"><strong>${host.title}</strong><span>${host.id}</span></div><div class="dec-host-anchor">${specimen}</div><p class="dec-host-description">${host.body}</p></div>${rackMarkup(host)}<svg class="dec-attachment-link" aria-hidden="true"><path/></svg>`;
    board.append(scene);
  }
  root.querySelector('#dec-grade-examples').innerHTML=Array.from({length:4},(_,tier)=>`<div class="dec-grade-column" data-level="${tier}"><h3>L${tier} <span data-level-name="${tier}">${levelNames()[tier]}</span></h3><div class="dec-mini-votes">${voteMarkup('sample','agree',31,tier,{mini:true})}${voteMarkup('sample','disagree',19,tier,{mini:true})}</div>${tagMarkup('sample','需要数据',3,tier,{mini:true})}${correctionMarkup('sample',tier,{mini:true})}</div>`).join('');
  const scene=()=>board.querySelector(`[data-host="${hostId}"]`);
  function drawConnectors(){
    if(root.hidden)return;
    const current=scene(),rect=current.getBoundingClientRect(),anchor=current.querySelector('.dec-edge-host .grade-edge-label,.dec-host-tag .action-tag')||current.querySelector('.dec-host-anchor'),rack=current.querySelector('.dec-rack'),svg=current.querySelector('.dec-attachment-link');
    const a=anchor.getBoundingClientRect(),r=rack.getBoundingClientRect();
    const x1=a.right-rect.left+7,y1=a.top+a.height/2-rect.top,x2=r.left-rect.left-7,y2=r.top+25-rect.top;
    svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`);svg.querySelector('path').setAttribute('d',`M ${x1} ${y1} C ${(x1+x2)/2} ${y1} ${(x1+x2)/2} ${y2} ${x2} ${y2}`);
  }
  const resizeObserver=new ResizeObserver(drawConnectors);
  resizeObserver.observe(board);
  board.querySelectorAll('.dec-host-anchor,.dec-rack').forEach(element=>resizeObserver.observe(element));
  function paintSelection(){
    root.querySelectorAll('[data-select]').forEach(button=>{const active=selected.has(button.dataset.select);button.setAttribute('aria-pressed',String(active));button.closest('.action-vote')?.classList.toggle('dec-is-selected',active);});
    root.querySelector('#dec-selected-count').textContent=String(selected.size);
  }
  document.addEventListener('design-drafts-change',event=>{const ids=new Set(event.detail);for(const key of selected.keys())if(!ids.has(key))selected.delete(key);paintSelection();});
  function toggleSelect(button){const id=button.dataset.select,active=!selected.has(id);if(active)selected.set(id,button.dataset.unitLabel);else selected.delete(id);select({id,kind:'整条',text:button.dataset.unitLabel},active);paintSelection();feedback(active?'已加入右侧候选暂存区。':'已从候选暂存区移除。');}
  function feedback(text){root.querySelector('#dec-action-feedback').textContent=text;announce(text);}
  const dialog=document.querySelector('#dec-record-dialog');
  function openDialog(mode,host,type='赞同'){
    document.querySelector('#dec-dialog-title').textContent=mode==='compare'?`${host} · 正文对比`:mode==='history'?`${host} · 更正历史`:`${host} · ${type}临时分类`;
    const panel=document.querySelector('#dec-dialog-content');
    if(mode==='compare')panel.innerHTML='<div class="dec-compare"><section><h3>原文 · v1</h3><p>建议延长开放两小时，试行<del>两周</del>。</p></section><section><h3>当前 · v3</h3><p>建议延长开放两小时，试行<ins>四周</ins>，记录到馆人数。</p></section></div><p class="dec-dialog-note">此处演示对比入口；实际版本与有效性沿用产品规则。</p>';
    else if(mode==='history')panel.innerHTML='<div class="dec-history-row"><b>X003</b><span>补充到馆人数记录</span><em>有效</em></div><div class="dec-history-row"><b>X002</b><span>调整试行期限</span><em>未生效</em></div><div class="dec-history-row"><b>X001</b><span>试行两周 → 四周</span><em>有效</em></div><p class="dec-dialog-note">示例：2 条有效 / 3 条记录。</p>';
    else panel.innerHTML=`<div class="dec-record-heading"><span>关系记录</span><span>议事人</span><span>宿主</span></div>${['林舟','阮青','陈原'].map((name,i)=>`<div class="dec-history-row"><b>${type.startsWith('标注')?'T':'V'}00${i+1}</b><span>${name}</span><span>${host}</span></div>`).join('')}<p class="dec-dialog-note">临时分类入口示例，仅列出三条演示记录。</p>`;
    if(!dialog.open)dialog.showModal();
  }
  // Keep single-click actions separate from double-click navigation.
  function defer(button,action,event){if(timers.has(button))clearTimeout(timers.get(button));if(event.detail===0){action();return;}timers.set(button,setTimeout(()=>{timers.delete(button);action();},240));}
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.matches('.dec-toggle')){const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));document.getElementById(button.getAttribute('aria-controls')).hidden=!open;button.querySelector('.dec-chevron').textContent=open?'▾':'▸';button.querySelector('.dec-toggle-label').textContent=open?'收起':'展开';return;}
    if(button.dataset.select){defer(button,()=>toggleSelect(button),event);return;}
    if(button.dataset.quick){defer(button,()=>feedback(`已演示快速${button.dataset.actionName}；不会发布消息或扣费。`),event);return;}
    if(button.dataset.records){openDialog('records',button.dataset.recordHost,button.dataset.records);return;}
    if(button.dataset.correction){defer(button,()=>openDialog('compare',button.dataset.correction),event);return;}
    if(button.dataset.compare)openDialog('compare',button.dataset.compare);
    if(button.dataset.history)openDialog('history',button.dataset.history);
  });
  root.addEventListener('dblclick',event=>{
    const target=event.target.closest('.action-vote,.action-tag[data-select],.action-correction[data-correction]');if(!target)return;
    for(const [button,timer]of timers){if(target===button||target.contains(button)){clearTimeout(timer);timers.delete(button);}}
    if(target.dataset.correction)openDialog('history',target.dataset.correction);
    else if(target.classList.contains('action-vote'))openDialog('records',target.dataset.recordHost,target.dataset.kind==='agree'?'赞同':'反对');
    else openDialog('records',hostId,'标注');
  });
  dialog.querySelector('.close-dialog').addEventListener('click',()=>dialog.close());
  root.querySelector('#dec-host').addEventListener('change',event=>{hostId=event.target.value;board.querySelectorAll('.dec-host-scene').forEach(item=>item.hidden=item.dataset.host!==hostId);root.querySelector('#dec-level').value=scene().querySelector('.action-vote').dataset.level;drawConnectors();});
  for(const [id,open]of [['dec-expand-all',true],['dec-collapse-all',false]])root.querySelector('#'+id).addEventListener('click',()=>scene().querySelectorAll('.dec-toggle').forEach(button=>{if((button.getAttribute('aria-expanded')==='true')!==open)button.click();}));
  function stopEffects(){for(const [element,timer]of effects){clearTimeout(timer);element.classList.remove('dec-upgrade','dec-downgrade');}effects.clear();}
  const visibilityObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting&&effects.has(entry.target)){clearTimeout(effects.get(entry.target));effects.delete(entry.target);entry.target.classList.remove('dec-upgrade','dec-downgrade');}}});
  board.querySelectorAll('.dec-rack [data-level]').forEach(element=>visibilityObserver.observe(element));
  function animate(element,up=true){const rect=element.getBoundingClientRect();if(document.querySelector('#reduced-motion').checked||matchMedia('(prefers-reduced-motion: reduce)').matches||document.hidden||rect.width===0||rect.bottom<0||rect.top>innerHeight||effects.size>=4)return;element.classList.add(up?'dec-upgrade':'dec-downgrade');effects.set(element,setTimeout(()=>{element.classList.remove('dec-upgrade','dec-downgrade');effects.delete(element);},up?900:200));}
  function setLevel(value,replay=false){stopEffects();const targets=[...scene().querySelectorAll('.dec-rack [data-level]')],old=Number(targets[0].dataset.level);targets.forEach(element=>element.dataset.level=String(value));root.querySelector('#dec-level').value=String(value);if(replay||old!==value)targets.forEach(element=>animate(element,value>=old));}
  root.querySelector('#dec-level').addEventListener('change',event=>setLevel(Number(event.target.value)));
  root.querySelector('#dec-replay').addEventListener('click',()=>setLevel(Math.min(3,Number(root.querySelector('#dec-level').value)+1),true));
  document.querySelector('#reduced-motion').addEventListener('change',stopEffects);
  document.addEventListener('design-theme-change',()=>{stopEffects();drawConnectors();});
  document.addEventListener('design-pane-change',stopEffects);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopEffects();});
  return {show:drawConnectors};
}
