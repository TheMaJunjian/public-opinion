import { expect, it, vi } from 'vitest';
import { structureSnapshot, type WorkbenchSnapshot } from '@gonglun/core';
import { hydrateOnlineStructure, onlineStructuralSource } from '../utils/onlineStructuralSource';
import {archiveToWorkbenchSnapshot,projectWorkbenchSnapshot} from '../utils/workbenchProjection';
import type { SnapshotQuery } from '../data/workbench';

const user = { id: 'u', username: '甲', createdAt: '' };
const text = (id: string, content = id) => ({ id, revision: 1, kind: 'TEXT', contentType: 'TEXT' as const,
  content, createdAt: '', createdBy: user });
function setup() {
  const quote = { ...text('quote', '引用旧正文'), kind: 'RELATION', relationType: 'REFERENCE', sourceMessageId: null,
    targetRefs: [{ kind: 'text-fragment' as const, messageId: 'm', text: '旧正文', hash: 'fragment' }] };
  let full: WorkbenchSnapshot = { sequence: 10, regionId: 'region', scope: { messageId: null, title: '讨论' },
    messages: [text('m', '旧正文'), quote, text('unrelated')], relations: [quote], users: [user], stakes: {}, tagCounts: {}, attentionUsers: {} };
  const load = vi.fn(async (query: SnapshotQuery) => {
    const ids = new Set(query.ids);
    return { ...full, messages: full.messages.filter(row => ids.has(row.id)), relations: full.relations.filter(row => ids.has(row.id)) };
  });
  return { load, get full() { return full; }, set full(value) { full = value; },
    source: () => onlineStructuralSource(structureSnapshot(full), load, undefined, { identity: 'u' }) };
}

it('reuses unaffected bodies after a complete replay but refreshes derived quotes without a body revision change', async () => {
  const data = setup(), previous = data.source();
  await hydrateOnlineStructure(previous, previous); data.load.mockClear();
  const quote = { ...data.full.relations[0], content: '引用新正文', targetRefs: [{ kind: 'text-fragment' as const, messageId: 'm', text: '新正文', hash: 'fragment' }] };
  data.full = { ...data.full, sequence: 11, messages: data.full.messages.map(row => row.id === 'm' ? { ...row, revision: 2, content: '新正文' }
    : row.id === 'quote' ? { ...row, ...quote } : row), relations: [quote] };
  const source = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: 'u', previous, update: { previousSequence: 10, changedIds: ['m'] } });
  const result = await hydrateOnlineStructure(source, source);
  expect(data.load.mock.calls.flatMap(([query]) => query.ids)).toEqual(['m', 'quote']);
  expect(result.messages.map(row => row.content)).toEqual(['新正文', '引用新正文', 'unrelated']);
  expect(result.relations[0]).toMatchObject({ targetRefs: [{ text: '新正文' }] });
});

it('refreshes detailed stakes even when the revision and structural aggregate are unchanged', async () => {
  const data = setup();
  const stake = { id: 'bet', side: 'PRO' as const, amount: 1, createdAt: '', user };
  data.full.stakes.m = { messageId: 'm', counts: { pro: 1, con: 0 }, pool: { lockedPro: 1, lockedCon: 0 }, stakes: [stake] };
  const previous = data.source(); await hydrateOnlineStructure(previous, previous); data.load.mockClear();
  data.full = { ...data.full, sequence: 11, stakes: { m: { ...data.full.stakes.m, stakes: [{ ...stake, id: 'replacement-bet' }] } } };
  const source = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: 'u', previous, update: { previousSequence: 10, changedIds: ['m'] } });
  const result = await hydrateOnlineStructure(source, source);
  expect(data.load.mock.calls.flatMap(([query]) => query.ids)).toEqual(['m', 'quote']);
  expect(result.stakes?.m.stakes[0].id).toBe('replacement-bet');
});

