import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import TopicDetailPage from '../pages/TopicDetailPage';
import type { Message, Relation, Topic, User } from '../types';

const { mockApi, mockNavigate, mockGraphView } = vi.hoisted(() => ({
  mockApi: {
    getTopic: vi.fn(),
    getMessages: vi.fn(),
    getRelations: vi.fn(),
  },
  mockNavigate: vi.fn(),
  mockGraphView: vi.fn(),
}));

vi.mock('../api', () => ({ api: mockApi }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
  }),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ topicId: 'topic-1' }),
    useNavigate: () => mockNavigate,
  };
});
vi.mock('../components/GraphView', async () => {
  const actual = await vi.importActual<typeof import('../components/GraphView')>('../components/GraphView');
  return {
    ...actual,
    default: (props: any) => {
      mockGraphView(props);
      return <div data-testid="graph-view" />;
    },
  };
});

function makeUser(): User {
  return { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' };
}

function makeMessage(id: string, content: string): Message {
  return {
    id,
    topicId: 'topic-1',
    contentType: 'TEXT',
    content,
    createdAt: '2024-01-01T00:00:00.000Z',
    createdBy: makeUser(),
  };
}

function makeRelation(): Relation {
  return {
    id: 'rel-1',
    topicId: 'topic-1',
    relationType: 'REPLY',
    sourceMessageId: 'msg-2',
    targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
    createdAt: '2024-01-01T00:01:00.000Z',
    createdBy: makeUser(),
  };
}

describe('TopicDetailPage composer refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const topic: Topic = {
      id: 'topic-1',
      title: '测试话题',
      status: 'OPEN',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      createdBy: makeUser(),
    };
    mockApi.getTopic.mockResolvedValue(topic);
    mockApi.getMessages.mockResolvedValue({ data: [makeMessage('msg-1', '第一条'), makeMessage('msg-2', '第二条')] });
    mockApi.getRelations.mockResolvedValue({ data: [makeRelation()] });
  });

  it('re-enables the textarea after clearing draft targets and switching relation types', async () => {
    render(<TopicDetailPage />);

    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    fireEvent.click(screen.getByRole('button', { name: '标注' }));
    fireEvent.click(screen.getByText('关系消息 rel-1'));
    fireEvent.click(screen.getByRole('button', { name: '推荐' }));

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('已选择附加关系，此处不可输入');
      expect(textarea).toHaveAttribute('readonly');
    });

    fireEvent.click(screen.getByRole('button', { name: '清空' }));

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText('输入一条新普通消息（支持自由换行）');
      expect(textarea).not.toHaveAttribute('readonly');
    });

    fireEvent.click(screen.getByRole('button', { name: '引用' }));
    expect(screen.getByText('请在画布中选择目标消息')).toBeInTheDocument();
  });
});

describe('TopicDetailPage nested-classify merge expansion', () => {
  const topic: Topic = {
    id: 'topic-1',
    title: '测试话题',
    status: 'OPEN',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getTopic.mockResolvedValue(topic);
    // Normal text messages
    mockApi.getMessages.mockResolvedValue({
      data: [
        { id: 'msg-a', topicId: 'topic-1', contentType: 'TEXT', content: '消息A', createdAt: '2024-01-01T00:00:00.000Z', createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' } },
        { id: 'msg-b', topicId: 'topic-1', contentType: 'TEXT', content: '消息B', createdAt: '2024-01-01T00:01:00.000Z', createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' } },
      ],
    });
    // Relations:
    //   rel-merge  (MERGE)    → targets msg-a, msg-b
    //   rel-inner  (CLASSIFY) → targets rel-merge (nested classify owning the merge)
    //   rel-outer  (CLASSIFY) → targets rel-inner (outer classify containing the inner topic)
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-merge', topicId: 'topic-1', relationType: 'MERGE', sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-a' }, { kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-inner', topicId: 'topic-1', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }],
          payload: { title: '内层话题' },
          createdAt: '2024-01-01T00:03:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-outer', topicId: 'topic-1', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-inner' }],
          payload: { title: '外层话题' },
          createdAt: '2024-01-01T00:04:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      ],
    });
  });

  it('prevents merge-relation text messages from expanding into outer topic view', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    // Switch to list view
    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));

    // On the main canvas only the outer classify topic card should be visible;
    // msg-a, msg-b, rel-merge, and rel-inner are hidden (classified away).
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-outer')).toBeInTheDocument();
    });
    expect(screen.queryByText('消息 msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('关系消息 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类话题 rel-inner')).not.toBeInTheDocument();

    // Enter the outer topic by double-clicking its card
    fireEvent.doubleClick(screen.getByText('分类话题 rel-outer'));

    // After entering outer-topic focus, the inner topic card should be shown,
    // but the merge-relation text messages (msg-a, msg-b) must NOT be expanded
    // into the outer view — they belong to the inner topic.
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-inner')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '退出分类' })).toBeInTheDocument();
    expect(screen.queryByText('消息 msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('关系消息 rel-merge')).not.toBeInTheDocument();
  });
});

