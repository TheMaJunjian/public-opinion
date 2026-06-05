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
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类话题 rel-inner')).not.toBeInTheDocument();

    // Enter the outer topic by double-clicking its card
    fireEvent.doubleClick(screen.getByText('分类话题 rel-outer'));

    // After entering outer-topic focus, only the direct CLASSIFY target (rel-inner)
    // should be shown as a topic card. Nested CLASSIFY/SUMMARY are opaque — their
    // internal content (rel-merge, msg-a, msg-b) should NOT be expanded into this view.
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-inner')).toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('消息 msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
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
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('分类话题 rel-inner')).not.toBeInTheDocument();
    expect(screen.queryByText('分类话题 rel-middle')).not.toBeInTheDocument();

    // Enter the outer topic by double-clicking its card.
    fireEvent.doubleClick(screen.getByText('分类话题 rel-outer'));

    // After entering outer-topic focus, only the direct CLASSIFY target (rel-middle)
    // should be shown as a topic card. Nested CLASSIFY/SUMMARY are opaque — their
    // internal content (rel-inner, rel-merge, msg-a, msg-b) should NOT be expanded.
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-middle')).toBeInTheDocument();
    });
    expect(screen.queryByText('消息 msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 msg-b')).not.toBeInTheDocument();
    expect(screen.queryByText('归并 rel-merge')).not.toBeInTheDocument();
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

    // After entering outer-topic focus:
    // - msg-b is a direct text target, should be visible
    // - rel-merge (MERGE) is a direct relation target, should be expanded as a frame
    // - msg-a is inside rel-merge, should be visible (MERGE frames expand)
    // - rel-inner (CLASSIFY) is inside rel-merge, shown as topic card only
    // - msg-c is inside rel-inner, should NOT be visible (CLASSIFY is opaque)
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-inner')).toBeInTheDocument();
    });
    expect(screen.getByText('消息 msg-a')).toBeInTheDocument();
    expect(screen.getByText('消息 msg-b')).toBeInTheDocument();
    expect(screen.queryByText('消息 msg-c')).not.toBeInTheDocument();
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

describe('TopicDetailPage CLASSIFY topic with CORRECT-related message', () => {
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
    // msg-orig: original message classified by rel-classify
    // msg-corr: correcting message (source of rel-correct targeting msg-orig)
    // msg-other: unrelated message that should not appear in the topic view
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-orig', '原始消息'),
        makeMessage('msg-corr', '更正消息'),
        makeMessage('msg-other', '无关消息'),
      ],
    });
    // rel-correct: CORRECT (source=msg-corr, target=msg-orig)
    // rel-classify: CLASSIFY (targets=[msg-orig])
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-correct',
          topicId: 'topic-1',
          relationType: 'CORRECT',
          sourceMessageId: 'msg-corr',
          targetRefs: [{ kind: 'message', messageId: 'msg-orig' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-classify',
          topicId: 'topic-1',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-orig' }],
          payload: { title: '分类话题' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('hides both the classified message and its CORRECT-related message from list view', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-classify')).toBeInTheDocument();
    });

    // msg-orig is classified, so it should be hidden
    expect(screen.queryByText('消息 msg-orig')).not.toBeInTheDocument();
    // msg-corr is CORRECT-related to msg-orig, so it should also be hidden
    expect(screen.queryByText('消息 msg-corr')).not.toBeInTheDocument();
    // msg-other is unrelated and should still be visible
    expect(screen.getByText('消息 msg-other')).toBeInTheDocument();
  });

  it('shows classified message and its CORRECT-related message when entering classify topic', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-classify')).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText('分类话题 rel-classify'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    });
    // msg-orig (direct target) must be visible
    expect(screen.getByText('消息 msg-orig')).toBeInTheDocument();
    // msg-corr (CORRECT-related to msg-orig) must be automatically included
    expect(screen.getByText('消息 msg-corr')).toBeInTheDocument();
    // rel-correct (CORRECT relation message) must also be visible
    expect(screen.getByText('关系消息 rel-correct')).toBeInTheDocument();
    // msg-other (unrelated) must NOT appear
    expect(screen.queryByText('消息 msg-other')).not.toBeInTheDocument();
  });
});

