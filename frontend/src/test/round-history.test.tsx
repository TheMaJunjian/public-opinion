/**
 * round-history.test.tsx — Unit tests for RoundHistory component (Phase 4.4).
 *
 * Covers:
 *   1. Empty state: no rounds → "暂无结算记录"
 *   2. Loading state: initial render → "加载结算历史..."
 *   3. Error state: API failure → error message
 *   4. Single settled round: result label + color
 *   5. Overturn chain: TRUE→FALSE→TRUE via previousRoundId links
 *   6. Compact mode: only latest settled result
 */

import { render, screen, waitFor } from '@testing-library/react';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import RoundHistory from '../components/RoundHistory';
import type { SettlementRoundItem, MessageStakes } from '../types';

// ─── Mock API ──────────────────────────────────────────────────────────
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    getMessageRounds: vi.fn(),
    getRoundDetail: vi.fn(),
    getMessageStakes: vi.fn(),
  },
}));

vi.mock('../api', () => ({ api: mockApi }));

// ─── Fixtures ──────────────────────────────────────────────────────────

function makeRound(overrides: Partial<SettlementRoundItem> = {}): SettlementRoundItem {
  return {
    id: 'round-1',
    messageId: 'msg-1',
    createdByUserId: 'user-1',
    createdBy: { id: 'user-1', username: 'alice', createdAt: '2024-01-01T00:00:00Z' },
    status: 'SETTLED',
    settlementType: 'TRUTH',
    result: 'TRUE',
    previousRoundId: null,
    openedAt: '2024-06-01T00:00:00Z',
    closedAt: '2024-06-01T01:00:00Z',
    note: null,
    _count: { votes: 3 },
    ...overrides,
  };
}

