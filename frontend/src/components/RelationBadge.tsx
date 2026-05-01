import { getPresentationSpec } from '../types';

// Map color names to Tailwind class sets
// (Tailwind requires complete class strings, not dynamic construction)
const COLOR_CLASSES: Record<string, { bg: string; text: string; border: string }> = {
  blue:   { bg: 'bg-blue-100',   text: 'text-blue-700',   border: 'border-blue-300'   },
  indigo: { bg: 'bg-indigo-100', text: 'text-indigo-700', border: 'border-indigo-300' },
  green:  { bg: 'bg-green-100',  text: 'text-green-700',  border: 'border-green-300'  },
  red:    { bg: 'bg-red-100',    text: 'text-red-700',    border: 'border-red-300'    },
  yellow: { bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-300' },
  purple: { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-300' },
  orange: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-300' },
  amber:  { bg: 'bg-amber-100',  text: 'text-amber-700',  border: 'border-amber-300'  },
  gray:   { bg: 'bg-gray-100',   text: 'text-gray-600',   border: 'border-gray-300'   },
  slate:  { bg: 'bg-slate-100',  text: 'text-slate-600',  border: 'border-slate-300'  },
};

interface Props {
  type: string;
  className?: string;
}

/** Renders a colored badge for a relation type, driven by PRESENTATION_SPECS */
export default function RelationBadge({ type, className = '' }: Props) {
  const spec = getPresentationSpec(type);
  const colors = COLOR_CLASSES[spec.color] ?? COLOR_CLASSES.gray;

  // Hint icon based on presentation kind
  const icon =
    spec.kind === 'edge-label'      ? '→' :
    spec.kind === 'decoration'      ? '◆' :
    spec.kind === 'edge-decoration' ? '⇒' :
    spec.kind === 'frame-group'     ? '⬡' :
    spec.kind === 'replace-overlay' ? '↺' :
    spec.kind === 'inline-badge'    ? '★' : '';

  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium px-2 py-0.5 rounded border ${colors.bg} ${colors.text} ${colors.border} ${className}`}
      title={`关系类型: ${type}`}
    >
      <span className="opacity-60 text-[10px]">{icon}</span>
      {spec.label}
    </span>
  );
}

// Re-export PRESENTATION_SPECS is intentionally NOT done here to keep fast-refresh happy.
// Import directly from '../types' when needed.
