// Design-only fixtures. No application imports, account access, API calls or storage.
import { createSkinStudy } from './opus-carriers.js';
import { initStudyTheme, setStudyTheme } from './study-theme.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const card = $('#A027');
const relationGroups = [
  ['讨论', [['annotation','注释'],['reference','引用'],['reply','回复'],['notify','通知']]],
  ['表态', [['agree','赞同'],['disagree','反对'],['tag','标注']]],
  ['组织', [['arrange','排列'],['classify','分类'],['merge','归并'],['summary','总结']]],
  ['修订', [['correct','更正']]],
  ['治理', [['proposal','提案'],['delegation','委托'],['code_change','代码'],['operations','运营']]],
];
const relationNames = Object.fromEntries(relationGroups.flatMap(([,entries]) => entries));
const fragmentUnit = {id:'A027:fragment', kind:'片段', text:'A027 · 周六闭馆时间从 18 点延至 20 点'};
const wholeUnit = {id:'A027:whole', kind:'整条', text:'A027 · 林舟'};
let drafts = [], source = [], target = [], relation = '', scene = 'reading';
let noticeTimer, navigation = ['A027'], navigationIndex = 0;

for (const [group,entries] of relationGroups) {
  const row = document.createElement('div'); row.className = 'relation-group';
  const label = document.createElement('span'); label.textContent = group; row.append(label);
  const buttons = document.createElement('div');
  for (const [key,name] of entries) {
    const button = document.createElement('button'); button.textContent = name;
    button.dataset.relation = key; button.setAttribute('aria-pressed','false');
    button.addEventListener('click',()=>chooseRelation(relation === key ? '' : key)); buttons.append(button);
  }
  row.append(buttons); $('#relation-groups').append(row);
}

