import { expect, it, vi } from 'vitest';
import { handleInlineBadgeDoubleClick } from '../pages/workbench/actions/relationActions';
import type { DemoEdge } from '../utils/modelBridge';
import type { MouseEvent } from 'react';

it.each(['attention', 'block', 'recommend', 'archive'] as const)('opens %s annotation details without a correction comparison', type => {
  const edges: DemoEdge[] = ['yes', 'no'].map(id => ({ id, relationMessageId:id, relationType:type, relationLabel:type,
    from:{messageId:`anon:${id}`,selection:{kind:'whole'}}, to:{messageId:'target',selection:{kind:'whole'}} }));
  const dependencies = { edges, setTagPopup:vi.fn(), enterTemporaryCategory:vi.fn(), setJoinFilterTargetId:vi.fn(),
    setCorrectionFilterTargetId:vi.fn(), setViewMode:vi.fn(), setComparisonPopup:vi.fn() };
  const detail = {relMsgIds:['yes'],subDetails:[{subType:'YES',count:1}]};
  handleInlineBadgeDoubleClick(dependencies, {stopPropagation:vi.fn(),clientX:10,clientY:20} as unknown as MouseEvent, 'yes', detail);
  expect(dependencies.setTagPopup).toHaveBeenCalledWith(expect.objectContaining({messageId:'target',...detail}));
  expect(dependencies.setComparisonPopup).not.toHaveBeenCalled();
  expect(dependencies.enterTemporaryCategory).not.toHaveBeenCalled();
});
