import { indexNativeZhihuBlob } from '../utils/pagedZhihuArchive';

self.onmessage = async ({ data }: MessageEvent<Blob>) => {
  try { self.postMessage({ result: await indexNativeZhihuBlob(data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
