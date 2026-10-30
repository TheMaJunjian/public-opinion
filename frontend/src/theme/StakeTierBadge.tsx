import { getStakeAppearance, type StakeAmounts } from '../utils/stakeAppearance';

export default function StakeTierBadge({ counts }: { counts?: StakeAmounts }) {
  const appearance = getStakeAppearance(counts);
  const description = `${appearance.description}；推荐投入和协议费不计入档位。`;
  return <>
    <span className="skin-selection-mark" aria-hidden="true" title="已选中整条消息">✓</span>
    {appearance.level !== undefined && <span className="stake-tier-badge" data-stake-level={appearance.level} title={description}
      aria-label={description}>投入 {appearance.total}</span>}
  </>;
}

/** Paint only. Does not occupy space, receive input, or reuse reading/location pseudo-elements. */
export function SkinOrnament() {
  return <span className="stake-skin-ornament" aria-hidden="true">
    <span className="skin-material" /><span className="skin-inlay" /><span className="skin-crest" />
    <span className="skin-corners">{[0, 1, 2, 3].map(corner => <i key={corner}><svg viewBox="0 0 36 36"><path d={CLOUD_CORNER} /></svg></i>)}</span>
    <span className="skin-particles">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</span>
  </span>;
}

export const CLOUD_CORNER = 'M2 34V2H34M7 28V7H28M12 25V12H25M2 18h8a5 5 0 1 0 5-5V2M22 2v6h12M2 22h6v12';
