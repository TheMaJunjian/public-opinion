import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StanceHistoryPanel from '../components/StanceHistoryPanel';
import type { StanceHistoryResponse, StanceRelation } from '../types';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    getUserStances: vi.fn(),
  },
}));

vi.mock('../api', () => ({ api: mockApi }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

function makeRelation(id: string): StanceRelation {
  return {
    kind: 'relation',
    id,
    relationMessageId: `relation-${id}`,
    topicId: 'topic-1',
    topicTitle: '测试分类',
    type: 'AGREE',
    amount: 1,
    stakeId: `stake-${id}`,
    targetMessageId: `message-${id}`,
    messageKind: 'TEXT',
    targetRelationType: null,
    content: `记录 ${id}`,
    createdAt: '2026-08-18T00:00:00.000Z',
  };
}

function makeResponse(relations: StanceRelation[]): StanceHistoryResponse {
  return {
    user: { id: 'user-1' },
    stances: { relations, stakes: [], tags: [] },
    pagination: {
      page: 1,
      limit: 50,
      totalRelations: 51,
      totalStakes: 0,
      totalTags: 0,
    },
  };
}

describe('StanceHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads records beyond the first page', async () => {
    mockApi.getUserStances.mockImplementation((_userId: string, params: { page?: number }) => {
      if (params.page === 2) return Promise.resolve(makeResponse([makeRelation('last')]));
      return Promise.resolve(makeResponse([makeRelation('first')]));
    });

    render(<StanceHistoryPanel userId="user-1" topicId="topic-1" />);

    await waitFor(() => {
      expect(screen.getByText(/记录 first/)).toBeInTheDocument();
      expect(screen.getByText(/记录 last/)).toBeInTheDocument();
    });
    expect(mockApi.getUserStances).toHaveBeenCalledWith('user-1', {
      topicId: 'topic-1',
      page: 2,
      limit: 50,
    });
  });
});