function notice(text) { $('#feedback').textContent = text; $('#feedback').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(()=>$('#feedback').hidden = true,3600); }
function animate(element,name) { element.classList.remove(name); if ($('#reduced-motion').checked || matchMedia('(prefers-reduced-motion: reduce)').matches) return; void element.offsetWidth; element.classList.add(name); }
function syncCard() {
  const whole = $('#whole-state').checked, fragment = $('#fragment-state').checked;
  card.classList.toggle('is-selected',whole); card.classList.toggle('is-fragment',fragment); card.classList.toggle('is-located',$('#location-state').checked);
  $('.whole-checkbox').checked = whole; $('.fragment-actions').hidden = !fragment;
  card.dataset.priority = $('#priority-level').value;
  $('.recommendation-label').hidden = $('#priority-level').value === '0';
  const read = $('#read-state').checked;
  $('.reading-status').textContent = read ? '阅' : '● 待阅'; $('.reading-status').classList.toggle('read-seal',read);
  $('.stance-track').hidden = scene !== 'combined';
  drafts = drafts.filter(unit=>!unit.id.startsWith('A027:'));
  if (whole) drafts.push(wholeUnit); if (fragment) drafts.push(fragmentUnit);
  renderCollections();
}
function renderList(id,units,collection) {
  const list = $(id); list.replaceChildren();
  if (!units.length) {const empty=document.createElement('p');empty.className='empty';empty.textContent=collection==='drafts'?'当前未选择候选。':collection==='source'?'暂无来源':'暂无目标';list.append(empty);return;}
  for(const unit of units){
    const chip=document.createElement('div');chip.className=`unit-chip${unit.kind==='片段'?' fragment-chip':''}`;
    const kind=document.createElement('span');kind.className='unit-kind';kind.textContent=unit.kind;
    const text=document.createElement('span');text.className='unit-text';text.textContent=unit.text;
    const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label',`从${collection==='source'?'来源':collection==='target'?'目标':'暂存区'}移除 ${unit.text}`);
    remove.addEventListener('click',()=>{
      if(collection==='source')source=source.filter(item=>item.id!==unit.id);
      else if(collection==='target')target=target.filter(item=>item.id!==unit.id);
      else{drafts=drafts.filter(item=>item.id!==unit.id);if(unit.id===wholeUnit.id)$('#whole-state').checked=false;if(unit.id===fragmentUnit.id)$('#fragment-state').checked=false;if(unit.id==='A028:whole')$('[data-select-card="A028"]').checked=false;syncCard();}
      renderCollections();
    });chip.append(kind,text,remove);list.append(chip);
  }
}
function renderCollections(){document.dispatchEvent(new CustomEvent('design-drafts-change',{detail:drafts.map(unit=>unit.id)}));renderList('#draft-list',drafts,'drafts');renderList('#source-list',source,'source');renderList('#target-list',target,'target');$('#draft-count').textContent=String(drafts.length);for(const id of ['#clear-drafts','#to-source','#to-target','#set-trace'])$(id).disabled=!drafts.length;$('[data-clear="source"]').disabled=!source.length;$('[data-clear="target"]').disabled=!target.length;}
function chooseRelation(value){relation=value;$$('[data-relation]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.relation===value)));$('#relation-name').textContent=relationNames[value]||'未选择关系';$('#clear-relation').disabled=!value;$('#relation-setting').replaceChildren();
  const options={annotation:['无','疑问','回答'],reply:['无','疑问','回答'],tag:['推荐','存档','关注','屏蔽','自定义'],arrange:['纵','横'],correct:['修正文字','宽度调整'],delegation:['创建委托','完成委托']};
  if(options[value]){const label=document.createElement('label');label.textContent='附加类型 ';const select=document.createElement('select');select.setAttribute('aria-label','关系附加类型示例');for(const text of options[value]){const option=document.createElement('option');option.textContent=text;select.append(option);}label.append(select);$('#relation-setting').append(label);}else $('#relation-setting').textContent=value?'保留该关系的现有附加设置入口。':'选择关系后查看对应设置入口。';updateSend();}
function setScene(value){scene=value;document.body.classList.toggle('scene-classification',value==='classification');document.body.classList.toggle('scene-skins',value==='skins');$('#skin-study').hidden=value!=='skins';$('#state-tools').hidden=value!=='combined';$$('[data-scene]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.scene===value)));$('#scope-title').textContent=value==='skins'?'载体有形，等级有别。':value==='classification'?'把层级留给内容，把边界交给页签。':'让公共空间，多开放两小时。';$('#scope-description').textContent=value==='skins'?'四种载体，四级外观；静止时也能辨认差异。':'开放时间 · 议题示例 · 4 条消息';
  if(value==='combined'){$('#whole-state').checked=true;$('#fragment-state').checked=true;$('#location-state').checked=true;$('#priority-level').value='3';chooseRelation('reference');}
  if(value==='reading'){for(const id of ['#whole-state','#fragment-state','#location-state','#read-state'])$(id).checked=false;$('#priority-level').value='0';chooseRelation('');}
  if(value==='classification'){$('#outer-folder').open=true;$('#inner-folder').open=true;}
  syncCard();
}
$$('[data-scene]').forEach(button=>button.addEventListener('click',()=>setScene(button.dataset.scene)));
for(const id of ['#whole-state','#fragment-state','#location-state','#read-state','#priority-level'])$(id).addEventListener('change',syncCard);
$('.whole-checkbox').addEventListener('change',event=>{$('#whole-state').checked=event.target.checked;syncCard();});
$('[data-select-card="A028"]').addEventListener('change',event=>{drafts=drafts.filter(unit=>unit.id!=='A028:whole');if(event.target.checked)drafts.push({id:'A028:whole',kind:'整条',text:'A028 · 阮青'});renderCollections();});
$('#stance-range').addEventListener('input',event=>{const value=Number(event.target.value);$('.stance-track span').style.width=`${value}%`;$('.stance-track').setAttribute('aria-label',`示例赞同 ${value}%，反对 ${100-value}%`);$('#stance-ratio').textContent=`${value} : ${100-value}`;});
$('#replay-location').addEventListener('click',()=>{$('#location-state').checked=true;syncCard();animate(card,'animate-locate');});
$('#replay-recommendation').addEventListener('click',()=>{$('#priority-level').value=String(Math.min(3,Number($('#priority-level').value)+1));syncCard();animate(card,'animate-recommend');});
$('#reduced-motion').checked=matchMedia('(prefers-reduced-motion: reduce)').matches;
$('#reduced-motion').addEventListener('change',event=>document.body.classList.toggle('reduce-motion',event.target.checked));
$('#freeze-controls').addEventListener('change',event=>document.body.classList.toggle('frozen',event.target.checked));
$('#clear-drafts').addEventListener('click',()=>{drafts=[];$('#whole-state').checked=false;$('#fragment-state').checked=false;$('[data-select-card="A028"]').checked=false;syncCard();});
for(const collection of ['source','target']){
  $(`#to-${collection}`).addEventListener('click',()=>{const current=collection==='source'?source:target;const merged=[...new Map([...current,...drafts].map(unit=>[unit.id,unit])).values()];if(collection==='source')source=merged;else target=merged;renderCollections();notice(`已加入${collection==='source'?'来源':'目标'}集合（示例）`);});
  $(`[data-clear="${collection}"]`).addEventListener('click',()=>{if(collection==='source')source=[];else target=[];renderCollections();});
}
$('#clear-relation').addEventListener('click',()=>chooseRelation(''));
$$('[data-quick-relation]').forEach(button=>button.addEventListener('click',()=>{chooseRelation(button.dataset.quickRelation);notice(`已选择「${relationNames[relation]}」，可将候选加入来源或目标集合。`);}));
$('#more-relations').addEventListener('click',()=>{$('#relation-section').scrollIntoView({block:'center',behavior:$('#reduced-motion').checked?'auto':'smooth'});$('#relation-groups button').focus({preventScroll:true});});
$('#reading-details').addEventListener('click',()=>{const detail=$('.reading-detail');detail.hidden=!detail.hidden;$('#reading-details').setAttribute('aria-expanded',String(!detail.hidden));$('#reading-details').textContent=detail.hidden?'详情⌄':'收起⌃';});
$('#set-trace').addEventListener('click',()=>{$('.reading-detail').hidden=false;$('#reading-details').setAttribute('aria-expanded','true');$('#reading-current').textContent=drafts.map(unit=>unit.text).join('、');notice('已切换追溯示例');});
$('#exit-trace').addEventListener('click',()=>{$('.reading-detail').hidden=true;$('#reading-details').setAttribute('aria-expanded','false');$('#reading-details').textContent='详情⌄';notice('已退出追溯示例，编辑区保留');});
function locate(id,record=true){const element=document.getElementById(id);if(!element||!['A027','A028'].includes(id)){notice('样稿包含 A027、A028 两条可定位消息。');return;}if(scene==='classification'||scene==='skins')setScene('reading');$$('.is-located').forEach(item=>item.classList.remove('is-located'));element.classList.add('is-located');$('#location-state').checked=id==='A027';element.scrollIntoView({block:'center',behavior:$('#reduced-motion').checked?'auto':'smooth'});animate(element,'animate-locate');$('#reading-current').textContent=id==='A027'?'A027 · 林舟':'A028 · 阮青';$('.reading-count').textContent=id==='A027'?'1 / 4':'2 / 4';if(record){navigation=navigation.slice(0,navigationIndex+1);navigation.push(id);navigationIndex++;}$('#back').disabled=navigationIndex===0;$('#forward').disabled=navigationIndex===navigation.length-1;}
$('#jump-form').addEventListener('submit',event=>{event.preventDefault();locate($('#jump-form input').value.trim().toUpperCase());});
$('#back').addEventListener('click',()=>{if(navigationIndex>0)locate(navigation[--navigationIndex],false);});
$('#forward').addEventListener('click',()=>{if(navigationIndex<navigation.length-1)locate(navigation[++navigationIndex],false);});
$('#previous-message').addEventListener('click',()=>locate($('#reading-order').value==='倒序阅读'?'A028':'A027'));
$('#next-message').addEventListener('click',()=>locate($('#reading-order').value==='倒序阅读'?'A027':'A028'));
$('#reading-order').addEventListener('change',()=>notice('阅读顺序已切换（示例）'));
$('#recent-jumps').addEventListener('click',()=>{openEntry('最近跳转');$('#entry-content').replaceChildren();for(const id of [...new Set(navigation)].reverse()){const button=document.createElement('button');button.textContent=id;button.style.marginRight='8px';button.addEventListener('click',()=>{$('#entry-dialog').close();$('#jump-form input').value=id;locate(id);});$('#entry-content').append(button);}});
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>{const graph=button.dataset.view==='graph';$('#messages').classList.toggle('graph-mode',graph);$('.graph-connector').hidden=!graph;skinStudy.setGraph(graph);$$('[data-view]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));}));
$('#expand-all').addEventListener('click',()=>{$$('.folder').forEach(folder=>folder.open=true);});
function enterFolder(name){setScene('classification');$('#breadcrumb-current').textContent=name;$('#scope-title').textContent=name;if(name==='开放时间'){$('#inner-folder').open=true;$('#inner-folder').scrollIntoView({block:'center'});}notice(`已进入「${name}」层级示例`);}
$$('[data-enter]').forEach(button=>button.addEventListener('click',()=>enterFolder(button.dataset.enter)));
$$('.folder summary').forEach(summary=>summary.addEventListener('dblclick',()=>enterFolder(summary.querySelector('.folder-name').textContent)));
$('#open-classification').addEventListener('click',()=>enterFolder('城市公共空间'));
$('#all-messages').addEventListener('click',()=>{$('#breadcrumb-current').textContent='开放时间';setScene('reading');});
function updateSend(){const content=$('#message-body').value.trim();const truth=Number($('#truth-input').value),value=Number($('#value-input').value);const valid=[truth,value].every(number=>Number.isFinite(number)&&number>=0);const total=valid?1+truth+value:0;$('#truth-fee').textContent=valid?String(truth):'—';$('#value-fee').textContent=valid?String(value):'—';$('#total-fee').textContent=valid?`${total} 点`:'—';$('#send-total').textContent=valid?`${total} 点`:'—';$('#send-preview').textContent=relation?`发送${relationNames[relation]}`:'发送';$('#send-preview').disabled=!content||!valid||truth+value<=0||total>928;}
for(const id of ['#message-body','#truth-input','#value-input'])$(id).addEventListener('input',updateSend);
$('#send-preview').addEventListener('click',()=>{notice('已演示发送反馈；没有发布消息，也未扣除积分。');animate(card,'new-message');});
function openEntry(name){$('#entry-title').textContent=name;$('#entry-content').textContent='此入口在正式界面中保留。当前样稿只用于检查布局、消息状态与分类层级。';if(name==='风格'){$('#entry-content').innerHTML='<div class="preview-theme-choices"><button data-preview-theme="a">A · 案卷印信<br><small>暖纸、印签、锦裱</small></button><button data-preview-theme="b">B · 议事厅卡牌<br><small>深色、稀有度边框、粒子</small></button></div><p class="dec-dialog-note">仅切换当前样稿；正式界面的原 GPT 深色保留。</p>';$$('[data-preview-theme]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.previewTheme===document.documentElement.dataset.studyTheme));button.addEventListener('click',()=>{setStudyTheme(button.dataset.previewTheme);$$('[data-preview-theme]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));});});}if(!$('#entry-dialog').open)$('#entry-dialog').showModal();}
$$('[data-entry]').forEach(button=>button.addEventListener('click',()=>openEntry(button.dataset.entry)));
$$('.related-trigger').forEach(button=>button.addEventListener('click',()=>$('#related-dialog').showModal()));
$$('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}}));
$$('[data-locate]').forEach(button=>button.addEventListener('click',()=>{$('#related-dialog').close();locate(button.dataset.locate);}));
$('.brand').addEventListener('click',event=>{event.preventDefault();setScene('reading');window.scrollTo({top:0});});
const skinStudy = createSkinStudy({
  select(unit, selected) { drafts = drafts.filter(item=>item.id!==unit.id); if(selected) drafts.push(unit); renderCollections(); },
  openEntry,
  announce: notice,
});
initStudyTheme();setScene('skins');skinStudy.setPage('decorations');renderCollections();updateSend();
