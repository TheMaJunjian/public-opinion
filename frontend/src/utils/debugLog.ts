/**
 * 前端日志 — 通过后端接口写入日志文件
 *
 * debugLog() → 日常运行日志 → README/logs/app-YYYY-MM-DD.log
 * traceLog() → 排查问题日志 → README/logs/debug-YYYY-MM-DD.log（需 DEBUG_LOG=true）
 */
const DEBUG = true;

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

function sendLog(tag: string, msg: string, debug = false) {
  if (!DEBUG) return;
  console.log(`[${tag}]`, msg);
  fetch(`${BASE_URL}/debug-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, msg, debug }),
  }).catch(() => {});
}

/** 日常运行日志（始终输出） */
export function debugLog(tag: string, msg: string) {
  sendLog(tag, msg, false);
}

/** 排查问题日志（仅 DEBUG_LOG=true 时写入文件） */
export function traceLog(tag: string, msg: string) {
  sendLog(tag, msg, true);
}

export function debugWarn(tag: string, msg: string) {
  sendLog(tag, msg, false);
}
