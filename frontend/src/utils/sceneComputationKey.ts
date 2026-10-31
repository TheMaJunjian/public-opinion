import { chronologicalOrder } from './discussionOrder';
import { hasReadableMessageContent, isCardMessage, presentationTarget, type DemoMessage } from './modelBridge';
import { needsSeparateStanceCard } from './messageDisplay';

/** Layout jobs return positions and IDs. Body rendering and size measurement stay in the view. */
export function sceneComputationKey(job: { input: object } | null): string | null {
  if (!job) return null;
  const input = job.input as { messages?: DemoMessage[]; allMessages?: DemoMessage[]; normals?: DemoMessage[] };
  const messages = [...new Map([...(input.messages ?? []), ...(input.allMessages ?? []), ...(input.normals ?? [])].map(message => [message.id, message])).values()];
  const catalog = new Map(messages.map(message => [message.id, message]));
  const order = new Map(messages.sort(chronologicalOrder).map((message, index) => [message.id, index]));
  return JSON.stringify(job, (_key, value: unknown) => {
    if (value instanceof Set) return { set: [...value].sort() };
    if (value instanceof Map) return { map: [...value] };
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
      if ('createdAt' in value && 'kind' in value && order.has(value.id)) {
        const message = value as DemoMessage;
        return {
          id:message.id, kind:message.kind, relationType:message.relationType, author:message.author,
          chronology:order.get(message.id), card:isCardMessage(message), readable:hasReadableMessageContent(message),
          presentationTarget:presentationTarget(message), separateStance:needsSeparateStanceCard(message,catalog),
          executedStance:message.executedStance, suppressed:message.state?.suppressed,
          annotationStance:message.relationPayload?.annotationStance,
          targetLayout:message.relationPayload?.targetLayout,
          correctionKind:message.relationPayload?.correctionKind,
          bodyCorrection:message.relationPayload?.correctionBeforeContent !== undefined,
          // Native display declarations affect frames; readable strings do not.
          parts:message.parts?.map(part=>part.type==='display'?part:{id:part.id,type:part.type}),
        };
      }
      if ('previousId' in value && 'memberId' in value && 'order' in value && order.has(value.id))
        return { ...value, order: order.get(value.id) };
    }
    return value;
  });
}