describe('TopicDetailPage SUMMARY topic with CORRECT-related message', () => {
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
        makeMessage('msg-orig', '原始消息'),
        makeMessage('msg-corr', '更正消息'),
      ],
    });
    // rel-correct: CORRECT (source=msg-corr, target=msg-orig)
    // rel-summary: SUMMARY (targets=[msg-orig])
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-correct',
          topicId: 'topic-1',
          relationType: 'CORRECT',
          sourceMessageId: 'msg-corr',
          targetRefs: [{ kind: 'message', messageId: 'msg-orig' }],
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
        {
          id: 'rel-summary',
          topicId: 'topic-1',
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-orig' }],
          payload: { title: '总结观点', targetLayout: 'multi-column' },
          createdAt: '2024-01-01T00:02:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('shows summarized message and its CORRECT-related message when entering summary topic', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('总结 rel-summary')).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText('总结 rel-summary'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出总结' }).length).toBeGreaterThan(0);
    });
    // msg-orig (direct target) must be visible
    expect(screen.getByText('消息 msg-orig')).toBeInTheDocument();
    // msg-corr (CORRECT-related to msg-orig) must be automatically included
    expect(screen.getByText('消息 msg-corr')).toBeInTheDocument();
    // rel-correct (CORRECT relation message) must also be visible
    expect(screen.getByText('关系消息 rel-correct')).toBeInTheDocument();
  });

  it('hides CORRECT-related message from graph view when its counterpart is summarized', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    await waitFor(() => {
      expect(mockGraphView).toHaveBeenCalled();
    });
    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];
    // msg-orig is summarized → hidden from graph view
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-orig')).toBe(false);
    // msg-corr is CORRECT-related to msg-orig → also hidden from graph view
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'msg-corr')).toBe(false);
    // rel-summary itself is visible (it's the topic card)
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-summary')).toBe(true);
  });
});

describe('TopicDetailPage exit classify topic restores base view', () => {
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
    // msg-a, msg-b: classified under rel-classify
    // msg-c: unclassified (should stay visible in base view)
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('msg-a', '分类消息A'),
        makeMessage('msg-b', '分类消息B'),
        makeMessage('msg-c', '未分类消息C'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        {
          id: 'rel-classify',
          topicId: 'topic-1',
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [{ kind: 'message', messageId: 'msg-a' }, { kind: 'message', messageId: 'msg-b' }],
          payload: { title: '测试分类' },
          createdAt: '2024-01-01T00:01:00.000Z',
          createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('restores base view correctly after entering and exiting a classify topic', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    // Switch to list view for easier assertions
    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));

    // Base view: topic card visible, classified messages hidden, unclassified visible
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-classify')).toBeInTheDocument();
    });
    expect(screen.queryByText('消息 msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 msg-b')).not.toBeInTheDocument();
    expect(screen.getByText('消息 msg-c')).toBeInTheDocument();

    // Enter the classify topic
    fireEvent.doubleClick(screen.getByText('分类话题 rel-classify'));

    // Topic view: classified messages visible, topic card hidden, unclassified hidden
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('消息 msg-a')).toBeInTheDocument();
    expect(screen.getByText('消息 msg-b')).toBeInTheDocument();
    expect(screen.queryByText('消息 msg-c')).not.toBeInTheDocument();

    // Exit the classify topic
    fireEvent.click(screen.getAllByRole('button', { name: '退出分类' })[0]);

    // After exit: base view should be restored exactly as before
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-classify')).toBeInTheDocument();
    });
    expect(screen.queryByText('消息 msg-a')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 msg-b')).not.toBeInTheDocument();
    expect(screen.getByText('消息 msg-c')).toBeInTheDocument();
  });
});

