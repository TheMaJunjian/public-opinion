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

  it('uses the personal settlement snapshot in the confirmation prompt', async () => {
    mockApi.getMessageStakes.mockResolvedValue({
      stakes: [
        { id: 'stake-1', roundId: 'round-1', side: 'PRO', amount: 12, createdAt: new Date().toISOString(), user: { username: 'tester' } },
        { id: 'stake-2', roundId: 'round-1', side: 'CON', amount: 11, createdAt: new Date().toISOString(), user: { username: 'other' } },
      ],
    });
    mockApi.getMessageRounds.mockResolvedValue({
      data: [{
        id: 'round-1',
        status: 'VOTING',
        settlementType: 'TRUTH',
        weights: { TRUE: 12, FALSE: 11, UNKNOWN: 0 },
        votes: [],
      }],
    });
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      weights: { TRUE: 12, FALSE: 11, UNKNOWN: 0 },
      votes: [],
      personalSettlement: {
        principal: 13,
        stakePrincipal: 12,
        protocolFee: 1,
        previousAfter: 13,
        after: 13,
        change: 0,
      },
    });

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '结算' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '结算' }));
    expect(await screen.findByText(/上一轮结算为 13 点/)).toBeInTheDocument();
    expect(screen.getByText(/本轮预计结算后贡献点为 23 点/)).toBeInTheDocument();
    expect(screen.getByText(/本轮预计贡献点变化：收益\s*10\s*点/)).toBeInTheDocument();
  });

  it('predicts payout for a user backing the FALSE winner', async () => {
    mockApi.getMessageStakes.mockResolvedValue({
      stakes: [
        { id: 'stake-1', roundId: 'round-1', side: 'CON', amount: 11, createdAt: new Date().toISOString(), user: { username: 'tester' } },
        { id: 'stake-2', roundId: 'round-1', side: 'PRO', amount: 10, createdAt: new Date().toISOString(), user: { username: 'other' } },
      ],
    });
    mockApi.getMessageRounds.mockResolvedValue({
      data: [{
        id: 'round-1',
        status: 'VOTING',
        settlementType: 'TRUTH',
        weights: { TRUE: 10, FALSE: 11, UNKNOWN: 0 },
        votes: [],
      }],
    });
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      weights: { TRUE: 10, FALSE: 11, UNKNOWN: 0 },
      votes: [],
      personalSettlement: {
        principal: 11,
        stakePrincipal: 11,
        protocolFee: 0,
        previousAfter: 11,
        after: 11,
        change: 0,
      },
    });

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '结算' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '结算' }));
    expect(await screen.findByText(/本轮预计结算后贡献点为 21 点/)).toBeInTheDocument();
    expect(screen.getByText(/本轮预计贡献点变化：收益\s*10\s*点/)).toBeInTheDocument();
  });

  it('uses the current user cumulative contribution, not the other users current-round stake', async () => {
    mockApi.getMessageStakes.mockResolvedValue({
      stakes: [
        { id: 'stake-previous', roundId: 'round-0', side: 'PRO', amount: 10, createdAt: new Date().toISOString(), user: { username: 'tester' } },
        { id: 'stake-current', roundId: 'round-1', side: 'CON', amount: 11, createdAt: new Date().toISOString(), user: { username: 'other' } },
      ],
    });
    mockApi.getMessageRounds.mockResolvedValue({
      data: [{
        id: 'round-1',
        status: 'VOTING',
        settlementType: 'TRUTH',
        previousRoundId: 'round-0',
        weights: { TRUE: 10, FALSE: 11, UNKNOWN: 0 },
        votes: [],
      }, {
        id: 'round-0',
        status: 'SETTLED',
        settlementType: 'TRUTH',
        result: 'TRUE',
        weights: { TRUE: 10, FALSE: 0, UNKNOWN: 0 },
        votes: [],
      }],
    });
    mockApi.getRoundDetail.mockImplementation(async (roundId: string) => ({
      id: roundId,
      status: roundId === 'round-1' ? 'VOTING' : 'SETTLED',
      settlementType: 'TRUTH',
      previousRoundId: roundId === 'round-1' ? 'round-0' : null,
      result: roundId === 'round-0' ? 'TRUE' : null,
      weights: roundId === 'round-1' ? { TRUE: 10, FALSE: 11, UNKNOWN: 0 } : { TRUE: 10, FALSE: 0, UNKNOWN: 0 },
      votes: [],
      personalSettlement: roundId === 'round-1' ? {
        principal: 11,
        stakePrincipal: 10,
        protocolFee: 1,
        previousAfter: 10,
        after: 10,
        change: 0,
      } : undefined,
    }));

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '结算' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '结算' }));
    expect(await screen.findByText(/本轮预计结算后贡献点为 0 点/)).toBeInTheDocument();
    expect(screen.getAllByText(/损失10 点/).length).toBeGreaterThan(0);
  });

  it('shows the current user projected change in settlement history using active votes', async () => {
    mockApi.getMessageStakes.mockResolvedValue({
      stakes: [
        { id: 'stake-previous', roundId: 'round-0', side: 'PRO', amount: 5, createdAt: new Date().toISOString(), user: { username: 'tester' } },
        { id: 'stake-current', roundId: 'round-1', side: 'PRO', amount: 5, createdAt: new Date().toISOString(), user: { username: 'tester' } },
        { id: 'stake-other', roundId: 'round-1', side: 'CON', amount: 11, createdAt: new Date().toISOString(), user: { username: 'other' } },
      ],
    });
    mockApi.getMessageRounds.mockResolvedValue({
      data: [
        { id: 'round-1', status: 'VOTING', settlementType: 'TRUTH', weights: { TRUE: 10, FALSE: 11, UNKNOWN: 0 }, votes: [] },
        { id: 'round-0', status: 'SETTLED', settlementType: 'TRUTH', result: 'TRUE', weights: { TRUE: 5, FALSE: 0, UNKNOWN: 0 }, votes: [] },
      ],
    });
    mockApi.getRoundDetail.mockImplementation(async (roundId: string) => ({
      id: roundId,
      status: roundId === 'round-1' ? 'VOTING' : 'SETTLED',
      settlementType: 'TRUTH',
      result: roundId === 'round-0' ? 'TRUE' : null,
      weights: roundId === 'round-1' ? { TRUE: 10, FALSE: 11, UNKNOWN: 0 } : { TRUE: 5, FALSE: 0, UNKNOWN: 0 },
      votes: [],
    }));

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    expect(await screen.findByText(/预计结算后贡献点 0 点/)).toBeInTheDocument();
    expect(screen.getByText(/损失10 点/)).toBeInTheDocument();
  });

  it('updates the history projection when active voting data refreshes', async () => {
    mockApi.getMessageStakes
      .mockResolvedValueOnce({
        stakes: [
          { id: 'stake-current', roundId: 'round-1', side: 'PRO', amount: 5, createdAt: new Date().toISOString(), user: { username: 'tester' } },
          { id: 'stake-other', roundId: 'round-1', side: 'CON', amount: 5, createdAt: new Date().toISOString(), user: { username: 'other' } },
        ],
      })
      .mockResolvedValueOnce({
        stakes: [
          { id: 'stake-current', roundId: 'round-1', side: 'PRO', amount: 5, createdAt: new Date().toISOString(), user: { username: 'tester' } },
          { id: 'stake-other', roundId: 'round-1', side: 'CON', amount: 10, createdAt: new Date().toISOString(), user: { username: 'other' } },
        ],
      });
    mockApi.getMessageRounds
      .mockResolvedValueOnce({
        data: [
          { id: 'round-1', status: 'VOTING', settlementType: 'TRUTH', weights: { TRUE: 5, FALSE: 5, UNKNOWN: 0 }, votes: [] },
          { id: 'round-0', status: 'SETTLED', settlementType: 'TRUTH', result: 'TRUE', weights: { TRUE: 1, FALSE: 0, UNKNOWN: 0 }, votes: [] },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'round-1', status: 'VOTING', settlementType: 'TRUTH', weights: { TRUE: 5, FALSE: 10, UNKNOWN: 0 }, votes: [] },
          { id: 'round-0', status: 'SETTLED', settlementType: 'TRUTH', result: 'TRUE', weights: { TRUE: 1, FALSE: 0, UNKNOWN: 0 }, votes: [] },
        ],
      });
    mockApi.getRoundDetail.mockImplementation(async () => ({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      weights: { TRUE: 5, FALSE: 5, UNKNOWN: 0 },
      votes: [],
    }));

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    expect(await screen.findByText(/预计结算后贡献点 5 点/)).toBeInTheDocument();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId: 'message-1' } }));
    });

    expect(await screen.findByText(/预计结算后贡献点 0 点/)).toBeInTheDocument();
    expect(screen.getByText(/损失5 点/)).toBeInTheDocument();
  });

  it('shows invested and current contribution points without an active round', async () => {
    mockApi.getMessageStakes.mockResolvedValue({
      stakes: [{ id: 'stake-1', roundId: 'round-0', side: 'PRO', amount: 10, createdAt: new Date().toISOString(), user: { username: 'tester' } }],
    });
    mockApi.getMessageRounds.mockResolvedValue({
      data: [{ id: 'round-0', status: 'SETTLED', settlementType: 'TRUTH', result: 'TRUE', weights: { TRUE: 10, FALSE: 5, UNKNOWN: 0 }, votes: [] }],
    });
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-0',
      status: 'SETTLED',
      settlementType: 'TRUTH',
      result: 'TRUE',
      weights: { TRUE: 10, FALSE: 5, UNKNOWN: 0 },
      votes: [],
      personalSettlement: { principal: 11, stakePrincipal: 10, protocolFee: 1, previousAfter: 8, after: 18, change: 7 },
    });

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    expect(await screen.findByText(/当前与会者投入 11 点 → 当前贡献点 18 点，收益7 点/)).toBeInTheDocument();
  });

  it('calculates active projection change from invested contribution', async () => {
    mockApi.getMessageStakes.mockResolvedValue({
      stakes: [{ id: 'stake-1', roundId: 'round-1', side: 'PRO', amount: 11, createdAt: new Date().toISOString(), user: { username: 'tester' } }],
    });
    mockApi.getMessageRounds.mockResolvedValue({
      data: [
        { id: 'round-1', status: 'VOTING', settlementType: 'TRUTH', weights: { TRUE: 11, FALSE: 11, UNKNOWN: 0 }, votes: [] },
        { id: 'round-0', status: 'SETTLED', settlementType: 'TRUTH', result: 'TRUE', weights: { TRUE: 1, FALSE: 0, UNKNOWN: 0 }, votes: [] },
      ],
    });
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      weights: { TRUE: 11, FALSE: 11, UNKNOWN: 0 },
      votes: [],
      personalSettlement: { principal: 13, stakePrincipal: 11, protocolFee: 2, previousAfter: 0, after: 0, change: 0 },
    });

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    expect(await screen.findByText(/当前与会者投入 13 点 → 预计结算后贡献点 11 点，损失2 点/)).toBeInTheDocument();
  });

  it('shows overturn when cumulative weights differ from the previous result', async () => {
    mockApi.getMessageStakes.mockResolvedValue({
      stakes: [{ id: 'stake-1', roundId: 'round-1', side: 'CON', amount: 5, createdAt: new Date().toISOString(), user: { username: 'tester' } }],
    });
    mockApi.getMessageRounds.mockResolvedValue({
      data: [{
        id: 'round-1',
        status: 'VOTING',
        settlementType: 'TRUTH',
        previousRoundId: 'round-0',
        weights: { TRUE: 0, FALSE: 5, UNKNOWN: 0 },
        votes: [],
      }, {
        id: 'round-0',
        status: 'SETTLED',
        settlementType: 'TRUTH',
        result: 'TRUE',
        weights: { TRUE: 5, FALSE: 0, UNKNOWN: 0 },
        votes: [],
      }],
    });
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      previousRoundId: 'round-0',
      weights: { TRUE: 0, FALSE: 5, UNKNOWN: 0 },
      votes: [],
    });

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    expect(await screen.findByText('推翻 ✅ TRUE → ❌ FALSE')).toBeInTheDocument();
  });

  it('compares all current weights, including empty weights, for overturn', async () => {
    mockApi.getMessageRounds.mockResolvedValue({
      data: [{
        id: 'round-1',
        status: 'VOTING',
        settlementType: 'TRUTH',
        previousRoundId: 'round-0',
        weights: { TRUE: 0, FALSE: 0, UNKNOWN: 0 },
        votes: [],
      }, {
        id: 'round-0',
        status: 'SETTLED',
        settlementType: 'TRUTH',
        result: 'TRUE',
        weights: { TRUE: 5, FALSE: 0, UNKNOWN: 0 },
        votes: [],
      }],
    });
    mockApi.getRoundDetail.mockResolvedValue({
      id: 'round-1',
      status: 'VOTING',
      settlementType: 'TRUTH',
      previousRoundId: 'round-0',
      weights: { TRUE: 0, FALSE: 0, UNKNOWN: 0 },
      votes: [],
    });

    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '投票' })).toBeInTheDocument());
    expect(screen.getByText('推翻 ✅ TRUE → ⚪ UNKNOWN')).toBeInTheDocument();
  });

  it('allows editing a non-positive amount and validates it before submitting', async () => {
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '投票' })).toBeInTheDocument());
    const amount = screen.getByRole('spinbutton');
    fireEvent.change(amount, { target: { value: '0' } });
    expect(amount).toHaveValue(0);
    fireEvent.click(screen.getByRole('button', { name: '投票' }));

    expect(await screen.findByText('投票押注必须是大于 0 的整数')).toBeInTheDocument();
    expect(mockApi.castVote).not.toHaveBeenCalled();
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
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '结算' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '结算' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认结算' }));

    await waitFor(() => expect(mockApi.closeAndSettle).toHaveBeenCalledWith('round-1'));
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'stakes-refresh',
      detail: { messageId: 'message-1' },
    }));
    dispatchSpy.mockRestore();
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
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '结算' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '结算' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认结算' }));
    expect(await screen.findByRole('button', { name: '结算中...' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '结算中...' }));

    expect(mockApi.closeAndSettle).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSettlement?.({ result: 'TRUE', weights: { TRUE: 2, FALSE: 0, UNKNOWN: 0 } });
    });
  });

  it('prevents duplicate voting while the request is pending', async () => {
    let resolveVote: ((value: unknown) => void) | undefined;
    mockApi.castVote.mockImplementation(() => new Promise(resolve => { resolveVote = resolve; }));
    render(<SettlementPanel messageId="message-1" topicId="topic-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: '投票' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '投票' }));
    expect(await screen.findByRole('button', { name: '投票中...' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '投票中...' }));

    expect(mockApi.castVote).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveVote?.({ voteId: 'vote-1', vote: 'TRUE', amount: 1 });
    });
  });
});
