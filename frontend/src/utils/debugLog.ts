/**
 * 本地诊断与最近 100 条操作记录，不为每次界面操作发送网络请求。
 */
const DEBUG = import.meta.env.DEV && import.meta.env.VITE_DEBUG !== 'false';
export interface OperationLogEntry {
  time: string;
  action: string;
  details: string;
}

const operationEntries: OperationLogEntry[] = [];
const operationListeners = new Set<(entries: OperationLogEntry[]) => void>();

function sendLog(tag: string, msg: string) {
  if (!DEBUG) return;
  console.log(`[${tag}]`, msg);
}

/** 开发环境控制台诊断。 */
export function debugLog(tag: string, msg: string) {
  sendLog(tag, msg);
}

/** 操作面板保留最近记录，不受调试开关影响。 */
export function operationLog(action: string, details: string) {
  const entry = { time: new Date().toLocaleTimeString('zh-CN'), action, details };
  operationEntries.push(entry);
  if (operationEntries.length > 100) operationEntries.shift();
  operationListeners.forEach(listener => listener([...operationEntries]));
  sendLog('操作', `${action} ${details}`);
}

export function getOperationLogs() {
  return [...operationEntries];
}

export function subscribeOperationLogs(listener: (entries: OperationLogEntry[]) => void) {
  operationListeners.add(listener);
  listener([...operationEntries]);
  return () => { operationListeners.delete(listener); };
}

/** 开发环境跟踪。 */
export function traceLog(tag: string, msg: string) {
  sendLog(tag, msg);
}

export function debugWarn(tag: string, msg: string) {
  console.warn(`[${tag}]`, msg);
}
