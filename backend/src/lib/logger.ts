/**
 * logger.ts — Unified logging for backend.
 *
 * Two log files:
 *   README/logs/app-YYYY-MM-DD.log   — 日常运行日志（结算、API、关键状态）
 *   README/logs/debug-YYYY-MM-DD.log — 排查问题日志（详细调试信息）
 *
 * Usage:
 *   import { log, debugLog } from '../lib/logger';
 *   log('结算', `round=${roundId} result=${result}`);
 *   debugLog('ensureVotingRound', `msg=xxx type=TRUTH`);
 */
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve(__dirname, '..', '..', '..', 'README', 'logs');

function getLogFile(prefix: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${prefix}-${today}.log`);
}

let _ready = false;
function ensureDir() {
  if (!_ready) {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    _ready = true;
  }
}

function writeLine(file: string, line: string) {
  try {
    ensureDir();
    fs.appendFileSync(file, line + '\n');
  } catch {
    // silently ignore write errors
  }
}

/**
 * Write a timestamped log line to the daily app log file（始终输出）.
 */
export function log(tag: string, msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  writeLine(getLogFile('app'), `${ts} [${tag}] ${msg}`);
}

/**
 * Write a timestamped debug log line to the debug log file（始终输出）.
 * 排查问题时查看此文件，包含完整的调用链路和状态变化。
 */
export function debugLog(tag: string, msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  writeLine(getLogFile('debug'), `${ts} [${tag}] ${msg}`);
}
