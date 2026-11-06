import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';
import type { NativeZhihuView } from '../utils/nativeZhihuView';
import { isNativeLocalMessage } from '../utils/nativeZhihuView';
import { nativeZhihuDocument, sendNativeZhihuRelation } from '../utils/nativeZhihuEditor';
import { indexNativeZhihuBlob, hydratePagedArchive, exportPagedArchive, pageNativeZhihuData, pagedArchiveSource } from '../utils/pagedZhihuArchive';
import { scanJsonArchive } from '../utils/streamJsonArchive';
import { createZhihuStructuralViewer } from '../utils/zhihuStructuralViewer';
import { sendPagedZhihuRelation } from '../utils/pagedZhihuEditor';
import { readViewerFile } from '../utils/readViewerFile';

let NodeBlob: typeof Blob;
beforeEach(async () => { ({ Blob: NodeBlob } = await vi.importActual<{ Blob: typeof Blob }>('node:buffer')); vi.stubGlobal('Blob', NodeBlob); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(): NativeZhihuView {
  const { zhihu: _index, ...source } = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: ['a', 'b'].map(id => ({ id, type: 'answer', text: `原文 ${id} 中文😀 "引号" \\ [括号] {正文}\n下一行`,
      question: { id: `q${id}`, title: `分类 ${id}`, text: '问题正文' } })),
    comments: ['a', 'b'].map(id => ({ id: `c${id}`, sourceId: `c${id}`, threadId: `answer:${id}`, text: `评论 ${id}`, rootCommentId: `c${id}`, parentCommentId: null })),
  });
  return { ...source, viewerUsername: '本地整理者', source: { provider: 'zhihu', version: 1, scope: 'own', ownerId: 'paged-fixture', ownerUrl: null } };
}

it('streams escaped strings and UTF-8 across chunk boundaries and preserves exact byte ranges', async () => {
  const source = fixture(), blob = new Blob([JSON.stringify(source, null, 2)]);
  const indexed = (await indexNativeZhihuBlob(blob, { chunkSize: 17 }))!;
  expect(() => structuredClone(indexed)).not.toThrow();
  expect(pagedArchiveSource(indexed.data)).toBeDefined();
  const restored = await hydratePagedArchive(indexed.data, indexed.data);
  expect(restored.messages).toEqual(source.messages);
  expect(restored.relations).toEqual(source.relations);
  const exported = JSON.parse(await (await exportPagedArchive(indexed.data)).text());
  expect(exported.messages).toEqual(source.messages);
  expect(exported.relations).toEqual(source.relations);
});

it.each(['{"messages":[{},]}', '{"messages":[]', '{"messages":[],"messages":[]}', '{"value":"unterminated}', '{"value":1} garbage'])(
  'rejects incomplete or ambiguous JSON without publishing an index: %s', async text => {
    await expect(scanJsonArchive(new Blob([text]), () => {}, { chunkSize: 3 })).rejects.toThrow();
  });

