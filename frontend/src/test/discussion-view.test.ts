import { expect, it } from 'vitest';
import type { ExportData } from '../api/client';
import { isDiscussionView } from '../utils/discussionView';
import { validateExportForViewing } from '../utils/exportArchive';
import { prepareZhihuForViewing, serializeZhihuViewingData } from '../utils/zhihuArchive';
import { serializeGonglunZhihuViewingData } from '../utils/zhihuGonglunExport';

const settings: NonNullable<ExportData['view']> = { username: null, mode: 'graph',
  messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [], classificationId: null,
  discussion: { mode: 'discussion', collapsed: [JSON.stringify(['zhihu:item:answer:10', 'reply']), JSON.stringify(['zhihu:comment:1', 'agree'])] } };
const source = () => ({ format: 'gonglun-zhihu-archive', version: 1,
  items: [{ id: '10', type: 'answer', text: '' }], comments: [] });

it('round trips discussion folds in native and reviewed documents without altering source evidence or relations', () => {
  const data = prepareZhihuForViewing(source()); data.view = settings;
  for (const json of [serializeGonglunZhihuViewingData(data), serializeZhihuViewingData(data)]) {
    const reopened = prepareZhihuForViewing(JSON.parse(json));
    expect(reopened.view).toEqual(settings);
    expect(reopened.zhihu.archive).toEqual(data.zhihu.archive);
    expect(reopened.zhihu.localOperations).toEqual(data.zhihu.localOperations);
    expect(reopened.relations).toEqual(data.relations);
  }
  const native = { format: 'gonglun-view-3', formatVersion: 5, exportedAt: '', scope: { messageId: null, title: '' }, messages: [], relations: [], view: settings };
  expect(validateExportForViewing(native).data.view).toEqual(settings);
  expect(validateExportForViewing({ ...native, view: { ...settings, discussion: undefined } }).data.view?.discussion).toBeUndefined();
});

it.each([null, {}, { mode: 'tree', collapsed: [] }, { mode: 'discussion', collapsed: ['1:reply'] },
  { mode: 'discussion', collapsed: ['["1","support"]'] }, { mode: 'graph', collapsed: ['["","reply"]'] },
  { mode: 'graph', collapsed: ['["1", "reply"]'] }, { mode: 'graph', collapsed: [null] }])('rejects malformed fold settings %# in both file formats', discussion => {
  expect(isDiscussionView(discussion)).toBe(false);
  const data = prepareZhihuForViewing(source());
  const invalid = { ...settings, discussion };
  expect(() => prepareZhihuForViewing({ ...data, view: invalid })).toThrow('阅览设置');
  expect(() => validateExportForViewing({ formatVersion: 5, exportedAt: '', scope: { title: '' }, messages: [], relations: [], view: invalid })).toThrow('阅览设置');
});
