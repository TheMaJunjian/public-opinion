import { expect, it } from 'vitest';
import { bindRoles, type Message, type Part } from '@gonglun/core';
import { feedEntry } from './feed-index.js';

const message = (parts: Part[]): Message => ({ id: 'message', revision: 1, authorId: 'alice', createdAt: '', updatedAt: '',
  regionId: 'region', ledgerId: 'ledger', programVersion: '2', ruleVersion: 1, sequence: 1,
  spending: { protocol: 1, recommendation: 1, wager: 0 }, parts });
const body = (text: string): Part => ({ id: 'body', type: 'text', text });
const relation = (name: string): Part => ({ id: 'relation', type: 'relation', relation: name,
  roles: bindRoles({ [name === 'member-of' ? 'member' : 'target']: [{ messageId: 'cmt00obvx00vpkysjfzhbrkmz' }] }) });

it.each(['reply', 'reference', 'annotation', 'merge', 'arrange', 'member-of', 'agree', 'follow', 'correct'])
  ('excludes %s records even if they contain authored text or a saved title', name => {
    expect(feedEntry(message([body('关系记录附带的正文'), relation(name), { id: 'data', type: 'data', value: { title: '有标题也不是内容型消息' } }]))).toBeNull();
  });

it('excludes the legacy reply description with an abbreviated target', () => {
  expect(feedEntry(message([body('建立关系：REPLY；目标：fzhbrkmz'), relation('reply')]))).toBeNull();
});

it.each(['classify', 'summary'])('uses the %s card text for legacy, current and data-only messages', name => {
  const data: Part = { id: 'data', type: 'data', value: { title: '分类卡上可读的正文', content: '补充说明' } };
  for (const parts of [
    [body(`建立关系：${name.toUpperCase()}`), relation(name), data],
    [body('补充说明'), relation(name), data],
    [relation(name), data],
  ]) expect(feedEntry(message(parts))).toMatchObject({ excerpt: '分类卡上可读的正文' });
  expect(feedEntry(message([body('原生内容正文'), relation(name)]))).toMatchObject({ excerpt: '原生内容正文' });
  expect(feedEntry(message([body(`建立关系：${name.toUpperCase()}`), relation(name)]))).toBeNull();
  expect(feedEntry(message([body(`建立关系：${name.toUpperCase()}`), relation(name),
    { id: 'data', type: 'data', value: { title: ' ', content: '历史内容正文' } }]))).toMatchObject({ excerpt: '历史内容正文' });
});

it('keeps text, web and code content with placement and automatic self-stances', () => {
  const placement: Part = { id: 'membership', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: 'category' }] }) };
  const stance: Part = { id: 'self-stance', type: 'relation', relation: 'agree', roles: bindRoles({ target: [{ messageId: 'message' }] }) };
  for (const part of [body('普通正文'), { id: 'web', type: 'web', url: 'https://example.com', excerpt: '网页正文' },
    { id: 'code', type: 'code', language: 'text', source: '代码正文' }] as Part[]) {
    expect(feedEntry(message([part, placement, stance]))?.excerpt).toContain('正文');
  }
});
