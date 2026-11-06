import { chronologicalOrder } from './discussionOrder';
import { hasReadableMessageContent, isCardMessage, presentationTarget, type DemoMessage } from './modelBridge';
import { needsSeparateStanceCard } from './messageDisplay';

type Job = { input: object };
type MessageInputs = { messages?: DemoMessage[]; allMessages?: DemoMessage[]; normals?: DemoMessage[] };

/** One cache per mounted scene; measurements change much more often than its topology. */
export function createSceneComputationKey() {
  let previous: MessageInputs | undefined;
  let catalog = new Map<string, DemoMessage>();
  let order = new Map<string, number>();
  const fields = new Map<string, { value: unknown; serialized: string | undefined }>();
  const replace = (_key: string, value: unknown): unknown => {
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
  };
  return (job: Job | null): string | null => {
    if (!job) return null;
    const input = job.input as MessageInputs;
    if (!previous || previous.messages !== input.messages || previous.allMessages !== input.allMessages || previous.normals !== input.normals) {
      const messages = [...new Map([...(input.messages ?? []), ...(input.allMessages ?? []), ...(input.normals ?? [])].map(message => [message.id, message])).values()];
      catalog = new Map(messages.map(message => [message.id, message]));
      order = new Map(messages.sort(chronologicalOrder).map((message, index) => [message.id, index]));
      previous = { messages: input.messages, allMessages: input.allMessages, normals: input.normals };
      // Visibility and chronology depend on the complete message catalog.
      fields.clear();
    }
    const inputFields: string[] = [];
    const keys = new Set(Object.keys(job.input));
    for (const key of fields.keys()) if (!keys.has(key)) fields.delete(key);
    for (const [key, value] of Object.entries(job.input)) {
      let cached = fields.get(key);
      if (!cached || cached.value !== value) {
        cached = { value, serialized: JSON.stringify(value, replace) };
        fields.set(key, cached);
      }
      if (cached.serialized !== undefined) inputFields.push(`${JSON.stringify(key)}:${cached.serialized}`);
    }
    return `{${Object.entries(job).flatMap(([key, value]) => {
      const serialized = key === 'input' ? `{${inputFields.join(',')}}` : JSON.stringify(value, replace);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    }).join(',')}}`;
  };
}

/** Layout jobs return positions and IDs. Body rendering and size measurement stay in the view. */
export const sceneComputationKey = (job: Job | null): string | null => createSceneComputationKey()(job);
