
const STYLES: Record<string, string> = {
  SUPPORT: 'bg-green-100 text-green-700 border-green-300',
  OPPOSE: 'bg-red-100 text-red-700 border-red-300',
  CORRECT: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  QUOTE: 'bg-blue-100 text-blue-700 border-blue-300',
  REPLY: 'bg-blue-100 text-blue-700 border-blue-300',
  LINK: 'bg-gray-100 text-gray-600 border-gray-300',
  UNLINK: 'bg-gray-100 text-gray-500 border-gray-300',
};

const LABELS: Record<string, string> = {
  SUPPORT: '支持',
  OPPOSE: '反对',
  CORRECT: '纠正',
  QUOTE: '引用',
  REPLY: '回复',
  LINK: '关联',
  UNLINK: '取消关联',
};

interface Props {
  type: string;
  className?: string;
}

export default function RelationBadge({ type, className = '' }: Props) {
  const style = STYLES[type] || 'bg-gray-100 text-gray-600 border-gray-300';
  const label = LABELS[type] || type;
  return (
    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded border ${style} ${className}`}>
      {label}
    </span>
  );
}