it('refreshes targets of a new stance while preserving unrelated cached bodies', async () => {
  const data = setup(), previous = data.source(); await hydrateOnlineStructure(previous, previous); data.load.mockClear();
  const stance = { ...text('stance'), relationType: 'AGREE', sourceMessageId: null,
    targetRefs: [{ kind: 'message' as const, messageId: 'm' }] };
  data.full = { ...data.full, sequence: 11, messages: [...data.full.messages, stance], relations: [...data.full.relations, stance] };
  const source = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: 'u', previous, update: { previousSequence: 10, changedIds: ['stance'] } });
  await hydrateOnlineStructure(source, source);
  expect(data.load.mock.calls.flatMap(([query]) => query.ids)).toEqual(['m', 'quote', 'stance']);
});

it('retains unaffected bodies through deletions and sequence-only updates', async () => {
  const data = setup(), previous = data.source(); await hydrateOnlineStructure(previous, previous); data.load.mockClear();
  data.full = { ...data.full, sequence: 11, messages: data.full.messages.filter(row => row.id !== 'quote'), relations: [] };
  const source = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: 'u', previous, update: { previousSequence: 10, changedIds: ['quote'] } });
  await hydrateOnlineStructure(source, source);
  expect(data.load.mock.calls.flatMap(([query]) => query.ids)).toEqual(['m']);
  data.load.mockClear(); data.full = { ...data.full, sequence: 12 };
  const latest = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: 'u', previous: source, update: { previousSequence: 11, changedIds: [] } });
  await hydrateOnlineStructure(latest, latest); expect(data.load).not.toHaveBeenCalled();
});

it('detects changed visibility and user details independently of the change-ID list', async () => {
  const data = setup(), previous = data.source(); await hydrateOnlineStructure(previous, previous); data.load.mockClear();
  data.full = { ...data.full, sequence: 11, messages: data.full.messages.map(row => row.id === 'm' ? { ...row, restricted: true, content: '受限' } : row) };
  const source = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: 'u', previous, update: { previousSequence: 10, changedIds: [] } });
  const result = await hydrateOnlineStructure(source, source);
  expect(result.messages.find(row => row.id === 'm')).toMatchObject({ content: '受限', restricted: true });
  expect(data.load.mock.calls.flatMap(([query]) => query.ids)).toEqual(['m', 'quote', 'unrelated']);
  data.load.mockClear();
  const renamed = { ...user, username: '新名字' };
  data.full = { ...data.full, sequence: 12, users: [renamed], messages: data.full.messages.map(row => ({ ...row, createdBy: renamed })),
    relations: data.full.relations.map(row => ({ ...row, createdBy: renamed })) };
  const latest = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: 'u', previous: source, update: { previousSequence: 11, changedIds: [] } });
  expect((await hydrateOnlineStructure(latest, latest)).messages.every(row => row.author === '新名字')).toBe(true);
});

it('reloads a restricted body when the cached copy omits the viewer’s stance', async () => {
  const data = setup();
  const old = { ...data.full, messages: [{ ...text('stance',''), restricted:true }], relations:[] };
  data.full = { ...old, messages:[{ ...old.messages[0], restrictedStance:'disagree' }] };
  const source = onlineStructuralSource(structureSnapshot(data.full), data.load, old);
  const result = await hydrateOnlineStructure(source, source);
  expect(data.load.mock.calls.flatMap(([query]) => query.ids)).toEqual(['stance']);
  expect(result.messages[0]).toMatchObject({ restricted:true, restrictedStance:'disagree', content:'' });
});

it('refreshes a cached cover when its blocking review changes without a body revision', async () => {
  const data=setup(),cover={...text('reply',''),restricted:true};
  const previous={...data.full,messages:[{...cover,restrictedReviewTargets:[{messageId:'source',revision:1}]}],relations:[]};
  const targets=[{messageId:'source',revision:2},{messageId:'another',revision:5}];
  data.full={...previous,messages:[{...cover,restrictedReviewTargets:targets}]};
  const source=onlineStructuralSource(structureSnapshot(data.full),data.load,previous);
  const refreshed=await hydrateOnlineStructure(source,source);
  expect(data.load.mock.calls.flatMap(([query])=>query.ids)).toEqual([cover.id]);
  const model=projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(refreshed));
  expect(model.messages[0]).toMatchObject({id:cover.id,restricted:true,content:'',restrictedReviewTargets:targets});
});

