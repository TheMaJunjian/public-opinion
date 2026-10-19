import { prepareArchiveExport, type ExportWorkerRequest, type ExportWorkerResponse } from '../utils/exportTask';

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<ExportWorkerRequest>) => void;
  postMessage: (response: ExportWorkerResponse) => void;
};
worker.onmessage = event => {
  void prepareArchiveExport(event.data, message => worker.postMessage({ status: 'progress', message }))
    .then(result => worker.postMessage({ status: 'ready', result }))
    .catch(error => worker.postMessage({ status: 'error', message: error instanceof Error ? error.message : String(error) }));
};
