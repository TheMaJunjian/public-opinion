import { displayDependencyRole, type Part } from '@gonglun/core';
import type { SceneLayoutInput } from './frameLayout';
import type { MessageStructureInput } from './messageStructurePlan';
import type { DemoMessage } from './modelBridge';

export type SceneComputationJob = { kind: 'layout'; input: SceneLayoutInput } | { kind: 'structures'; input: MessageStructureInput };

const textPresence = (text: string) => text.trim().length ? 'x' : '';
function geometryPart(part: Part): Part {
  switch (part.type) {
    case 'text': return { id: part.id, type: part.type, text: textPresence(part.text) };
    case 'data': return { id: part.id, type: part.type, value: null };
    case 'code': return { ...part, source: '' };
    case 'web': return { ...part, excerpt: '' };
    case 'relation': return displayDependencyRole(part.relation) ? part : { ...part, roles: {} };
    // Relation roles and display references determine attachment and placement.
    default: return part;
  }
}

/** Workers need topology and text presence, never bodies or collected source evidence. */
export function createSceneComputationInput() {
  const records = new WeakMap<DemoMessage, DemoMessage>();
  const arrays = new WeakMap<DemoMessage[], DemoMessage[]>();
  const messages = (input: DemoMessage[]) => {
    let result = arrays.get(input);
    if (!result) {
      result = input.map(message => {
        let compact = records.get(message);
        if (!compact) {
          const payload = message.relationPayload;
          compact = { id: message.id, kind: message.kind, author: message.author, createdAt: message.createdAt,
            sequence: message.sequence, revision: message.revision, relationType: message.relationType,
            state: message.state, executedStance: message.executedStance,
            // Native parts own attachment. Legacy records still need their refs.
            ...(!message.parts?.length ? { sourceMessageId: message.sourceMessageId,
              sourceRefs: message.sourceRefs, targetRefs: message.targetRefs } : {}),
            content: textPresence(message.content), parts: message.parts?.map(geometryPart),
            relationPayload: payload ? {
              annotationStance: payload.annotationStance, targetLayout: payload.targetLayout,
              correctionKind: payload.correctionKind,
              ...(payload.correctionBeforeContent !== undefined ? { correctionBeforeContent: '' } : {}),
            } : undefined };
          records.set(message, compact);
        }
        return compact;
      });
      arrays.set(input, result);
    }
    return result;
  };
  return (job: SceneComputationJob): SceneComputationJob => job.kind === 'structures'
    ? { ...job, input: { ...job.input, messages: messages(job.input.messages) } }
    : { ...job, input: { ...job.input, allMessages: messages(job.input.allMessages), normals: messages(job.input.normals) } };
}
