import type { ExportData } from '../api/client';

export function createLocalMessageFile(): ExportData {
  return { format: 'gonglun-view-3', formatVersion: 5, exportedAt: new Date().toISOString(),
    scope: { messageId: null, title: '本地讨论' }, messages: [], relations: [], viewerUsername: '记录者' };
}