it('refreshes the public review totals on a covered card when another vote changes the same case',async()=>{
  const data=setup(),target={messageId:'source',revision:1};
  const review={...target,caseId:'case',status:'rejected' as const,fee:1,deposit:10,pass:10,reject:20,reviewerCount:1,releaseAt:null,finalized:true};
  const cover={...text('reply',''),restricted:true,restrictedReviewTargets:[target],restrictedReviewSummaries:[review]};
  const previous={...data.full,messages:[cover],relations:[]};
  data.full={...previous,messages:[{...cover,restrictedReviewSummaries:[{...review,reject:23}]}]};
  const source=onlineStructuralSource(structureSnapshot(data.full),data.load,previous);
  const refreshed=await hydrateOnlineStructure(source,source);
  const model=projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(refreshed));
  expect(model.messages[0].restrictedReviewSummaries?.[0]).toMatchObject({...target,pass:10,reject:23});
});

it('reuses the fixed system author and partial user views when catalog user details are unchanged', async () => {
  const data = setup();
  const system = { id: 'system', username: '公论规则', name: '公论规则', founder: false, createdAt: '' };
  data.full = { ...data.full, messages: [...data.full.messages, { ...text('system-record'), createdBy: system }],
    users: [{ ...user, usageContribution: 12 }] };
  const previous = data.source(); await hydrateOnlineStructure(previous, previous); data.load.mockClear();
  data.full = { ...data.full, sequence: 11 };
  const source = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: 'u', previous, update: { previousSequence: 10, changedIds: [] } });
  await hydrateOnlineStructure(source, source);
  expect(data.load).not.toHaveBeenCalled();
  const updatedUser = { ...user, usageContribution: 13 };
  const nextIndex = { ...structureSnapshot(data.full), sequence: 12, users: [updatedUser] };
  data.full = { ...data.full, sequence: 12, users: [updatedUser],
    messages: data.full.messages.map(row => row.createdBy.id === user.id ? { ...row, createdBy: updatedUser } : row),
    relations: data.full.relations.map(row => ({ ...row, createdBy: updatedUser })) };
  const next = onlineStructuralSource(nextIndex, data.load, undefined,
    { identity: 'u', previous: source, update: { previousSequence: 11, changedIds: [] } });
  const result = await hydrateOnlineStructure(next, next);
  expect(data.load.mock.calls.flatMap(([query]) => query.ids)).toEqual(['m', 'quote', 'unrelated']);
  expect(result.messages.find(row => row.id === 'm')).toMatchObject({ createdBy: updatedUser });
});

it.each(['account', 'region', 'scope', 'gap', 'reset', 'older'])('does not inherit bodies across a %s boundary', async boundary => {
  const data = setup(), previous = data.source(); await hydrateOnlineStructure(previous, previous); data.load.mockClear();
  data.full = { ...data.full, sequence: boundary === 'older' ? 9 : 11,
    ...(boundary === 'region' ? { regionId: 'other' } : {}),
    ...(boundary === 'scope' ? { scope: { messageId: 'other', title: '另一个范围' } } : {}) };
  const source = onlineStructuralSource(structureSnapshot(data.full), data.load, undefined,
    { identity: boundary === 'account' ? 'other' : 'u', previous,
      ...(boundary !== 'reset' ? { update: { previousSequence: boundary === 'gap' ? 9 : 10, changedIds: [] } } : {}) });
  await hydrateOnlineStructure(source, source);
  expect(data.load.mock.calls.flatMap(([query]) => query.ids)).toEqual(['m', 'quote', 'unrelated']);
});
