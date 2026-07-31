import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('refreshes the target stakes after settlement', async () => {
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      weights: { TRUE: 2, FALSE: 0, UNKNOWN: 0 },
      votes: [],
    });
    mockApi.closeAndSettle.mockResolvedValue({
      result: 'TRUE',
      weights: { TRUE: 2, FALSE: 0 },
    });
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '结算' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '结算' }));

    await waitFor(() => expect(mockApi.closeAndSettle).toHaveBeenCalledWith('round-1'));
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'stakes-refresh',
      detail: { messageId: 'message-1' },
    }));
    dispatchSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('prevents duplicate round creation while the request is pending', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    mockApi.getMessageRounds.mockResolvedValue({ data: [] });
    mockApi.createRound.mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '发起结算' })).toBeEnabled());
    const createButton = screen.getByRole('button', { name: '发起结算' });
    fireEvent.click(createButton);
    expect(await screen.findByRole('button', { name: '创建中...' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '创建中...' }));

    expect(mockApi.createRound).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCreate?.({ id: 'round-2', settlementType: 'TRUTH' });
    });
  });

  it('prevents duplicate settlement while the request is pending', async () => {
    let resolveSettlement: ((value: unknown) => void) | undefined;
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      weights: { TRUE: 2, FALSE: 0, UNKNOWN: 0 },
      votes: [],
    });
    mockApi.closeAndSettle.mockImplementation(() => new Promise(resolve => { resolveSettlement = resolve; }));
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '结算' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '结算' }));
    expect(await screen.findByRole('button', { name: '结算中...' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '结算中...' }));

    expect(mockApi.closeAndSettle).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSettlement?.({ result: 'TRUE', weights: { TRUE: 2, FALSE: 0, UNKNOWN: 0 } });
    });
    vi.unstubAllGlobals();
  });
});
