import { expect, it } from 'vitest';
import { prepareExportForViewing, validateExportForViewing } from '../utils/exportArchive';
import { getZhihuDisplayFields, prepareZhihuForViewing, sendZhihuLocalRelation } from '../utils/zhihuArchive';
import { serializeGonglunZhihuViewingData } from '../utils/zhihuGonglunExport';

// Structural fixture; source discussion text is deliberately empty.
const archive = () => ({ format: 'gonglun-zhihu-archive', version: 1,
  items: [{ id: '10', type: 'answer', text: '', question: { id: '20', title: '字段测试', text: null,
    completeness: { title: 'complete', body: 'unknown' } }, completeness: { body: 'complete' } }], comments: [] });

it('exports native Gonglun parts and relations with complete local source history in readable JSON', async () => {
  const original = prepareZhihuForViewing(archive());
  let data = sendZhihuLocalRelation(original, { relationType: 'CORRECT', targetMessageIds: ['zhihu:question:20'],
    correctionField: 'body', content: '本地字段验证' });
  data = sendZhihuLocalRelation(data, { relationType: 'CORRECT', targetMessageIds: ['zhihu:question:20'],
    correctionField: 'title', content: '本地标题验证' });
  const json = serializeGonglunZhihuViewingData(data), native = JSON.parse(json);
  expect(json).toContain('\n  "format":'); expect(json.endsWith('\n')).toBe(true);
  expect(native).toMatchObject({ format: 'gonglun-view-3', formatVersion: 5 });
  expect(native.messages.every((message: { revision: number; parts: unknown[] }) => Number.isSafeInteger(message.revision) && Array.isArray(message.parts))).toBe(true);
  expect(native.relations.filter((relation: { relationType: string }) => relation.relationType === 'CORRECT')).toHaveLength(2);
  expect(native.zhihu.archive).toEqual(original.zhihu.archive);
  expect(native.zhihu.archive.items[0].question).toMatchObject({ text: null, completeness: { body: 'unknown' } });
  const reopened = (await prepareExportForViewing(native)).data as typeof data;
  expect(reopened.zhihu.localOperations).toEqual(data.zhihu.localOperations);
  expect(getZhihuDisplayFields(reopened, 'zhihu:question:20')).toMatchObject({ body: '本地字段验证', title: '本地标题验证' });
  const { zhihu: _source, ...plainNative } = native;
  expect(() => validateExportForViewing(plainNative)).not.toThrow();
  expect(native).not.toHaveProperty('changes'); expect(native).not.toHaveProperty('journal');
});

it('keeps a withdrawn correction withdrawn after native export and reopen', async () => {
  const original = prepareZhihuForViewing(archive());
  const corrected = sendZhihuLocalRelation(original, { relationType: 'CORRECT', targetMessageIds: ['zhihu:question:20'], correctionField: 'body', content: '本地字段验证' });
  const id = corrected.zhihu.localOperations.messages.find(message => message.relationType === 'CORRECT')!.id;
  const withdrawn = sendZhihuLocalRelation(corrected, { relationType: 'DISAGREE', targetMessageIds: [id] });
  const reopened = (await prepareExportForViewing(JSON.parse(serializeGonglunZhihuViewingData(withdrawn)))).data as typeof original;
  expect(getZhihuDisplayFields(reopened, 'zhihu:question:20').body).toBe('');
  expect(reopened.zhihu.inactiveRelationIds).toContain(id);
  expect(reopened.zhihu.archive).toEqual(original.zhihu.archive);
});

it('reads compact native files from canonical parts without a Zhihu source envelope or persisted content aliases', async () => {
  const native = JSON.parse(serializeGonglunZhihuViewingData(prepareZhihuForViewing({ ...archive(),
    items: [{ id: '10', type: 'answer', text: '部件正文验证' }] })));
  delete native.zhihu;
  for (const row of [...native.messages, ...native.relations]) delete row.content;
  const original = structuredClone(native);
  const restored = (await prepareExportForViewing(native)).data;
  expect(restored.messages.find(message => message.id === 'zhihu:item:answer:10')?.content).toBe('部件正文验证');
  expect(restored).not.toHaveProperty('zhihu');
  expect(native).toEqual(original);
});
