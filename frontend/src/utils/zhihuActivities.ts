/** Source observations only. Unknown Zhihu verbs/types stay literal strings. */
export type ActivityPerson = { id?: string | null; name?: string | null; url?: string | null; token?: string | null };
export interface ZhihuSourceEvent {
  id: string; sourceId: string | null; identity: 'source' | 'observation'; kind: 'collection-item' | 'activity';
  actor: ActivityPerson | null; verb: string | null; actionText: string | null; type: string | null;
  target: { type: string | null; id: string | null; url: string | null; author: ActivityPerson | null };
  folderId: string | null; createdAt: string | null; createdAtText: string | null;
  sourceUrl: string; capturedAt: string; versions?: unknown[];
}
export interface ZhihuSourceFolder {
  id: string; title: string | null; description: string | null; creator: ActivityPerson | null;
  createdAt: string | null; updatedAt: string | null; isPublic: boolean | null; itemCount: number | null;
  url: string; sourceUrl: string; capturedAt: string; versions?: unknown[];
}
export interface ZhihuActivitySource {
  version: 1; scope: 'collections' | 'activities'; events: ZhihuSourceEvent[]; folders: ZhihuSourceFolder[];
  coverage: { scope: string; status: string; pagesComplete: boolean; allHistoryComplete: boolean; reason: string;
    currentEventIds?: string[]; currentFolderIds?: string[]; [key: string]: unknown };
  unparsedRecords: unknown[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(label: string): never { throw new Error(`知乎来源记录${label}无效`); }
// eslint-disable-next-line no-control-regex -- Imported identifiers must reject ASCII control characters.
const id = (value: unknown, label: string) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/.test(value) ? value : invalid(`${label}编号`);
function optionalText(value: unknown, label: string) { if (value != null && typeof value !== 'string') invalid(label); }
function person(value: unknown) {
  if (value == null) return;
  if (!object(value)) invalid('行为人或作者');
  if (value.id != null) id(value.id, '行为人或作者');
  for (const field of ['name', 'url', 'token']) optionalText(value[field], '行为人或作者');
}
export function validateZhihuActivitySource(value: unknown): asserts value is ZhihuActivitySource {
  if (!object(value) || value.version !== 1 || !['collections', 'activities'].includes(value.scope as string)
    || !Array.isArray(value.events) || !Array.isArray(value.folders) || !Array.isArray(value.unparsedRecords)) invalid('范围或版本');
  if (value.events.length + value.folders.length > 100_000) invalid('数量');
  if (!object(value.coverage) || typeof value.coverage.scope !== 'string' || typeof value.coverage.status !== 'string'
    || typeof value.coverage.pagesComplete !== 'boolean' || typeof value.coverage.allHistoryComplete !== 'boolean' || typeof value.coverage.reason !== 'string') invalid('采集范围');
  for (const field of ['currentEventIds', 'currentFolderIds']) {
    const entries = value.coverage[field];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string' || !entry) || new Set(entries).size !== entries.length)) invalid('本轮来源编号');
  }
  const eventIds = new Set<string>(), folderIds = new Set<string>();
  for (const entry of value.events) {
    if (!object(entry)) invalid('事件');
    const key = id(entry.id, '事件'); if (eventIds.has(key)) invalid('重复事件'); eventIds.add(key);
    if (!['source', 'observation'].includes(entry.identity as string) || !['collection-item', 'activity'].includes(entry.kind as string)) invalid('事件身份');
    if (entry.sourceId != null) id(entry.sourceId, '原站事件');
    if (entry.identity === 'source' && entry.sourceId == null) invalid('原站事件编号');
    if (entry.folderId != null) id(entry.folderId, '收藏夹');
    person(entry.actor);
    for (const field of ['verb', 'actionText', 'type', 'createdAt', 'createdAtText']) optionalText(entry[field], field);
    if (typeof entry.sourceUrl !== 'string' || typeof entry.capturedAt !== 'string') invalid('事件来源');
    if (!object(entry.target)) invalid('事件目标');
    if (entry.target.id != null) id(entry.target.id, '目标');
    for (const field of ['type', 'url']) optionalText(entry.target[field], '目标');
    person(entry.target.author);
    if (entry.versions !== undefined && !Array.isArray(entry.versions)) invalid('事件观察历史');
  }
  for (const entry of value.folders) {
    if (!object(entry)) invalid('收藏夹');
    const key = id(entry.id, '收藏夹'); if (folderIds.has(key)) invalid('重复收藏夹'); folderIds.add(key);
    for (const field of ['title', 'description', 'createdAt', 'updatedAt']) optionalText(entry[field], '收藏夹');
    person(entry.creator);
    if (entry.isPublic != null && typeof entry.isPublic !== 'boolean') invalid('收藏夹公开状态');
    if (entry.itemCount != null && (!Number.isSafeInteger(entry.itemCount) || (entry.itemCount as number) < 0)) invalid('收藏夹数量');
    if (typeof entry.url !== 'string' || typeof entry.sourceUrl !== 'string' || typeof entry.capturedAt !== 'string') invalid('收藏夹来源');
    if (entry.versions !== undefined && !Array.isArray(entry.versions)) invalid('收藏夹观察历史');
  }
}

export function activityEvidenceText(event: ZhihuSourceEvent, target?: { title?: string | null; text: string; completeness?: unknown; author?: ActivityPerson | null }, returned: boolean | null = null) {
  const targetStatus = object(target?.completeness) ? target.completeness.body : 'unknown';
  const missing = !['answer', 'article', 'pin'].includes(event.target.type || '') ? '目标类型未适配，未补写正文。'
    : !target ? '目标正文未取得。' : targetStatus === 'complete' ? null : targetStatus === 'partial' ? '目标正文仅取得部分。' : '目标正文完整性未确认。';
  const lines = [event.kind === 'collection-item' ? '知乎收藏来源记录（非公论表态）' : '知乎动态来源记录（非公论表态）',
    `来源状态：${returned === null ? '本轮是否返回未记录' : returned ? '本轮返回' : '历史保留（本轮未返回，不代表取消）'}`,
    `行为人：${event.actor?.name || '未取得'}`,
    `原站行为文字：${event.actionText || '未提供'}`, `原始行为标识：${event.verb || '未提供'}`,
    `行为时间：${event.createdAtText || event.createdAt || '未取得（不以作品发布时间代替）'}`,
    `目标类型：${event.target.type || '未提供'}`, `目标编号：${event.target.id || '未取得'}`,
    `目标原作者：${target?.author?.name || event.target.author?.name || '未取得'}`,
    ...(target?.title ? [`目标标题：${target.title}`] : []),
    ...(event.folderId ? [`收藏夹编号：${event.folderId}`] : []),
    ...(event.target.url ? [`目标原站链接：${event.target.url}`] : []),
    `采集来源：${event.sourceUrl}`, ...(missing ? [missing] : []),
    ...(target ? ['目标原文已保存在本地，可沿引用阅读；目标作者与行为人分别记录。'] : []),
  ];
  return { content: lines.join('\n'), missing };
}
