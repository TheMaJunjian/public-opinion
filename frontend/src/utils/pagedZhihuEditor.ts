import { hydratePagedArchive, pagedArchiveSource } from './pagedZhihuArchive';
import { nativeZhihuDocument, sendNativeZhihuRelation } from './nativeZhihuEditor';
import { isNativeLocalMessage, type NativeZhihuView } from './nativeZhihuView';
import type { ZhihuLocalSendInput } from './zhihuArchive';

/** Only the addressed parts need their bodies to validate a local edit. The
 * immutable source skeleton and complete local log remain the saved document. */
export async function sendPagedZhihuRelation(data: NativeZhihuView, input: ZhihuLocalSendInput) {
  if (!pagedArchiveSource(data)) return sendNativeZhihuRelation(data, input);
  const ids = new Set([...(input.sourceMessageIds ?? []), ...(input.targetMessageIds ?? []),
    ...(input.sourceReferences ?? []).map(ref => ref.messageId), ...(input.targetReferences ?? []).map(ref => ref.messageId),
    ...(input.currentClassificationId ? [input.currentClassificationId] : [])]);
  const selected = await hydratePagedArchive(data, { ...data,
    messages: data.messages.filter(row => ids.has(row.id)), relations: data.relations.filter(row => ids.has(row.id)) });
  const messages = new Map(selected.messages.map(row => [row.id, row])), relations = new Map(selected.relations.map(row => [row.id, row]));
  const edited = sendNativeZhihuRelation({ ...data,
    messages: data.messages.map(row => messages.get(row.id) ?? row), relations: data.relations.map(row => relations.get(row.id) ?? row) }, input);
  const next = nativeZhihuDocument(edited);
  return { ...edited,
    messages: [...data.messages.filter(row => !isNativeLocalMessage(row)), ...next.messages.filter(isNativeLocalMessage)],
    relations: [...data.relations.filter(row => !isNativeLocalMessage(row)), ...next.relations.filter(isNativeLocalMessage)] };
}
