/**
 * 前端调试日志 — DEBUG=true 开启，调试完改 false
 * 前端 console + 后端文件双写
 */
const DEBUG = true;

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

export function debugLog(tag: string, msg: string) {
  if (!DEBUG) return;
  console.log(`[${tag}]`, msg);
  fetch(`${BASE_URL}/debug-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, msg }),
  }).catch(() => {});
}

export function debugWarn(tag: string, msg: string) {
  if (!DEBUG) return;
  console.warn(`[${tag}]`, msg);
  fetch(`${BASE_URL}/debug-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, msg }),
  }).catch(() => {});
}
