import { Z_INDEX } from '../constants/zIndex';
import { useWorkbenchActivity } from '../utils/workbenchActivity';

const durationLabel = (milliseconds: number) => milliseconds < 1000
  ? `${Math.round(milliseconds)} 毫秒`
  : `${(milliseconds / 1000).toFixed(1)} 秒`;

export default function WorkbenchActivityIndicator() {
  const activity = useWorkbenchActivity();
  const labels = [
    activity.sync.active ? '正在同步消息…' : activity.sync.lastDuration !== null
      ? `消息同步用时 ${durationLabel(activity.sync.lastDuration)}` : null,
    activity.draw.active ? '正在绘制消息图…' : activity.draw.lastDuration !== null
      ? `消息图绘制用时 ${durationLabel(activity.draw.lastDuration)}` : null,
  ].filter((label): label is string => label !== null);
  if (labels.length === 0) return null;

  return <div data-workbench-activity="true" role="status" aria-live="polite" style={{
    position: 'fixed', right: 12, bottom: 20, zIndex: Z_INDEX.header,
    display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end',
    pointerEvents: 'none', fontSize: 12,
  }}>
    {labels.map(label => <div key={label} style={{
      padding: '4px 8px', border: '1px solid var(--line-52525b)', borderRadius: 5,
      background: 'var(--surface-rgba-24-24-27-0-92)', color: 'var(--ink-e4e4e7)',
      boxShadow: '0 2px 8px var(--shadow-rgba-0-0-0-0-35)',
    }}>{label}</div>)}
  </div>;
}
