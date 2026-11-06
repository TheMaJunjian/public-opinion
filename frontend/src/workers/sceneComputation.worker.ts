import { computeSceneLayout } from '../utils/frameLayout';
import { planMessageStructures } from '../utils/messageStructurePlan';
import { createSceneRequestDecoder, type SceneComputationRequest } from '../utils/sceneComputationTransport';

const decode = createSceneRequestDecoder();
self.onmessage = (event: MessageEvent<SceneComputationRequest>) => {
  const { id } = event.data;
  try {
    const job = decode(event.data);
    const result = job.kind === 'layout' ? computeSceneLayout(job.input) : planMessageStructures(job.input);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
