import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES, targets, type Message, type Reference, type SendInput, type Session } from '@gonglun/core';
import Composer from './Composer';

const session: Session = { user: { id: 'alice', name: 'Alice', founder: true }, account: { available: 100, locked: 0, earned: 100, spent: 0 }, rules: DEFAULT_RULES, csrf: 'token' };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function inputText(value: string) {
  const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
describe('message composition', () => {
  it('sends plain speech with no automatic stance, recommendation or wager', async () => {
    const send = vi.fn<(input: SendInput) => Promise<boolean>>().mockResolvedValue(true);
    await act(async () => root.render(<Composer session={session} rules={DEFAULT_RULES} intent={null} messages={{}} busy={false} retryError={null} sentSerial={0} selectedReference={null} onSend={send} onRetry={() => {}} onDiscard={() => {}} onLogin={() => {}}/>));
    await inputText('值得讨论的问题'); await submit();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ recommendation: 0, wager: 0, parts: [{ type: 'text', text: '值得讨论的问题' }] });
    expect(send.mock.calls[0][0].parts).toHaveLength(1);
  });
  it('keeps the chosen stable member and historical revision as the actual stance target', async () => {
    const ref: Reference = { messageId: 'organization', revision: 2, partId: 'group', memberId: 'stable-member', path: ['reference'] };
    const send = vi.fn<(input: SendInput) => Promise<boolean>>().mockResolvedValue(true);
    await act(async () => root.render(<Composer session={session} rules={DEFAULT_RULES} intent={{ serial: 1, relation: 'disagree', targets: [ref] }} messages={{}} busy={false} retryError={null} sentSerial={0} selectedReference={null} onSend={send} onRetry={() => {}} onDiscard={() => {}} onLogin={() => {}}/>));
    await inputText('我反对这条引用的选取'); await submit();
    const relation = send.mock.calls[0][0].parts.find(part => part.type === 'relation' && part.relation === 'disagree');
    expect(relation?.type).toBe('relation');
    if (relation?.type === 'relation') expect(targets(relation, 'target')).toEqual([ref]);
  });
  it('preserves a text-component amendment target instead of silently replacing the whole message', async () => {
    const original: Message = { id: 'original', sequence: 1, revision: 3, authorId: 'alice', createdAt: '2026-10-14T01:00:00Z', updatedAt: '2026-10-14T01:00:00Z', regionId: 'main', ledgerId: 'main', programVersion: '2', ruleVersion: 1, spending: { protocol: 1, recommendation: 0, wager: 0 }, parts: [{ id: 'body', type: 'text', text: '旧内容' }, { id: 'reason', type: 'text', text: '保留的理由' }] };
    const ref: Reference = { messageId: original.id, partId: 'body' };
    const send = vi.fn<(input: SendInput) => Promise<boolean>>().mockResolvedValue(true);
    await act(async () => root.render(<Composer session={session} rules={DEFAULT_RULES} intent={{ serial: 1, relation: 'amend', targets: [ref] }} messages={{ original }} busy={false} retryError={null} sentSerial={0} selectedReference={ref} onSend={send} onRetry={() => {}} onDiscard={() => {}} onLogin={() => {}}/>));
    await inputText('修订内容'); await submit();
    const parts = send.mock.calls[0][0].parts; const relation = parts.find(part => part.type === 'relation');
    if (relation?.type === 'relation') expect(targets(relation, 'target')).toEqual([ref]);
    expect(parts.find(part => part.type === 'data')).toMatchObject({ value: { expectedRevision: 3, value: { id: 'body', type: 'text', text: '修订内容' } } });
    expect(parts.find(part => part.type === 'data')).not.toHaveProperty('value.parts');
  });
});
