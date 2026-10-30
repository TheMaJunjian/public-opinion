import { useState } from 'react';
import { EdgeLabelSkin, EdgeSkin, FrameSkin } from './GraphSkin';
import { SkinOrnament } from './StakeTierBadge';
import type { Theme } from './theme';

export default function ThemeTierPreview({ theme }: { theme: Theme }) {
  const [carrier, setCarrier] = useState('content');
  if (theme === 'gpt') return <p>原版沿用原来的消息外观，不启用四档材质。选择另一种风格可查看四种载体的等级对照。</p>;
  const names = theme === 'gpt-arena' ? ['素面', '精工', '辉光', '星铸'] : ['素纸', '压边', '洒金', '鎏金装裱'];
  const ranges = ['小于 10 点', '10–99 点', '100–999 点', '1000 点及以上'];
  return <div className="theme-carrier-preview">
    <div className="theme-carrier-tabs" role="group" aria-label="预览载体">
      {Object.entries({ content: '正文', edge: '有向边', decoration: '装饰', frame: '容纳框架' }).map(([id, label]) =>
        <button type="button" key={id} aria-pressed={carrier === id} onClick={() => setCarrier(id)}>{label}</button>)}
    </div>
    <div className="theme-carrier-grid">{names.map((name, level) => <div className="theme-carrier-column" key={level}>
      <div className="theme-carrier-heading"><b>L{level}</b> {name}<small>{ranges[level]}</small></div>
      {carrier === 'content' && <div className="stake-tier-example" data-stake-level={level}>
        <SkinOrnament /><span>消息正文</span><p>正文保持清晰，材质与装饰沿外缘展开。</p>
      </div>}
      {carrier === 'edge' && <svg className="theme-edge-example" viewBox="0 0 200 118" aria-label={`L${level} 有向边外观`}>
        <g className="graph-edge-label" data-stake-level={level} data-relation-type="reference">
          <path className="relation-edge-path" d="M12 94 Q100 25 188 94" fill="none" />
          <path className="relation-edge-arrow" d="M181 83L188 94L176 91Z" />
          <EdgeSkin path="M12 94 Q100 25 188 94" start={{x:12,y:94}} ctrl={{x:100,y:25}} end={{x:188,y:94}} />
          <rect className="graph-edge-label-plate" x={76} y={43} width={48} height={25} rx={2} />
          <EdgeLabelSkin box={{x:82,y:44,width:36,height:23}} />
          <text className="graph-edge-label-text" x={100} y={60} textAnchor="middle">引用</text>
        </g>
      </svg>}
      {carrier === 'decoration' && <div className="theme-decoration-example">
        <div data-skin-decoration="agree" data-stake-level={level}>赞同 31</div>
        <div data-skin-decoration="disagree" data-stake-level={level}>反对 19</div>
        <div data-skin-tag="true" data-stake-level={level}><span>需要数据 · 3</span></div>
        <div data-skin-decoration="correct" data-stake-level={level}>更正 2/3</div>
      </div>}
      {carrier === 'frame' && <div className="theme-frame-example">
        <svg viewBox="0 0 200 145" aria-label={`L${level} 框架外观`}><g data-frame-visual="preview" data-stake-level={level}>
          <rect x={8} y={8} width={184} height={129} rx={2} strokeDasharray="6 3" />
          <FrameSkin box={{x:8,y:8,width:184,height:129}} />
        </g></svg><div className="theme-frame-caption" data-stake-level={level}><span className="skin-frame-title">▾ 分类页签</span><div>成员消息 A</div><div>成员消息 B</div></div>
      </div>}
    </div>)}</div>
  </div>;
}
