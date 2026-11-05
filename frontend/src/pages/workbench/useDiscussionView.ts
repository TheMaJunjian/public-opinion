import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ExportData } from '../../api/client';
import { copyDiscussionView, type DiscussionView } from '../../utils/discussionView';
import { loadExportDiscussionView, saveExportDiscussionView } from '../../utils/exportViewerCache';

export function useDiscussionView(data: ExportData | null | undefined) {
  const [value, setValue] = useState<DiscussionView>({ mode: 'discussion', collapsed: [] });
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const latest = useRef(value);
  latest.current = value;

  useLayoutEffect(() => {
    const request = ++generation.current;
    const initial = data?.view?.discussion ?? { mode: 'discussion', collapsed: [] };
    setValue(copyDiscussionView(initial));
    setError(null);
    if (data) void loadExportDiscussionView(data).then(saved => {
      if (request === generation.current && saved) setValue(saved);
    }).catch(cause => {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : '讨论布局恢复失败，已使用文件中的设置。');
    });
    return () => { generation.current += 1; };
  }, [data]);

  const onChange = useCallback((next: DiscussionView) => {
    const saved = copyDiscussionView(next);
    const request = ++generation.current;
    latest.current = saved;
    setValue(saved);
    setError(null);
    if (data) void saveExportDiscussionView(data, saved).catch(cause => {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : '讨论布局未保存，请重试。');
    });
  }, [data]);
  const retry = useCallback(() => onChange(latest.current), [onChange]);
  return { value, onChange, error, retry };
}
