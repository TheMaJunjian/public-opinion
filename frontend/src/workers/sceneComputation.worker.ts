import { computeSceneLayout } from '../utils/frameLayout';
import { planMessageStructures } from '../utils/messageStructurePlan';
import type { SceneComputationRequest } from '../hooks/useSceneComputation';

self.onmessage = (event: MessageEvent<SceneComputationRequest>) => {
  const { id, job } = event.data;
  try {
    const result = job.kind === 'layout' ? computeSceneLayout(job.input) : planMessageStructures(job.input);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
