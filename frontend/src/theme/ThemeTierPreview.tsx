import { useState, type CSSProperties } from 'react';
import { EdgeLabelSkin, EdgeSkin, FrameSkin } from './GraphSkin';
import { SkinOrnament, TypeOrnament } from './StakeTierBadge';
import type { Theme } from './theme';

export default function ThemeTierPreview({ theme }: { theme: Theme }) {
  const [carrier, setCarrier] = useState('content');
  const [type, setType] = useState('normal');
  const [selected, setSelected] = useState(false);
  const [reading, setReading] = useState(false);
  if (theme === 'gpt') return <p>原版沿用原来的消息外观，不启用四档材质。选择另一种风格可查看四种载体的等级对照。</p>;
  const names = theme === 'gpt-arena' ? ['素面', '精工', '辉光', '星铸'] : ['素纸', '压边', '洒金', '鎏金装裱'];
  const ranges = ['小于 10 点', '10–99 点', '100–999 点', '1000 点及以上'];
  const paper = theme === 'opus-paper';
  const types: Record<string, string> = carrier === 'edge' ? { reference: '引用', reply: '回复', annotation: '注释', notification: '通知', agree: '赞同', disagree: '反对' }
    : carrier === 'frame' ? { classify: '分类', summary: '总结', merge: '归并', arrange: '排列' }
      : { normal: '文本', summary: '总结', classify: '分类', merge: '归并', arrange: '排列', governance: '治理', correct: '更正' };
  const previewType = type in types ? type : Object.keys(types)[0];
  const previewStyle = paper && reading ? { '--recommendation-level': .5, backgroundImage: 'var(--recommendation-gradient)' } as CSSProperties : undefined;
  return <div className="theme-carrier-preview">
    <div className="theme-carrier-tabs" role="group" aria-label="预览载体">
      {Object.entries({ content: '正文', edge: '有向边', decoration: '装饰', frame: '容纳框架' }).map(([id, label]) =>
        <button type="button" key={id} aria-pressed={carrier === id} onClick={() => setCarrier(id)}>{label}</button>)}
    </div>
    {paper && <div className="theme-preview-controls">
      {carrier !== 'decoration' && <label>消息类型 <select aria-label="预览消息类型" value={previewType} onChange={event => setType(event.target.value)}>
        {Object.entries(types).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>}
      <label><input type="checkbox" checked={selected} onChange={event => setSelected(event.target.checked)} />选中</label>
      {carrier === 'content' && <label><input type="checkbox" checked={reading} onChange={event => setReading(event.target.checked)} />叠加定位、片段与已阅</label>}
    </div>}
    <div className="theme-carrier-grid">{names.map((name, level) => <div className="theme-carrier-column" key={level}>
      <div className="theme-carrier-heading"><b>L{level}</b> {name}<small>{ranges[level]}</small></div>
      {carrier === 'content' && <div className="stake-tier-example" data-stake-level={level} data-skin-type={paper ? previewType : undefined}
        data-whole-selected={paper && selected || undefined} data-view-target={paper && reading || undefined} style={previewStyle}>
        <SkinOrnament /><span data-skin-type-label={paper || undefined}>{paper ? types[previewType] : '消息正文'}</span>
        <p>{paper ? <>正文保持清晰，<span data-fragment-selected={reading || undefined}>材质与装饰</span>沿外缘展开。</> : '正文保持清晰，材质与装饰沿外缘展开。'}</p>
        {paper && reading && <span className="message-read-stamp">已阅</span>}
      </div>}
      {carrier === 'edge' && <svg className="theme-edge-example" viewBox="0 0 200 118" aria-label={`L${level} 有向边外观`}>
        <g className="graph-edge-label" data-stake-level={level} data-relation-type={paper ? previewType : 'reference'} data-label-selection={paper && selected ? 'whole' : undefined}>
          <path className="relation-edge-path" d="M12 94 Q100 25 188 94" fill="none" />
          <path className="relation-edge-arrow" d="M181 83L188 94L176 91Z" />
          <EdgeSkin path="M12 94 Q100 25 188 94" start={{x:12,y:94}} ctrl={{x:100,y:25}} end={{x:188,y:94}} />
          <rect className="graph-edge-label-plate" x={76} y={43} width={48} height={25} rx={2} />
          <EdgeLabelSkin box={{x:82,y:44,width:36,height:23}} />
          <text className="graph-edge-label-text" x={100} y={60} textAnchor="middle">{paper ? types[previewType] : '引用'}</text>
        </g>
      </svg>}
      {carrier === 'decoration' && <div className="theme-decoration-example">
        <div data-skin-decoration="agree" data-stake-level={level} data-skin-selected={paper && selected || undefined}>赞同 31</div>
        <div data-skin-decoration="disagree" data-stake-level={level} data-skin-selected={paper && selected || undefined}>反对 19</div>
        {paper && <>
          <div data-skin-decoration="annotation" data-skin-operation="orange" data-stake-level={level} data-skin-selected={selected || undefined}>推荐 8</div>
          <div data-skin-decoration="annotation" data-skin-operation="slate" data-stake-level={level} data-skin-selected={selected || undefined}>冷藏 2</div>
        </>}
        <div data-skin-tag="true" data-stake-level={level} data-skin-selected={paper && selected || undefined}><span>需要数据 · 3</span></div>
        <div data-skin-decoration="correct" data-stake-level={level} data-skin-selected={paper && selected || undefined}>更正 2/3</div>
      </div>}
      {carrier === 'frame' && <div className="theme-frame-example">
        <svg viewBox="0 0 200 145" aria-label={`L${level} 框架外观`}><g data-frame-visual="preview" data-stake-level={level} data-skin-type={paper ? previewType : undefined} data-whole-selected={paper && selected || undefined}>
          <rect x={8} y={8} width={184} height={129} rx={2} strokeDasharray={paper && previewType === 'summary' ? undefined : '6 3'} />
          <FrameSkin box={{x:8,y:8,width:184,height:129}} />
        </g></svg><div className="theme-frame-caption" data-stake-level={level} data-skin-type={paper ? previewType : undefined}>{paper && <TypeOrnament />}<span className="skin-frame-title">▾ {paper ? types[previewType] : '分类页签'}</span><div>成员消息 A</div><div>成员消息 B</div></div>
      </div>}
    </div>)}</div>
  </div>;
}