describe('TopicDetailPage CLASSIFY targeting SUPPLEMENT with nested CORRECT', () => {
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
    // Simulating user's scenario: select m2, m1, m4, r10 (SUPPLEMENT), m7 → classify
    // r10 = SUPPLEMENT(source=m5, target=m6) — this is the key case
    mockApi.getMessages.mockResolvedValue({
      data: [
        makeMessage('m1', '消息1'),
        makeMessage('m2', '消息2'),
        makeMessage('m3', '消息3'),
        makeMessage('m4', '消息4'),
        makeMessage('m5', '消息5（补充源）'),
        makeMessage('m6', '消息6（补充目标）'),
        makeMessage('m7', '消息7'),
        makeMessage('m8', '无关消息'),
      ],
    });
    mockApi.getRelations.mockResolvedValue({
      data: [
        // r3: REBUT (m3 → m2)
        {
          id: 'r3', topicId: 'topic-1', relationType: 'REBUT',
          sourceMessageId: 'm3', targetRefs: [{ kind: 'message', messageId: 'm2' }],
          createdAt: '2024-01-01T00:01:00.000Z', createdBy: makeUser(),
        },
        // r4: CORRECT (m5 → m3)
        {
          id: 'r4', topicId: 'topic-1', relationType: 'CORRECT',
          sourceMessageId: 'm5', targetRefs: [{ kind: 'message', messageId: 'm3' }],
          createdAt: '2024-01-01T00:02:00.000Z', createdBy: makeUser(),
        },
        // r8: DISAGREE (m3 → m1)
        {
          id: 'r8', topicId: 'topic-1', relationType: 'DISAGREE',
          sourceMessageId: 'm3', targetRefs: [{ kind: 'message', messageId: 'm1' }],
          createdAt: '2024-01-01T00:03:00.000Z', createdBy: makeUser(),
        },
        // r10: SUPPLEMENT (source=m5, target=m6) — wraps m5→m6
        {
          id: 'r10', topicId: 'topic-1', relationType: 'SUPPLEMENT',
          sourceMessageId: 'm5',
          targetRefs: [{ kind: 'message', messageId: 'm6' }],
          createdAt: '2024-01-01T00:04:00.000Z', createdBy: makeUser(),
        },
        // r11: REFERENCE (m7 → m5)
        {
          id: 'r11', topicId: 'topic-1', relationType: 'REFERENCE',
          sourceMessageId: 'm7', targetRefs: [{ kind: 'message', messageId: 'm5' }],
          createdAt: '2024-01-01T00:05:00.000Z', createdBy: makeUser(),
        },
        // CLASSIFY targeting: m2, m1, m4, r10 (SUPPLEMENT), m7
        {
          id: 'rel-classify', topicId: 'topic-1', relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs: [
            { kind: 'message', messageId: 'm2' },
            { kind: 'message', messageId: 'm1' },
            { kind: 'message', messageId: 'm4' },
            { kind: 'relation', relationId: 'r10' },
            { kind: 'message', messageId: 'm7' },
          ],
          payload: { title: '分类话题' },
          createdAt: '2024-01-01T00:06:00.000Z', createdBy: makeUser(),
        },
      ] as Relation[],
    });
  });

  it('hides SUPPLEMENT source message (m5) and cascaded CORRECT targets from graph view', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    await waitFor(() => {
      expect(mockGraphView).toHaveBeenCalled();
    });
    const latestProps = mockGraphView.mock.calls[mockGraphView.mock.calls.length - 1][0];

    // Directly classified text messages → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm1')).toBe(false);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm2')).toBe(false);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm4')).toBe(false);
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm7')).toBe(false);
    // m6 (SUPPLEMENT target) → hidden via collectOwnedByRelation
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm6')).toBe(false);
    // m5 (SUPPLEMENT sourceMessageId) → MUST be hidden (was the bug!)
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm5')).toBe(false);
    // m3 (CORRECT target of m5) → hidden via expandTextIdsWithCorrections
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm3')).toBe(false);
    // r10 (SUPPLEMENT owned by CLASSIFY) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r10')).toBe(false);
    // r4 (CORRECT m5→m3, both endpoints hidden) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r4')).toBe(false);
    // r11 (REFERENCE m7→m5, both endpoints hidden) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r11')).toBe(false);
    // r3 (REBUT m3→m2, both endpoints hidden) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r3')).toBe(false);
    // r8 (DISAGREE m3→m1, both endpoints hidden) → hidden
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'r8')).toBe(false);
    // rel-classify → visible (topic card)
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'rel-classify')).toBe(true);
    // m8 (unrelated) → visible
    expect(latestProps.messages.some((m: { id: string }) => m.id === 'm8')).toBe(true);
  });

  it('hides SUPPLEMENT source and cascaded messages from list view', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-classify')).toBeInTheDocument();
    });

    // Directly classified → hidden
    expect(screen.queryByText('消息 m1')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 m2')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 m4')).not.toBeInTheDocument();
    expect(screen.queryByText('消息 m7')).not.toBeInTheDocument();
    // m6 (SUPPLEMENT target) → hidden
    expect(screen.queryByText('消息 m6')).not.toBeInTheDocument();
    // m5 (SUPPLEMENT sourceMessageId) → MUST be hidden (was the bug!)
    expect(screen.queryByText('消息 m5')).not.toBeInTheDocument();
    // m3 (CORRECT cascade) → hidden
    expect(screen.queryByText('消息 m3')).not.toBeInTheDocument();
    // Relation messages with all endpoints hidden → hidden
    expect(screen.queryByText('关系消息 r10')).not.toBeInTheDocument();
    expect(screen.queryByText('关系消息 r4')).not.toBeInTheDocument();
    expect(screen.queryByText('关系消息 r11')).not.toBeInTheDocument();
    expect(screen.queryByText('关系消息 r3')).not.toBeInTheDocument();
    expect(screen.queryByText('关系消息 r8')).not.toBeInTheDocument();
    // Topic card → visible
    expect(screen.getByText('分类话题 rel-classify')).toBeInTheDocument();
    // Unrelated → visible
    expect(screen.getByText('消息 m8')).toBeInTheDocument();
  });

  it('shows all owned messages when entering classify topic', async () => {
    render(<TopicDetailPage />);
    await waitFor(() => expect(mockApi.getTopic).toHaveBeenCalledWith('topic-1'));

    fireEvent.click(screen.getByRole('button', { name: '切换为列表' }));
    await waitFor(() => {
      expect(screen.getByText('分类话题 rel-classify')).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText('分类话题 rel-classify'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '退出分类' }).length).toBeGreaterThan(0);
    });

    // Inside topic: all owned messages visible
    expect(screen.getByText('消息 m1')).toBeInTheDocument();
    expect(screen.getByText('消息 m2')).toBeInTheDocument();
    expect(screen.getByText('消息 m4')).toBeInTheDocument();
    expect(screen.getByText('消息 m7')).toBeInTheDocument();
    // SUPPLEMENT source + target
    expect(screen.getByText('消息 m5')).toBeInTheDocument();
    expect(screen.getByText('消息 m6')).toBeInTheDocument();
    // CORRECT cascade
    expect(screen.getByText('消息 m3')).toBeInTheDocument();
    // Relation messages
    expect(screen.getByText('关系消息 r4')).toBeInTheDocument();
    expect(screen.getByText('关系消息 r11')).toBeInTheDocument();
    // Unrelated → NOT in topic
    expect(screen.queryByText('消息 m8')).not.toBeInTheDocument();
  });
});
