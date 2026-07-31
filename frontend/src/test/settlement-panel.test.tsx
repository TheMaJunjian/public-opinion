import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettlementPanel from '../components/SettlementPanel';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    getMessageStakes: vi.fn(),
    getMessageRounds: vi.fn(),
    getRoundDetail: vi.fn(),
    castVote: vi.fn(),
    createRound: vi.fn(),
    closeAndSettle: vi.fn(),
  },
}));

vi.mock('../api', () => ({ api: mockApi }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1', username: 'tester' } }),
}));

describe('SettlementPanel voting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getMessageStakes.mockResolvedValue({ stakes: [] });
    mockApi.getMessageRounds.mockResolvedValue({
      data: [{
        id: 'round-1',
        status: 'VOTING',
        settlementType: 'TRUTH',
        weights: { TRUE: 0, FALSE: 0, UNKNOWN: 0 },
        votes: [],
      }],
    });
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      weights: { TRUE: 0, FALSE: 0, UNKNOWN: 0 },
      votes: [],
    });
  });

  it('shows the API error when voting fails', async () => {
    mockApi.castVote.mockRejectedValue(new Error('余额不足'));
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '投票' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '投票' }));

    expect(await screen.findByText('余额不足')).toBeInTheDocument();
  });

  it('normalizes a non-positive voting amount before submitting', async () => {
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '投票' })).toBeInTheDocument());
    const amount = screen.getByRole('spinbutton');
    fireEvent.change(amount, { target: { value: '0' } });
    expect(amount).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: '投票' }));

    await waitFor(() => expect(mockApi.castVote).toHaveBeenCalledWith('round-1', { vote: 'TRUE', amount: 1 }));
  });
});
