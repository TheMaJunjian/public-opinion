import { prepareZhihuForViewing } from '../utils/zhihuArchive';
import type { NativeZhihuView } from '../utils/nativeZhihuView';
import type { TargetRef } from '../types';

/** Large hidden branch, tiny visible branches; no user archive is needed by tests. */
export function largeStructuralFixture(): NativeZhihuView {
  const { zhihu: _index, ...source } = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: ['a', 'b', 'bulk'].map(id => ({ id, type: 'answer', text: '', question: { id: `q${id}`, title: `技术测试 ${id}`, text: '' } })),
    comments: ['a', 'b'].map(id => ({ id: `c${id}`, sourceId: `c${id}`, threadId: `answer:${id}`, text: '', rootCommentId: `c${id}`, parentCommentId: null })),
  });
  const template = source.messages.find(row => row.id === 'zhihu:item:answer:bulk')!;
  const extra = Array.from({ length: 10_001 }, (_, index) => ({ ...template, id: `zhihu:comment:answer%3Abulk:test${index}`, sequence: source.messages.length + index + 1 }));
  const refs: TargetRef[] = extra.map(row => ({ kind: 'message', messageId: row.id, reference: { messageId: row.id } }));
  const addMembers = <T extends { id: string; targetRefs?: unknown; parts?: typeof template.parts }>(row: T): T => row.id === 'zhihu:question:qbulk'
    ? { ...row, targetRefs: [...(row.targetRefs ?? []) as TargetRef[], ...refs],
      parts: row.parts?.map(part => part.type === 'relation' && part.relation === 'classify' ? { ...part, roles: { ...part.roles,
        members: [...part.roles.members ?? [], ...extra.map(message => ({ id: message.id, reference: { messageId: message.id } }))] } } : part) }
    : row;
  return { ...source, messages: [...source.messages.map(addMembers), ...extra], relations: source.relations.map(addMembers), viewerUsername: '本地整理者',
    source: { provider: 'zhihu', version: 1, scope: 'own', ownerId: 'structural-fixture', ownerUrl: null } };
}
