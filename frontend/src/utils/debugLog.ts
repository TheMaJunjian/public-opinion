/**
 * 前端调试日志 — console 输出 + 通过后端写入 README/logs/
 * 生产环境可设置 VITE_DEBUG=false 禁用
 */
const DEBUG = import.meta.env.VITE_DEBUG !== 'false';
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

function sendLog(tag: string, msg: string, debug: boolean) {
  if (!DEBUG) return;
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
