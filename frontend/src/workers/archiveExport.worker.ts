import { prepareArchiveExport, type ExportWorkerRequest, type ExportWorkerResponse } from '../utils/exportTask';
import { conversionFailure } from '@gonglun/core';

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<ExportWorkerRequest>) => void;
  postMessage: (response: ExportWorkerResponse) => void;
};
worker.onmessage = event => {
  void prepareArchiveExport(event.data, message => worker.postMessage({ status: 'progress', message }))
    .then(result => worker.postMessage({ status: 'ready', result }))
    .catch(error => {
      const failure=conversionFailure(error,'unchanged','本次文件处理已取消，原 JSON 文件和缓存均未修改。');
      worker.postMessage({ status: 'error', message: failure.message, failure: failure.report });
    });
};
