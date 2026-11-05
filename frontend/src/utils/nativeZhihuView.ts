import type { ExportData } from '../api/client';
import { sameZhihuValue } from './zhihuIncremental';

export type NativeZhihuView = ExportData & { source: { provider: 'zhihu'; version: 1;
  scope: 'own' | 'collections' | 'activities'; ownerId: string | null; ownerUrl: string | null } };
export function isNativeZhihuView(value: unknown): value is NativeZhihuView {
  const data = value as NativeZhihuView | null;
  return !!data && data.format === 'gonglun-view-3' && data.formatVersion === 5 && data.source?.provider === 'zhihu'
    && data.source.version === 1 && ['own', 'collections', 'activities'].includes(data.source.scope);
}
export const nativeZhihuIdentity = (data: NativeZhihuView) => JSON.stringify([data.source.ownerId || data.source.ownerUrl, data.source.scope]);
export function isNativeLocalMessage(value: object): boolean {
  const record = value as { parts?: Array<{ id: string; type: string; value?: unknown }> };
  return !!record.parts?.some(part => part.id === 'local-origin' && part.type === 'data'
    && (part.value as { format?: string } | null)?.format === 'gonglun-local-message');
}
export function mergeNativeZhihuUpdate(current: NativeZhihuView, incoming: NativeZhihuView): NativeZhihuView {
  if (nativeZhihuIdentity(current) !== nativeZhihuIdentity(incoming)) throw new Error('更新文件属于不同用户或资料范围，已保留当前阅览。');
  const currentLocal = current.messages.filter(isNativeLocalMessage), incomingLocal = incoming.messages.filter(isNativeLocalMessage);
  const sameMessage = (a: ExportData['messages'][number], b: ExportData['messages'][number]) => a.id === b.id && a.authorId === b.authorId && sameZhihuValue(a.parts, b.parts);
  const prefix = (a: typeof currentLocal, b: typeof currentLocal) => a.length <= b.length && a.every((row, i) => sameMessage(row, b[i]));
  let local = currentLocal;
  if (prefix(currentLocal, incomingLocal)) local = incomingLocal;
  else if (!prefix(incomingLocal, currentLocal)) throw new Error('本地原生消息存在分叉，已保留当前阅览和双方记录。');
  const baseMessages = incoming.messages.filter(message => !isNativeLocalMessage(message));
  const ids = new Set([...baseMessages, ...local].map(message => message.id));
  if (current.messages.some(message => /^zhihu:(item|comment|question|event):/.test(message.id) && !ids.has(message.id))) throw new Error('更新文件缺少已有原文消息，已保留当前阅览。');
  const view = current.view ?? incoming.view;
  for (const message of local) for (const part of message.parts || []) if (part.type === 'relation') {
    for (const role of Object.values(part.roles)) if (role.some(binding => !ids.has(binding.reference.messageId))) throw new Error('更新缺少本地关系引用的消息，已保留当前阅览。');
  }
  let sequence = baseMessages.reduce((value, message) => Math.max(value, message.sequence || 0), baseMessages.length);
  const localMessages = local.map(message => ({ ...message, sequence: ++sequence }));
  const localIds = new Set(local.map(message => message.id)), sequences = new Map(localMessages.map(message => [message.id, message.sequence]));
  const relations = new Map([...current.relations, ...incoming.relations].filter(relation => localIds.has(relation.id)).map(relation => [relation.id, relation]));
  const users = new Map((incoming.users || []).map(user => [user.id, user]));
  const authors = new Set(localMessages.map(message => message.authorId));
  for (const user of current.users || []) if (authors.has(user.id) && !users.has(user.id)) users.set(user.id, user);
  return { ...incoming, messages: [...baseMessages, ...localMessages],
    relations: [...incoming.relations.filter(relation => !isNativeLocalMessage(relation)), ...localMessages.flatMap(message => {
      const relation = relations.get(message.id); return relation ? [{ ...relation, sequence: sequences.get(message.id) }] : [];
    })], ...(incoming.users || current.users ? { users: [...users.values()] } : {}), viewerUsername: '本地整理者',
    ...(view ? { view: { ...view,
    classificationId: view.classificationId && ids.has(view.classificationId) ? view.classificationId : null } } : {}) };
}