it('reads only requested bodies, keeps counts complete and releases bodies between windows', async () => {
  const source = fixture();
  const hidden = source.messages.find(row => row.id === 'zhihu:item:answer:b')!;
  hidden.content = '隐藏原文'.repeat(100_000); hidden.parts = [{ id: 'body', type: 'text', text: hidden.content }];
  const blob = new Blob([JSON.stringify(source)]), indexed = (await indexNativeZhihuBlob(blob))!.data;
  expect(JSON.stringify(indexed).length).toBeLessThan(blob.size / 20);
  const readSizes: number[] = [], original = NodeBlob.prototype.arrayBuffer;
  vi.spyOn(NodeBlob.prototype, 'arrayBuffer').mockImplementation(function (this: Blob) { readSizes.push(this.size); return original.call(this); });
  const index = createZhihuStructuralViewer(indexed, '本地整理者');
  const root = await hydratePagedArchive(indexed, index.window({ classificationId: null }).data);
  expect(root.messages.map(row => row.id)).toEqual(['zhihu:type:answer']);
  expect(readSizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(blob.size / 20);
  expect(index.memberCounts('zhihu:type:answer').total).toBeGreaterThan(4);
  const a = await hydratePagedArchive(indexed, index.window({ classificationId: 'zhihu:question:qa' }).data);
  expect(a.messages.find(row => row.id === 'zhihu:item:answer:a')?.content).toContain('中文😀');
  expect(a.messages.some(row => row.id === hidden.id)).toBe(false);
  const b = await hydratePagedArchive(indexed, index.window({ classificationId: 'zhihu:question:qb' }).data);
  expect(b.messages.find(row => row.id === hidden.id)?.content).toBe(hidden.content);
  expect(indexed.messages.find(row => row.id === hidden.id)?.content).toBe('x');
});

it('uses real original parts for corrections and keeps unrelated originals paged after a move', async () => {
  const source = fixture(), data = await pageNativeZhihuData(source);
  const input = { relationType: 'CORRECT' as const, targetMessageIds: ['zhihu:item:answer:a'], content: '修订正文', correctionField: 'body' as const };
  const expected = nativeZhihuDocument(sendNativeZhihuRelation(source, input));
  const edited = nativeZhihuDocument(await sendPagedZhihuRelation(data, input));
  const correction = edited.messages.find(row => row.relationType === 'CORRECT')!;
  expect(correction.relationPayload).toMatchObject({ baseFingerprint: (expected.messages.find(row => row.relationType === 'CORRECT')!.relationPayload as { baseFingerprint: string }).baseFingerprint });
  const moved = nativeZhihuDocument(await sendPagedZhihuRelation(edited, { relationType: 'CLASSIFY',
    sourceMessageIds: ['zhihu:question:qb'], targetMessageIds: ['zhihu:comment:answer%3Aa:ca'] }));
  expect(createZhihuStructuralViewer(moved, '本地整理者').containingClassification('zhihu:comment:answer%3Aa:ca')).toBe('zhihu:question:qb');
  const exported = JSON.parse(await (await exportPagedArchive(moved)).text());
  expect(exported.messages.filter((row: object) => !isNativeLocalMessage(row))).toEqual(source.messages);
  expect(exported.messages.filter(isNativeLocalMessage)).toHaveLength(moved.messages.filter(isNativeLocalMessage).length);
  expect(moved.messages.find(row => row.id === 'zhihu:item:answer:b')?.content).toBe('x');
});

it('imports a large native file without calling whole-file text or arrayBuffer', async () => {
  const source = fixture();
  source.messages[1].parts!.push({ id: 'source-fields', type: 'data', value: '原文'.repeat(1_500_000) });
  const blob = new Blob([JSON.stringify(source)]);
  expect(blob.size).toBeGreaterThan(8 * 1024 * 1024);
  const whole = vi.spyOn(blob, 'arrayBuffer'), text = vi.spyOn(blob, 'text');
  const prepared = await readViewerFile(blob);
  expect(pagedArchiveSource(prepared.data)).toBeDefined();
  expect(whole).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
  expect(JSON.stringify(prepared.data).length).toBeLessThan(30_000);
});

it('cancels a pending body read and never falls back to the complete source', async () => {
  const data = await pageNativeZhihuData(fixture()), controller = new AbortController();
  controller.abort();
  await expect(hydratePagedArchive(data, data, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

it('exports a paged source through the normal export entry without posting placeholders to a worker', async () => {
  const source = fixture(), data = await pageNativeZhihuData(source);
  const worker = vi.fn(); vi.stubGlobal('Worker', worker);
  const { startArchiveExport } = await import('../utils/exportWorker');
  const { blob } = await startArchiveExport({ kind: 'full', scopeMessageId: 'root', source: data,
    view: { username: '本地整理者', mode: 'graph', classificationId: null,
      messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] } }, vi.fn()).result;
  expect(worker).not.toHaveBeenCalled();
  const exported = JSON.parse(await blob.text());
  expect(exported.messages).toEqual(source.messages);
  expect(exported.relations).toEqual(source.relations);
});
