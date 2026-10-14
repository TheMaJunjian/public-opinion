import { replaceReference, resolveReference, type Json, type Message as CoreMessage } from '@gonglun/core';
import { unitSelectionToReference, type DemoMessage, type UnitSelection } from './modelBridge';

export function preparePartCorrection(message: DemoMessage, selection: UnitSelection, content: string) {
  if (!message.parts) throw new Error('请重新加载消息后选择要修改的部件');
  const reference = unitSelectionToReference(selection, new Map([[message.id, message]]));
  const coreMessage = message as unknown as CoreMessage;
  const current = resolveReference(reference, id => id === message.id ? coreMessage : undefined);
  if (current === undefined) throw new Error('选择的部件或版本已变化，请重新选择');
  let value: Json;
  if (typeof current === 'string') value = content;
  else if (reference.partId && !reference.memberId && !reference.path?.length && !reference.range) {
    const part = message.parts.find(candidate => candidate.id === reference.partId)!;
    if (part.type === 'text') value = { ...part, text: content };
    else if (part.type === 'code') value = { ...part, source: content };
    else if (part.type === 'web') value = { ...part, excerpt: content };
    else {
      try { value = JSON.parse(content) as Json; } catch { throw new Error('此部件需要有效的 JSON 内容'); }
    }
  } else {
    try { value = JSON.parse(content) as Json; } catch { throw new Error(reference.partId ? '此字段需要有效的 JSON 值' : '整条消息的修改内容需要是部件数组'); }
  }
  replaceReference(coreMessage, reference, value);
  const display = (input: unknown) => typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  return { before: display(reference.partId ? current : message.parts), after: display(value), value, target: { ...selection, reference } };
}