describe('TopicDetailPage deeply nested classify → classify → merge', () => {
  const topic: Topic = {
    id: 'topic-1',
    title: '测试话题',
    status: 'OPEN',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getTopic.mockResolvedValue(topic);
    // Normal text messages
    mockApi.getMessages.mockResolvedValue({
      data: [
        { id: 'msg-a', topicId: 'topic-1', contentType: 'TEXT', content: '消息A', createdAt: '2024-01-01T00:00:00.000Z', createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' } },
        { id: 'msg-b', topicId: 'topic-1', contentType: 'TEXT', content: '消息B', createdAt: '2024-01-01T00:01:00.000Z', createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' } },
      ],
    });
    // Relations:
    //   rel-merge   (MERGE)    → targets msg-a, msg-b
    //   rel-inner   (CLASSIFY) → targets rel-merge
    //   rel-middle  (CLASSIFY) → targets rel-inner  (nested classify inside outer)
    //   rel-outer   (CLASSIFY) → targets rel-middle (outermost topic)
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-merge', topicId: 'topic-1', relationType: 'MERGE', sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-a' }, { kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-inner', topicId: 'topic-1', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }],
          payload: { title: '内层话题' },
          createdAt: '2024-01-01T00:03:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-middle', topicId: 'topic-1', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-inner' }],
          payload: { title: '中层话题' },
          createdAt: '2024-01-01T00:04:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'rel-outer', topicId: 'topic-1', relationType: 'CLASSIFY', sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-middle' }],
          payload: { title: '外层话题' },
          createdAt: '2024-01-01T00:05:00.000Z',
          createdBy: { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      ],
    });
  });

  it('prevents deeply nested merge-relation text messages from expanding into outer topic view', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    // Switch to list view
    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));

    // On the main canvas only the outer classify topic card should be visible.
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-outer')).toBeInTheDocument();
    });
    expect(screen.queryByText('消息 msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('关系消息 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类话题 rel-inner')).not.toBeInTheDocument();
    expect(screen.queryByText('分类话题 rel-middle')).not.toBeInTheDocument();

    // Enter the outer topic by double-clicking its card.
    fireEvent.doubleClick(screen.getByText('分类话题 rel-outer'));

    // After entering outer-topic focus, only the middle topic card should be shown.
    // msg-a, msg-b, rel-merge, and rel-inner must NOT be expanded into the outer view.
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-middle')).toBeInTheDocument();
    });
    expect(screen.queryByText('消息 msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('关系消息 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类话题 rel-inner')).not.toBeInTheDocument();
  });
});

describe('TopicDetailPage summary relation visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const topic: Topic = {
      id: 'topic-1',
      title: '测试话题',
      status: 'OPEN',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      createdBy: makeUser(),
    };
    mockApi.getTopic.mockResolvedValue(topic);
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-1', '第一条'),
        makeMessage('msg-2', '第二条'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-summary',
          topicId: 'topic-1',
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
          payload: { title: '总结观点', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows summary relation in list view and keeps it in graph-render messages', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    // Graph view receives summary relation message for rendering.
    await waitFor(() => {
      expect(mockGraphView).toHaveBeenCalled();
    });
    const latestGraphProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1]?.[0];
    expect(latestGraphProps?.messages?.some((m: { id: string }) => m.id === 'rel-summary')).toBe(true);

    // In list view, summary topic card is visible while its target text message is hidden.
    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('总结 rel-summary')).toBeInTheDocument();
    });
    expect(screen.queryByText('消息 msg-1')).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('总结 rel-summary'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '退出总结' })).toBeInTheDocument();
    });
  });
});

describe('TopicDetailPage classify containing merge with nested classify target', () => {
  const topic: Topic = {
    id: 'topic-1',
    title: '测试话题',
    status: 'OPEN',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    createdBy: makeUser(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getTopic.mockResolvedValue(topic);
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-a', '消息A'),
        makeMessage('msg-b', '消息B'),
        makeMessage('msg-c', '消息C'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-inner',
          topicId: 'topic-1',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-c' }],
          payload: { title: '内层话题' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-merge',
          topicId: 'topic-1',
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-a' }, { kind: 'relation', relationId: 'rel-inner' }],
          createdAt: '2024-01-01T00:03:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-outer',
          topicId: 'topic-1',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-merge' }, { kind: 'message', messageId: 'msg-b' }],
          payload: { title: '外层话题' },
          createdAt: '2024-01-01T00:04:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('keeps nested classify-owned text hidden when entering outer classify', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-outer')).toBeInTheDocument();
    });
    fireEvent.doubleClick(screen.getByText('分类话题 rel-outer'));

    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-inner')).toBeInTheDocument();
    });
    expect(screen.queryByText('消息 msg-c')).not.toBeInTheDocument();
  });
});