function makeStakes(overrides: Partial<MessageStakes> = {}): MessageStakes {
  return {
    messageId: 'msg-1',
    pool: { lockedPro: 100, lockedCon: 50 },
    stakes: [
      { id: 's1', side: 'PRO', amount: 100, createdAt: '2024-06-01T00:30:00Z', user: { id: 'u1', username: 'alice', createdAt: '2024-01-01T00:00:00Z' } },
      { id: 's2', side: 'CON', amount: 50, createdAt: '2024-06-01T00:35:00Z', user: { id: 'u2', username: 'bob', createdAt: '2024-01-01T00:00:00Z' } },
    ],
    counts: { pro: 100, con: 50 },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('RoundHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Empty state ────────────────────────────────────────────

  it('shows empty message when no rounds exist', async () => {
    mockApi.getMessageRounds.mockResolvedValue({ data: [] });

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      expect(screen.getByText('暂无结算记录')).toBeInTheDocument();
    });
  });

  // ── 2. Loading state ──────────────────────────────────────────

  it('shows loading text initially', () => {
    // Never resolve — keep in loading state
    mockApi.getMessageRounds.mockReturnValue(new Promise(() => {}));

    render(<RoundHistory messageId="msg-1" />);

    expect(screen.getByText('加载结算历史...')).toBeInTheDocument();
  });

  // ── 3. Error state ────────────────────────────────────────────

  it('shows error message when API fails', async () => {
    mockApi.getMessageRounds.mockRejectedValue(new Error('网络错误'));

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      expect(screen.getByText('网络错误')).toBeInTheDocument();
    });
  });

  // ── 4. Single settled round ───────────────────────────────────

  it('renders single settled round with result label and color', async () => {
    mockApi.getMessageRounds.mockResolvedValue({
      data: [makeRound({ id: 'r1', result: 'TRUE' })],
    });

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      const btn = screen.getByText('TRUE');
      expect(btn).toBeInTheDocument();
      expect(btn.className).toContain('text-green-700');
    });
  });

  it('renders FALSE result with red color', async () => {
    mockApi.getMessageRounds.mockResolvedValue({
      data: [makeRound({ id: 'r1', result: 'FALSE' })],
    });

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      const btn = screen.getByText('FALSE');
      expect(btn).toBeInTheDocument();
      expect(btn.className).toContain('text-red-700');
    });
  });

  it('renders UNKNOWN result with amber color', async () => {
    mockApi.getMessageRounds.mockResolvedValue({
      data: [makeRound({ id: 'r1', result: 'UNKNOWN' })],
    });

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      const btn = screen.getByText('UNKNOWN');
      expect(btn).toBeInTheDocument();
      expect(btn.className).toContain('text-amber-700');
    });
  });

  // ── 5. Overturn chain (Phase 4.4 core) ────────────────────────

  it('renders TRUE→FALSE→TRUE overturn chain in correct order', async () => {
    // r1 (head, no previous) → r2 (overturns r1) → r3 (overturns r2)
    const r1 = makeRound({ id: 'r1', result: 'TRUE',  previousRoundId: null });
    const r2 = makeRound({ id: 'r2', result: 'FALSE', previousRoundId: 'r1' });
    const r3 = makeRound({ id: 'r3', result: 'TRUE',  previousRoundId: 'r2' });

    // Return in reverse order (API returns newest first)
    mockApi.getMessageRounds.mockResolvedValue({ data: [r3, r2, r1] });

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      // All three results should appear (r1=TRUE, r2=FALSE, r3=TRUE)
      const trueBtns = screen.getAllByText('TRUE');
      expect(trueBtns).toHaveLength(2);
      expect(screen.getByText('FALSE')).toBeInTheDocument();
      // There should be two arrow separators
      const arrowSpans = Array.from(document.querySelectorAll('span')).filter(s => s.textContent === '→');
      expect(arrowSpans).toHaveLength(2);
    });
  });

  it('renders chain with head detection when API returns unordered', async () => {
    // API returns r2 (middle) first, then r3 (tail), then r1 (head)
    const r1 = makeRound({ id: 'r1', result: 'TRUE',  previousRoundId: null });
    const r2 = makeRound({ id: 'r2', result: 'FALSE', previousRoundId: 'r1' });
    const r3 = makeRound({ id: 'r3', result: 'TRUE',  previousRoundId: 'r2' });

    // Scrambled order
    mockApi.getMessageRounds.mockResolvedValue({ data: [r2, r3, r1] });

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      // buildChain should find the head (r1) and chain forward
      const buttons = screen.getAllByRole('button');
      // First button in chain should be r1 (TRUE), last should be r3 (TRUE)
      expect(buttons[0]).toHaveTextContent('TRUE');
      expect(buttons[buttons.length - 1]).toHaveTextContent('TRUE');
    });
  });

  it('renders VOTING round with indigo styling in chain', async () => {
    const r1 = makeRound({ id: 'r1', result: 'TRUE', previousRoundId: null });
    const r2 = makeRound({ id: 'r2', status: 'VOTING', result: null, previousRoundId: 'r1' });

    mockApi.getMessageRounds.mockResolvedValue({ data: [r2, r1] });

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      const votingBtn = screen.getByText('—'); // null result shows '—'
      expect(votingBtn).toBeInTheDocument();
      expect(votingBtn.className).toContain('text-indigo-600');
    });
  });

  it('renders CANCELLED round with gray styling', async () => {
    const r1 = makeRound({ id: 'r1', status: 'CANCELLED', result: null, previousRoundId: null });

    mockApi.getMessageRounds.mockResolvedValue({ data: [r1] });

    render(<RoundHistory messageId="msg-1" />);

    await waitFor(() => {
      // CANCELLED rounds show ⊘ prefix and gray styling
      const btn = screen.getByTitle('已取消 · —');
      expect(btn).toBeInTheDocument();
      expect(btn.className).toContain('text-gray-500');
      expect(btn.textContent).toContain('⊘');
    });
  });

  // ── 6. Compact mode ───────────────────────────────────────────

  it('shows only latest settled result in compact mode', async () => {
    const r1 = makeRound({ id: 'r1', result: 'TRUE',  previousRoundId: null });
    const r2 = makeRound({ id: 'r2', result: 'FALSE', previousRoundId: 'r1' });

    mockApi.getMessageRounds.mockResolvedValue({ data: [r2, r1] });

    render(<RoundHistory messageId="msg-1" compact />);

    await waitFor(() => {
      // Should show FALSE (latest settled, r2)
      expect(screen.getByText('FALSE')).toBeInTheDocument();
      // Should NOT show the chain with TRUE
      expect(screen.queryByText('TRUE')).not.toBeInTheDocument();
    });
  });

  it('shows "未结算" in compact mode when no settled rounds', async () => {
    const r1 = makeRound({ id: 'r1', status: 'VOTING', result: null, previousRoundId: null });

    mockApi.getMessageRounds.mockResolvedValue({ data: [r1] });

    render(<RoundHistory messageId="msg-1" compact />);

    await waitFor(() => {
      expect(screen.getByText('未结算')).toBeInTheDocument();
    });
  });

  // ── 7. Double-click expands round detail ──────────────────────

  it('expands round detail on double-click', async () => {
    const r1 = makeRound({ id: 'r1', result: 'TRUE', previousRoundId: null, _count: { votes: 3 } });
    const detailWithWeights: SettlementRoundItem = {
      ...r1,
      weights: { TRUE: 300, FALSE: 100, UNKNOWN: 50 },
      votes: [
        { id: 'v1', vote: 'TRUE', amount: 200, createdAt: '2024-06-01T00:30:00Z', user: { id: 'u1', username: 'alice', createdAt: '2024-01-01T00:00:00Z' } },
      ],
    };

    mockApi.getMessageRounds.mockResolvedValue({ data: [r1] });
    // RoundDetail calls getRoundDetail when round prop lacks votes
    mockApi.getRoundDetail.mockResolvedValue(detailWithWeights);
    // RoundDetail always calls getMessageStakes for stake list
    mockApi.getMessageStakes.mockResolvedValue(makeStakes());

    render(<RoundHistory messageId="msg-1" />);

    // Wait for chain to render
    await waitFor(() => {
      expect(screen.getByText('TRUE')).toBeInTheDocument();
    });

    // Double-click the round button to expand
    const btn = screen.getByText('TRUE');
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // Detail panel should appear with round ID
    await waitFor(() => {
      expect(screen.getByText('r1')).toBeInTheDocument();
    });
  });
});
