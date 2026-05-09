import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('shows only outer classify targets and their related messages after entering topic', async () => {
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

    // After entering outer-topic focus, only the outer target relation (rel-inner)
    // and its related messages should be shown.
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-inner')).toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    expect(screen.getByText('消息 msg-a')).toBeInTheDocument();
    expect(screen.getByText('消息 msg-b')).toBeInTheDocument();
    expect(screen.getByText('关系消息 rel-merge')).toBeInTheDocument();
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

  it('shows only outer classify targets and their related messages in deeply nested case', async () => {
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

    // After entering outer-topic focus, the middle topic card (direct target) and
    // its related relation/text messages should be visible.
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-middle')).toBeInTheDocument();
    });
    expect(screen.getByText('消息 msg-a')).toBeInTheDocument();
    expect(screen.getByText('消息 msg-b')).toBeInTheDocument();
    expect(screen.getByText('关系消息 rel-merge')).toBeInTheDocument();
    expect(screen.getByText('分类话题 rel-inner')).toBeInTheDocument();
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

  it('hides summary targets only in graph view and shows only summary targets in summary focus', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    // Graph view receives summary relation message for rendering.
    await waitFor(() => {
      expect(mockGraphView).toHaveBeenCalled();
    });
    const latestGraphProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1]?.[0];
    expect(latestGraphProps?.messages?.some((m: { id: string }) => m.id === 'rel-summary')).toBe(true);
    expect(latestGraphProps?.messages?.some((m: { id: string }) => m.id === 'msg-1')).toBe(false);

    // In list view, summary target text should remain visible.
    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('总结 rel-summary')).toBeInTheDocument();
    });
    expect(screen.getByText('消息 msg-1')).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('总结 rel-summary'));
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出总结' }).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('消息 msg-1')).toBeInTheDocument();
    expect(screen.queryByText('总结 rel-summary')).not.toBeInTheDocument();
  });
});

describe('TopicDetailPage merge frame double-click popup', () => {
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
      data: [makeMessage('msg-1', '第一条')],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-merge',
          topicId: 'topic-1',
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-1' }],
          payload: { title: '归并标签', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows creator and send time popup when merge frame label is double-clicked', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    act(() => {
      latestProps.onGroupFrameDoubleClick(
        { stopPropagation: vi.fn(), clientX: 120, clientY: 140 } as unknown as React.MouseEvent,
        'rel-merge'
      );
    });

    await waitFor(() => {
      expect(screen.getByText('归并关系信息')).toBeInTheDocument();
      expect(screen.getByText(/创建者：/)).toBeInTheDocument();
      expect(screen.getByText(/发送时间：/)).toBeInTheDocument();
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

  it('shows outer classify targets and related nested messages when entering outer classify', async () => {
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
    expect(screen.getByText('消息 msg-a')).toBeInTheDocument();
    expect(screen.getByText('消息 msg-b')).toBeInTheDocument();
    expect(screen.getByText('消息 msg-c')).toBeInTheDocument();
  });
});

describe('TopicDetailPage MERGE graph frame visibility', () => {
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
      data: [makeMessage('msg-1', '第一条'), makeMessage('msg-2', '第二条')],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-merge',
          topicId: 'topic-1',
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'message', messageId: 'msg-2' }],
          payload: { title: '归并标签', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('includes MERGE text targets in graphMessages so the frame can be rendered', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    // MERGE text targets must be in graphMessages for frame bounds computation.
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-1')).toBe(true);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-2')).toBe(true);
    // MERGE relation message itself must also be present.
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-merge')).toBe(true);
  });
});

describe('TopicDetailPage CLASSIFY topic with supplement source visibility', () => {
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
    // msg-a is the source of rel-supp; msg-b is the target
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-a', '补充来源'),
        makeMessage('msg-b', '被补充消息'),
      ],
    });
    // rel-supp: SUPPLEMENT (source=msg-a, target=msg-b)
    // rel-classify: CLASSIFY (targets=[rel-supp])
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-supp',
          topicId: 'topic-1',
          relationType: 'SUPPLEMENT',
          sourceMessageId: 'msg-a',
          targetRefs: [{ kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-classify',
          topicId: 'topic-1',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }],
          payload: { title: '分类话题' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows supplement relation and its source text when entering classify topic', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-classify')).toBeInTheDocument();
    });

    // Enter the classify topic
    fireEvent.doubleClick(screen.getByText('分类话题 rel-classify'));

    await waitFor(() => {
      // The SUPPLEMENT relation message must be visible in the topic view
      expect(screen.getByText('关系消息 rel-supp')).toBeInTheDocument();
    });
    // The supplement's source text (msg-a) must also be visible so its frame can render
    expect(screen.getByText('消息 msg-a')).toBeInTheDocument();
    // The supplement's target text (msg-b) must be visible
    expect(screen.getByText('消息 msg-b')).toBeInTheDocument();
  });
});

describe('TopicDetailPage SUMMARY topic with supplement source visibility', () => {
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
        makeMessage('msg-a', '补充来源'),
        makeMessage('msg-b', '被补充消息'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-supp',
          topicId: 'topic-1',
          relationType: 'SUPPLEMENT',
          sourceMessageId: 'msg-a',
          targetRefs: [{ kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-summary',
          topicId: 'topic-1',
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }],
          payload: { title: '总结观点', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows supplement relation and its source text when entering summary topic', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('总结 rel-summary')).toBeInTheDocument();
    });

    // Enter the summary topic
    fireEvent.doubleClick(screen.getByText('总结 rel-summary'));

    await waitFor(() => {
      expect(screen.getByText('关系消息 rel-supp')).toBeInTheDocument();
    });
    expect(screen.getByText('消息 msg-a')).toBeInTheDocument();
    expect(screen.getByText('消息 msg-b')).toBeInTheDocument();
  });
});

describe('TopicDetailPage MERGE with nested relation target graph visibility', () => {
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
      data: [makeMessage('msg-a', '消息A'), makeMessage('msg-b', '消息B')],
    });
    // rel-supp: SUPPLEMENT (source=msg-a, target=msg-b)
    // rel-merge: MERGE targeting [rel-supp]
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-supp',
          topicId: 'topic-1',
          relationType: 'SUPPLEMENT',
          sourceMessageId: 'msg-a',
          targetRefs: [{ kind: 'message', messageId: 'msg-b' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-merge',
          topicId: 'topic-1',
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: [{ kind: 'relation', relationId: 'rel-supp' }],
          payload: { title: '归并标签' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('includes MERGE-owned relation messages in graphMessages for nested frame rendering', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));
    await waitFor(() => expect(mockGraphView).toHaveBeenCalled());

    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    // The MERGE relation message must be visible
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-merge')).toBe(true);
    // The MERGE-owned SUPPLEMENT and its text targets must also be in graphMessages
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-supp')).toBe(true);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-a')).toBe(true);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-b')).toBe(true);
  });
});
