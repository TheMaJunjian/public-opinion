import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelCommandBatch, queueCommand, runCommandBatch, type CommandEnvelope } from '../api/commandBatch';

beforeEach(() => { sessionStorage.clear(); localStorage.setItem('user', JSON.stringify({ id: 'u', username: '用户' })); });
const add = (body: object) => queueCommand('/messages', { method: 'POST', body: JSON.stringify(body) });

describe('workbench sends', () => {
  it('preserves references between new messages and submits the entire operation once', async () => {
    const commit = vi.fn(async (_input: CommandEnvelope) => ({}));
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
    commit.mockRejectedValueOnce(new Error('服务器拒绝'));
    await expect(runCommandBatch(async () => { add({ content: '正文' }); }, commit, committed)).rejects.toThrow('服务器拒绝');
    expect(committed).not.toHaveBeenCalled();
    commit.mockResolvedValueOnce({});
    await runCommandBatch(async () => { add({ content: '正文' }); }, commit, committed);
    expect(committed).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('reuses both message IDs and request identity after a lost response', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new TypeError('网络中断')).mockResolvedValueOnce({});
    const send = () => runCommandBatch(async () => { add({ content: '同一笔发送' }); }, commit);
    await expect(send()).rejects.toThrow('网络中断');
    await send();
    expect(commit.mock.calls[0][0]).toEqual(commit.mock.calls[1][0]);
  });
});
