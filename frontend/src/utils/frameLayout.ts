import { computeFrameSceneLayout, type SceneLayoutInput } from './frameLayoutCore';
import { layoutDiscussion } from './discussionLayout';

export { INITIAL_FRAME_MAX_WIDTH, INITIAL_FRAME_MAX_HEIGHT } from './frameLayoutCore';
export type { FrameBlock, Box, FrameViewSize, SceneLayoutInput } from './frameLayoutCore';

/** Full graph entry point; ordinary structure paging uses the base layout only. */
export function computeSceneLayout(input: SceneLayoutInput) {
  return computeFrameSceneLayout(input, layoutDiscussion);
}
