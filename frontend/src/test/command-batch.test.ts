import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelCommandBatch, queueCommand, runCommandBatch, type CommandEnvelope } from '../api/commandBatch';

beforeEach(() => { sessionStorage.clear(); localStorage.setItem('user', JSON.stringify({ id: 'u', username: '用户' })); });
const add = (body: object) => queueCommand('/messages', { method: 'POST', body: JSON.stringify(body) });

describe('workbench sends', () => {
  it('preserves references between new messages and submits the entire operation once', async () => {
    const commit = vi.fn<(input: CommandEnvelope) => Promise<unknown>>(async () => ({}));
    let target = '';
    await runCommandBatch(async () => {
      target = add({ content: '新内容' })!.id;
      queueCommand('/relations', { method: 'POST', body: JSON.stringify({ relationType: 'AGREE', targetRefs: [{ kind: 'message', messageId: target }] }) });
    }, commit);
    expect(commit).toHaveBeenCalledOnce();
    const payload = commit.mock.calls[0][0];
    expect(payload.commands).toHaveLength(2);
    expect(payload.commands[1].body.targetRefs).toEqual([{ kind: 'message', messageId: target }]);
    expect(payload.commands[0].id).toBe(target);
  });

  it('does not submit anything when a later command fails validation', async () => {
    const commit = vi.fn();
    await expect(runCommandBatch(async () => { add({ content: '正文' }); cancelCommandBatch(new Error('缺少目标')); }, commit)).rejects.toThrow('缺少目标');
    expect(commit).not.toHaveBeenCalled();
  });

  it('reports committed commands only after a real commit, never after empty validation or a rejected request', async () => {
    const committed = vi.fn(), commit = vi.fn();
    await runCommandBatch(async () => undefined, commit, committed);
    expect(commit).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
    commit.mockRejectedValueOnce(Object.assign(new Error('服务器拒绝'), { status: 400 }));
    await expect(runCommandBatch(async () => { add({ content: '正文' }); }, commit, committed)).rejects.toThrow('服务器拒绝');
    expect(committed).not.toHaveBeenCalled();
    commit.mockResolvedValueOnce({});
    await runCommandBatch(async () => { add({ content: '正文' }); }, commit, committed);
    expect(committed).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('confirms the same intent with its original command references after a lost response', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new TypeError('网络中断')).mockResolvedValueOnce({});
    const committed = vi.fn();
    const send = () => runCommandBatch(async () => {
      const target = add({ content: '同一笔发送' })!.id;
      queueCommand('/relations', { method: 'POST', body: JSON.stringify({ relationType: 'AGREE', targetRefs: [{ kind: 'message', messageId: target }] }) });
      return target;
    }, commit, committed);
    await expect(send()).rejects.toThrow('发送结果尚未确认');
    await expect(send()).resolves.toBe(commit.mock.calls[0][0].commands[0].id);
    expect(commit.mock.calls[0][0]).toEqual(commit.mock.calls[1][0]);
    expect(committed).toHaveBeenCalledExactlyOnceWith(2);
    await send();
    expect(commit.mock.calls[2][0].requestId).not.toBe(commit.mock.calls[0][0].requestId);
    expect(commit.mock.calls[2][0].commands[0].id).not.toBe(commit.mock.calls[0][0].commands[0].id);
  });

  it('reconciles the old send without submitting changed input or reporting that input committed', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new TypeError('lost')).mockResolvedValue({}), committed = vi.fn();
    const send = (content: string) => runCommandBatch(async () => add({ content }), commit, committed);
    await expect(send('旧输入')).rejects.toThrow('尚未确认');
    await expect(send('编辑后的输入')).rejects.toThrow('当前输入与上一笔不同');
    expect(commit.mock.calls[1][0]).toEqual(commit.mock.calls[0][0]);
    expect(committed).not.toHaveBeenCalled();
    await send('编辑后的输入');
    expect(commit.mock.calls[2][0].commands[0].body.content).toBe('编辑后的输入');
    expect(commit.mock.calls[2][0].requestId).not.toBe(commit.mock.calls[0][0].requestId);
  });

  it('keeps an explicitly unknown outcome even if it carries an apparent 4xx status', async () => {
    const commit = vi.fn().mockRejectedValueOnce(Object.assign(new Error('outcome unknown'), { status: 400, unknownOutcome: true })).mockResolvedValue({});
    const send = () => runCommandBatch(async () => add({ content: '核对同一笔' }), commit);
    await expect(send()).rejects.toMatchObject({ unknownOutcome: true });
    await send();
    expect(commit.mock.calls[1][0]).toEqual(commit.mock.calls[0][0]);
  });

  it('keeps pending identities separate for different API endpoints', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({});
    const send = (apiBase: string) => runCommandBatch(async () => add({ content: '相同内容' }), commit, undefined, { apiBase });
    await expect(send('https://first.invalid/api')).rejects.toThrow('尚未确认');
    await send('https://second.invalid/api');
    expect(commit.mock.calls[1][0].requestId).not.toBe(commit.mock.calls[0][0].requestId);
    await send('https://first.invalid/api');
    expect(commit.mock.calls[2][0]).toEqual(commit.mock.calls[0][0]);
  });

  it('does not prepare or dispatch a competing batch while the first commit is pending', async () => {
    let finish!: () => void;
    const commit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = runCommandBatch(async () => add({ content: '第一笔' }), commit);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    const work = vi.fn(async () => add({ content: '第二笔' }));
    await expect(runCommandBatch(work, commit)).rejects.toThrow('正在发送');
    expect(work).not.toHaveBeenCalled();
    finish(); await first;
    const nextCommit = vi.fn(async () => ({}));
    await runCommandBatch(work, nextCommit);
    expect(nextCommit).toHaveBeenCalledOnce();
  });

  it('keeps the lock during recovery as well as the initial commit', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new Error('lost'));
    const send = () => runCommandBatch(async () => add({ content: '重试中的发送' }), commit);
    await expect(send()).rejects.toThrow('尚未确认');
    let finish!: () => void;
    commit.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const retry = send();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    await expect(send()).rejects.toThrow('正在发送');
    finish(); await retry;
  });

  it('does not commit preparation after an account switch and releases the lock', async () => {
    let finish!: () => void;
    const commit = vi.fn(async () => ({}));
    const first = runCommandBatch(async () => { add({ content: '旧账号输入' }); await new Promise<void>(resolve => { finish = resolve; }); }, commit);
    localStorage.setItem('user', JSON.stringify({ id: 'other', username: '另一用户' }));
    finish();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(commit).not.toHaveBeenCalled();
    await runCommandBatch(async () => add({ content: '新账号输入' }), commit);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('clears only the captured owner after success and never calls a new account completion callback', async () => {
    const committed = vi.fn();
    const commit = vi.fn<(input: CommandEnvelope) => Promise<unknown>>(async () => { localStorage.setItem('user', JSON.stringify({ id: 'other', username: '另一用户' })); return {}; });
    await expect(runCommandBatch(async () => add({ content: '旧账号发送' }), commit, committed)).rejects.toMatchObject({ name: 'AbortError' });
    expect(committed).not.toHaveBeenCalled();
    localStorage.setItem('user', JSON.stringify({ id: 'u', username: '用户' }));
    const nextCommit = vi.fn<(input: CommandEnvelope) => Promise<unknown>>(async () => ({}));
    await runCommandBatch(async () => add({ content: '旧账号发送' }), nextCommit);
    expect(nextCommit.mock.calls[0][0].requestId).not.toBe(commit.mock.calls[0][0].requestId);
  });

  it('retains the original owner pending record when an unknown response arrives after switching accounts', async () => {
    const original = vi.fn<(input: CommandEnvelope) => Promise<unknown>>(async () => { localStorage.setItem('user', JSON.stringify({ id: 'other', username: '另一用户' })); throw new Error('lost'); });
    await expect(runCommandBatch(async () => add({ content: '旧账号未确认' }), original)).rejects.toThrow('尚未确认');
    const other = vi.fn().mockRejectedValueOnce(new Error('other lost')).mockResolvedValue({});
    await expect(runCommandBatch(async () => add({ content: '新账号未确认' }), other)).rejects.toThrow('尚未确认');
    localStorage.setItem('user', JSON.stringify({ id: 'u', username: '用户' }));
    const recover = vi.fn<(input: CommandEnvelope) => Promise<unknown>>(async () => ({}));
    await runCommandBatch(async () => add({ content: '旧账号未确认' }), recover);
    expect(recover.mock.calls[0][0]).toEqual(original.mock.calls[0][0]);
    localStorage.setItem('user', JSON.stringify({ id: 'other', username: '另一用户' }));
    await runCommandBatch(async () => add({ content: '新账号未确认' }), other);
    expect(other.mock.calls[1][0]).toEqual(other.mock.calls[0][0]);
  });

  it('recovers the old same-origin storage format without replaying it on another API', async () => {
    const previous = { requestId: crypto.randomUUID(), commands: [{ id: crypto.randomUUID(), method: 'POST', path: '/messages', body: { content: '旧格式待确认' } }] };
    sessionStorage.setItem('gonglun:pending-send:u', JSON.stringify(previous));
    const different = vi.fn<(input: CommandEnvelope) => Promise<unknown>>(async () => ({}));
    await runCommandBatch(async () => add({ content: '旧格式待确认' }), different, undefined, { apiBase: 'https://other.invalid/api' });
    expect(different.mock.calls[0][0].requestId).not.toBe(previous.requestId);
    const recover = vi.fn(async () => ({})), committed = vi.fn();
    await runCommandBatch(async () => add({ content: '旧格式待确认' }), recover, committed, { apiBase: '/api' });
    expect(recover).toHaveBeenCalledExactlyOnceWith(previous);
    expect(committed).toHaveBeenCalledExactlyOnceWith(1);
    expect(sessionStorage.getItem('gonglun:pending-send:u')).toBeNull();
  });
});
