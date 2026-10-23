export interface ConversionFailureReport {
  failedAt: string;
  reason: string;
  rollbackStatus: 'completed' | 'unchanged' | 'unconfirmed';
  rollbackResult: string;
}

function safeReason(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/\S+/gi, '[数据库地址已隐藏]').slice(0, 4000);
}

/** The same report crosses the migration process, server and browser boundaries. */
export function readConversionFailure(value: unknown): ConversionFailureReport | undefined {
  if (!value || typeof value !== 'object') return;
  const report = value as Partial<ConversionFailureReport>;
  if (typeof report.failedAt !== 'string' || !Number.isFinite(Date.parse(report.failedAt))
    || typeof report.reason !== 'string' || typeof report.rollbackResult !== 'string'
    || !['completed', 'unchanged', 'unconfirmed'].includes(report.rollbackStatus ?? '')) return;
  return { failedAt: report.failedAt, reason: safeReason(report.reason), rollbackStatus: report.rollbackStatus!, rollbackResult: safeReason(report.rollbackResult) };
}

export function formatConversionFailure(report: ConversionFailureReport): string {
  const time = new Date(report.failedAt).toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' });
  return `失败时间：${time}\n失败原因：${report.reason}\n回滚结果：${report.rollbackResult}`;
}

export class ConversionFailure extends Error {
  constructor(readonly report: ConversionFailureReport) {
    super(formatConversionFailure(report));
    this.name = 'ConversionFailure';
  }
}

export function conversionFailure(error: unknown, rollbackStatus: ConversionFailureReport['rollbackStatus'], rollbackResult: string): ConversionFailure {
  // Bundled executables have independent class identities; inspect the contract.
  const failure = error as { report?: unknown; stderr?: unknown; message?: unknown } | null;
  let report = readConversionFailure(failure?.report);
  if (!report && typeof failure?.stderr === 'string') {
    for (const line of failure.stderr.trim().split('\n').reverse()) {
      try { report = readConversionFailure(JSON.parse(line).conversionFailure); } catch { /* Other stderr lines are diagnostics. */ }
      if (report) break;
    }
  }
  return new ConversionFailure(report ?? {
    failedAt: new Date().toISOString(),
    reason: safeReason(typeof failure?.stderr === 'string' && failure.stderr.trim() ? failure.stderr.trim() : typeof failure?.message === 'string' ? failure.message : String(error)),
    rollbackStatus, rollbackResult: safeReason(rollbackResult),
  });
}
