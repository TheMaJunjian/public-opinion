import type { SceneLayoutInput } from './frameLayout';
import type { SceneComputationJob } from './sceneComputationInput';

export type SceneComputationRequest = { id: number; job: SceneComputationJob } | {
  id: number; patch: { baseId: number; input: Partial<SceneLayoutInput>; removed: Array<keyof SceneLayoutInput> };
};

/** Each worker owns one topology; measuring a card sends only changed geometry. */
export function createSceneRequestEncoder() {
  let previous: { id: number; job: SceneComputationJob } | null = null;
  return (id: number, job: SceneComputationJob): SceneComputationRequest => {
    let request: SceneComputationRequest = { id, job };
    if (job.kind === 'layout' && previous?.job.kind === 'layout') {
      const before = previous.job.input, next = job.input;
      if (before.allMessages === next.allMessages && before.normals === next.normals && before.edges === next.edges) {
        const input: Record<string, unknown> = {};
        const removed = (Object.keys(before) as Array<keyof SceneLayoutInput>).filter(key => !Object.hasOwn(next, key));
        for (const key of Object.keys(next) as Array<keyof SceneLayoutInput>) {
          if (!Object.hasOwn(before, key) || before[key] !== next[key]) input[key] = next[key];
        }
        request = { id, patch: { baseId: previous.id, input, removed } };
      }
    }
    // Structure planning has no incremental updates. Do not keep its potentially
    // large input alive once the worker has returned the ID-based plan.
    previous = job.kind === 'layout' ? { id, job } : null;
    return request;
  };
}

/** A restarted worker must receive a full input before it can accept geometry updates. */
export function createSceneRequestDecoder() {
  let previous: { id: number; job: SceneComputationJob } | null = null;
  return (request: SceneComputationRequest): SceneComputationJob => {
    if ('job' in request) {
      previous = request.job.kind === 'layout' ? request : null;
      return request.job;
    }
    if (!previous || previous.id !== request.patch.baseId || previous.job.kind !== 'layout') {
      throw new Error('布局输入已失效，请重新打开当前视图');
    }
    const input = { ...previous.job.input, ...request.patch.input };
    for (const key of request.patch.removed) delete input[key];
    const job: SceneComputationJob = { kind: 'layout', input };
    previous = { id: request.id, job };
    return job;
  };
}
