import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindRoles, type ExecutedStance, type Message, type MessageState } from '@gonglun/core';
import DiscussionView from './DiscussionView';
import { buildDiscussion } from './discussion';

const message = (id: string, text = id, stance?: { side: 'agree' | 'disagree'; target: string; partId?: string }): Message => ({ id, sequence: 1, revision: 1, authorId: 'alice', createdAt: '2026-10-14T01:00:00Z', updatedAt: '2026-10-14T01:00:00Z', regionId: 'main', ledgerId: 'main', programVersion: '2', ruleVersion: 1, spending: { protocol: 1, recommendation: 0, wager: 0 }, parts: [{ id: 'content', type: 'text', text }, ...(stance ? [{ id: 'stance', type: 'relation' as const, relation: stance.side, roles: bindRoles({ target: [{ messageId: stance.target, partId: stance.partId }] }) }] : [])] });
const state = (messageId: string, target: ExecutedStance['target'], side: 'pro' | 'con'): MessageState => ({ messageId, revision: 1, suppressed: false, supportCount: 0, oppositionCount: 0, recommendationTotal: 0, executedStance: { partId: 'stance', sourceRevision: 1, target, side } });
const lookup = (messages: Message[]) => new Map(messages.map(message => [message.id, message]));
let host: HTMLDivElement; let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const renderMessage = (message: Message, members: React.ReactNode) => <div data-message-id={message.id}>{message.parts[0].type === 'text' ? message.parts[0].text : message.id}{members}</div>;

describe('local nonlinear discussion', () => {
  it('places each agreement beside its own question and renders each source only once', async () => {
    const a = message('a', '夜间公交'), b = message('b', '图书馆');
    const aPro = message('a-pro', '支持公交', { side: 'agree', target: a.id });
    const bPro = message('b-pro', '支持图书馆', { side: 'agree', target: b.id });
    const messages = [aPro, bPro, a, b];
    const model = buildDiscussion(messages, lookup(messages), { 'a-pro': state(aPro.id, { messageId: a.id, revision: 1 }, 'pro'), 'b-pro': state(bPro.id, { messageId: b.id, revision: 1 }, 'pro') });
    await act(async () => root.render(<DiscussionView model={model} renderMessage={renderMessage} onFocus={() => {}}/>));
    expect(host.querySelector('[data-discussion-message="a"] [data-stance-side="pro"]')?.textContent).toContain('支持公交');
    expect(host.querySelector('[data-discussion-message="a"]')?.textContent).not.toContain('支持图书馆');
    expect(host.querySelector('[data-discussion-message="b"] [data-stance-side="pro"]')?.textContent).toContain('支持图书馆');
    expect(host.querySelectorAll('[data-message-id="a-pro"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-message-id="b-pro"]')).toHaveLength(1);
    expect(model.roots.map(message => message.id)).toEqual(['a', 'b']);
  });

  it('uses executed normalization for opposing opposition but keeps an objection to its reason on that reason', async () => {
    const a = message('a', '夜间公交');
    const objection = message('objection', '运营成本太高', { side: 'disagree', target: a.id });
    const reversal = message('reversal', '反对这个反对立场', { side: 'disagree', target: objection.id, partId: 'stance' });
    const reason = message('reason', '这个成本数字没有依据', { side: 'disagree', target: objection.id, partId: 'content' });
    const messages = [a, objection, reversal, reason];
    const states = { objection: state(objection.id, { messageId: a.id, revision: 1 }, 'con'), reversal: state(reversal.id, { messageId: a.id, revision: 1 }, 'pro'), reason: state(reason.id, { messageId: objection.id, partId: 'content', revision: 1 }, 'con') };
    const model = buildDiscussion(messages, lookup(messages), states);
    expect(model.sides.get(a.id)?.pro).toEqual([reversal]);
    expect(model.sides.get(a.id)?.con).toEqual([objection]);
    expect(model.sides.get(objection.id)?.con).toEqual([reason]);
    await act(async () => root.render(<DiscussionView model={model} renderMessage={renderMessage} onFocus={() => {}}/>));
    expect(host.querySelector('[data-discussion-message="reversal"]')?.textContent).toContain('对原目标：赞同');
    expect(host.querySelector('[data-discussion-message="reason"]')?.textContent).toContain('部件 content');
    const edited = { ...reversal, revision: 2, parts: [{ id: 'content', type: 'text' as const, text: '修订后的新说明' }] };
    const changed = buildDiscussion([a, objection, edited, reason], lookup([a, objection, edited, reason]), states);
    expect(changed.sides.get(a.id)?.pro[0].id).toBe(reversal.id);
  });

  it('keeps unloaded targets addressable, then groups the source after the target is loaded without changing the page', async () => {
    const source = message('source', '旧议题的新表态', { side: 'agree', target: 'old' });
    const page = [source]; const states = { source: state(source.id, { messageId: 'old', revision: 1, partId: 'content' }, 'pro') };
    const focus = vi.fn();
    const before = buildDiscussion(page, lookup(page), states);
    await act(async () => root.render(<DiscussionView model={before} renderMessage={renderMessage} onFocus={focus}/>));
    expect(host.textContent).toContain('尚未加载的消息 old');
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(focus).toHaveBeenCalledWith({ messageId: 'old', revision: 1, partId: 'content' });
    const old = message('old', '旧议题'); const after = buildDiscussion(page, lookup([source, old]), states);
    expect(after.roots).toEqual([old]); expect(after.sides.get(old.id)?.pro).toEqual([source]); expect(page).toEqual([source]);
  });

  it('keeps covered members hidden and restores their local relationships when the organization expands', () => {
    const summary = message('summary', '总结'), member = message('member', '过程'), pro = message('pro', '赞同过程', { side: 'agree', target: member.id });
    const all = lookup([summary, member, pro]); const states = { pro: state(pro.id, { messageId: member.id }, 'pro') };
    const covered = buildDiscussion([summary, pro], all, states, () => [], new Set([member.id]));
    expect(covered.messages.has(member.id)).toBe(false); expect(covered.roots).toEqual([summary, pro]);
    const expanded = buildDiscussion([summary, pro], all, states, message => message.id === summary.id ? [member] : []);
    expect(expanded.roots).toEqual([summary]); expect(expanded.members.get(summary.id)).toEqual([member]); expect(expanded.sides.get(member.id)?.pro).toEqual([pro]);
  });

  it('bounds deep relation rendering and lets a continuation become the focused center', async () => {
    const messages = Array.from({ length: 30 }, (_, index) => message(`chain-${index}`));
    const states = Object.fromEntries(messages.slice(1).map((message, index) => [message.id, state(message.id, { messageId: messages[index].id, partId: 'content' }, 'con')]));
    const model = buildDiscussion(messages, lookup(messages), states);
    const onFocus = vi.fn();
    await act(async () => root.render(<DiscussionView model={model} renderMessage={renderMessage} onFocus={onFocus}/>));
    const trace = host.querySelector<HTMLButtonElement>('[data-discussion-trace="chain-4"] button');
    expect(trace).not.toBeNull();
    await act(async () => trace!.click());
    expect(onFocus).toHaveBeenCalledWith({ messageId: 'chain-4' });
    const focused = buildDiscussion([messages[4], ...messages], lookup(messages), states, () => [], new Set(), 'chain-4');
    expect(focused.roots[0].id).toBe('chain-4');
    expect(focused.sides.get('chain-4')?.con[0].id).toBe('chain-5');
  });
});
