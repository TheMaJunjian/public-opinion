import { prepareZhihuForViewing, type ZhihuViewingData } from './zhihuArchive';

/** Native Gonglun message document with the source and local edit history attached. */
export function serializeGonglunZhihuViewingData(input: ZhihuViewingData): string {
  const data = prepareZhihuForViewing(input);
  return `${JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2)}\n`;
}
