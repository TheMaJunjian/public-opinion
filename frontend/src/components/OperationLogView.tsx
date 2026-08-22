import { useEffect, useState } from 'react';
import { getOperationLogs, operationLog, subscribeOperationLogs, type OperationLogEntry } from '../utils/debugLog';

export default function OperationLogView() {
  const [entries, setEntries] = useState<OperationLogEntry[]>(getOperationLogs);

  useEffect(() => {
    const unsubscribe = subscribeOperationLogs(setEntries);
    const handleButtonClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button');
      if (!button || button.disabled) return;
      const label = button.getAttribute('aria-label')
        || button.getAttribute('title')
        || button.textContent?.replace(/\s+/g, ' ').trim()
        || '未命名按钮';
      const context = button.closest('[data-operation-context]')?.getAttribute('data-operation-context');
      operationLog('点击按钮', `${context ? `${context}/` : ''}${label.slice(0, 120)}`);
      if (label.includes('发送')) {
        const textArea = document.querySelector('textarea');
        const content = textArea instanceof HTMLTextAreaElement ? textArea.value.trim() : '';
        if (content) operationLog('发送前输入', `内容=${content.slice(0, 500)}`);
      }
    };
    document.addEventListener('click', handleButtonClick, true);
    return () => {
      document.removeEventListener('click', handleButtonClick, true);
      unsubscribe();
    };
  }, []);

  return (
    <div style={{ border: '1px solid #444', borderRadius: 6, padding: 8, marginTop: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>操作日志</div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 12, opacity: 0.65 }}>暂无操作</div>
      ) : (
        <div style={{ fontSize: 12, maxHeight: 180, overflow: 'auto' }}>
          {entries.slice().reverse().map((entry, index) => (
            <div key={`${entry.time}-${index}`} style={{ borderBottom: '1px solid #333', padding: '3px 0', wordBreak: 'break-all' }}>
              <span style={{ opacity: 0.6, marginRight: 6 }}>{entry.time}</span>
              <strong>{entry.action}</strong>{entry.details ? ` ${entry.details}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}