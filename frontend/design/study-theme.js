// Preview themes only: never writes the production theme preference.
const names = { a: ['素纸','压边','洒金','鎏金装裱'], b: ['素面','精工','辉光','星铸'] };
const captions={
  a:{content:['素纸 · 底线','压边 · 装订线','双框 · 铜角花','锦裱 · 云纹金角'],edge:['细线 · 三角箭头','加粗 · 纸签','金芯 · 燕尾箭镞','丝绦 · 卷轴签'],decoration:['纸贴','折角签条','火漆封 · 系线','金边玉牌 · 流苏'],frame:['页签夹','牛皮纸夹','布纹函套 · 铜扣','锦盒 · 匾额页签']},
  b:{content:['素面 · 暗色卡牌','合金压边 · 蓝色刻线','双层辉光 · 晶质角片','装甲包角 · 金色徽记'],edge:['细线 · 方向箭头','合金导线 · 铭牌','发光线芯 · 晶质标签','方向刻纹 · 装甲铭牌'],decoration:['素面徽章','金属折角章','晶质印章 · 系线','合金铭牌 · 悬挂饰片'],frame:['区域细框','合金边梁','晶质框架 · 光带','装甲外框 · 顶部铭牌']}
};
export const levelNames = () => names[document.documentElement.dataset.studyTheme === 'b' ? 'b' : 'a'];
export const particles = '<span class="grade-particles" aria-hidden="true">'+Array.from({length:12},(_,i)=>`<i style="--px:${8+(i%6)*17}%;--py:${i<6?'0%':'100%'};--dy:${i<6?'-':'+'}${18+(i%3)*9}px;--dx:${(i%3-1)*18}px;--delay:${i%4*45}ms"></i>`).join('')+'</span>';

export function setStudyTheme(theme) {
  const value = theme === 'b' ? 'b' : 'a';
  document.documentElement.dataset.studyTheme = value;
  document.documentElement.dataset.theme = value === 'b' ? 'gpt' : 'opus';
  document.querySelectorAll('[data-study-switch]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.studySwitch === value)));
  document.querySelector('#study-name').textContent = value === 'b' ? '议事厅 · 卡牌' : '案卷 · 印信';
  document.querySelector('.canvas-heading .eyebrow').textContent = value === 'b' ? '公论 / 议事厅 · 卡牌' : '公论 / 案卷 · 印信';
  document.querySelectorAll('[data-level-name]').forEach(element=>element.textContent=levelNames()[Number(element.dataset.levelName)]);
  document.querySelectorAll('.carrier-cell').forEach(cell=>cell.querySelector('.carrier-caption').textContent=captions[value][cell.dataset.carrier][Number(cell.dataset.level)]);
  for(const id of ['mix-level','dec-level']) document.querySelectorAll(`#${id} option`).forEach(option=>option.textContent=`L${option.value} ${levelNames()[Number(option.value)]}`);
  document.dispatchEvent(new CustomEvent('design-theme-change',{detail:value}));
}

export function initStudyTheme() {
  document.querySelectorAll('[data-study-switch]').forEach(button=>button.addEventListener('click',()=>setStudyTheme(button.dataset.studySwitch)));
  setStudyTheme('a');
}
