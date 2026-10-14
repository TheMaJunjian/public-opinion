import { getPresentationSpec } from '../types';
import type { DemoMessage, UnitSelection } from './modelBridge';

const quote = (text: string) => {
  const readable = text.replace(/\s+/g, ' ').trim();
  return readable ? `「${readable.length > 50 ? `${readable.slice(0, 50)}…` : readable}」` : '';
};

/** The composer names the visible selection; its exact address stays in the selection record. */
export function describeUnit(unit: UnitSelection, message?: DemoMessage): string {
  const ref = unit.reference;
  const part = message?.parts?.find(candidate => candidate.id === ref?.partId);
  const historic = ref?.revision !== undefined && message?.revision !== undefined && ref.revision !== message.revision;
  const content = historic ? '' : part?.type === 'text' ? part.text : part?.type === 'code' ? part.source : part?.type === 'web' ? part.excerpt ?? '' : message?.content ?? '';
  if (unit.selection.kind === 'text' || ref?.range) {
    const text = unit.selection.kind === 'text' ? unit.selection.text : content.slice(ref!.range!.start, ref!.range!.end);
    return `${part?.type === 'code' ? '代码' : part?.type === 'web' ? '网页' : '正文'}片段${quote(text)}`;
  }
  if (unit.label) return unit.label;
  if (ref?.memberId) return '成员消息';
  if (ref?.path?.[0] === 'roles') return ({ members: '所含消息', source: '来源消息', target: '目标消息', parent: '所属分类', member: '成员消息' } as Record<string, string>)[String(ref.path[1])] ?? '关联消息';
  if (unit.selection.kind === 'edge') return '关系连接';
  if (ref?.partId) {
    if (part?.type === 'relation') return `${getPresentationSpec(part.relation).label}关系`;
    if (part?.type === 'display') return '显示方式';
    if (part?.type === 'data' || ref.path?.length) return '消息信息';
    return `${historic ? '历史' : ''}${part?.type === 'code' ? '代码' : part?.type === 'web' ? '网页内容' : '正文'}${quote(content)}`;
  }
  if (ref?.path?.length) return '消息信息';
  return `${historic ? '历史' : '整条'}消息${quote(content)}`;
}
