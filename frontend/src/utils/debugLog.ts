/**
 * 前端调试日志 — console 输出 + 通过后端写入 README/logs/
 * 生产环境可设置 VITE_DEBUG=false 禁用
 */
const DEBUG = import.meta.env.VITE_DEBUG !== 'false';
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
export interface OperationLogEntry {
  time: string;
  action: string;
  details: string;
}

const operationEntries: OperationLogEntry[] = [];
const operationListeners = new Set<(entries: OperationLogEntry[]) => void>();

function sendLog(tag: string, msg: string, debug: boolean, force = false) {
  if (!DEBUG && !force) return;
  console.log(`[${tag}]`, msg);
  fetch(`${BASE_URL}/debug-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, msg, debug }),
  }).catch(() => {});
}

/** 写入 app-YYYY-MM-DD.log */
export function debugLog(tag: string, msg: string) {
  sendLog(tag, msg, false);
}

/** 写入 app-YYYY-MM-DD.log，不受调试开关影响 */
export function operationLog(action: string, details: string) {
  const entry = { time: new Date().toLocaleTimeString('zh-CN'), action, details };
  operationEntries.push(entry);
  if (operationEntries.length > 100) operationEntries.shift();
  operationListeners.forEach(listener => listener([...operationEntries]));
  sendLog('操作', `${action} ${details}`, false, true);
}

export function getOperationLogs() {
  return [...operationEntries];
}

export function subscribeOperationLogs(listener: (entries: OperationLogEntry[]) => void) {
  operationListeners.add(listener);
  listener([...operationEntries]);
  return () => { operationListeners.delete(listener); };
}

/** 写入 debug-YYYY-MM-DD.log */
export function traceLog(tag: string, msg: string) {
  sendLog(tag, msg, true);
}

export function debugWarn(tag: string, msg: string) {
  console.warn(`[${tag}]`, msg);
  fetch(`${BASE_URL}/debug-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, msg, debug: true }),
  }).catch(() => {});
}
