import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (error: Error) => void;
  onReload?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches rendering errors in its child tree.
 *
 * For intermittent React 18 DOM reconciliation bugs (e.g. "removeChild"
 * NotFoundError), immediately resets error state in componentDidCatch so
 * the re-render happens synchronously before the browser paints — the
 * user never sees the error UI for these transient failures.
 *
 * For non-transient errors, shows a fallback with the error message and
 * a "重试" button.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] 渲染崩溃:', error.message);
    console.error('[ErrorBoundary] 组件栈:', info.componentStack);

    // removeChild NotFoundError is a known React 18 concurrent reconciler
    // race condition.  A synchronous setState in componentDidCatch triggers
    // an immediate re-render that replaces the error UI before paint.
    if (error.message.includes('removeChild')) {
      this.setState({ hasError: false, error: null });
    } else {
      this.props.onError?.(error);
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const moduleFailed = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .+ failed/i.test(this.state.error?.message ?? '');
      return (
        <div style={{
          padding: 24,
          background: 'var(--surface-101010)',
          color: 'var(--ink-eee)',
          height: '100%',
          fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12, color: 'var(--ink-ff6b6b)' }}>
            {moduleFailed ? '页面组件加载失败' : '渲染错误'}
          </div>
          <pre style={{
            whiteSpace: 'pre-wrap',
            color: 'var(--ink-ff8080)',
            fontSize: 13,
            background: 'var(--surface-1a1a1a)',
            padding: 12,
            borderRadius: 6,
            maxHeight: 400,
            overflow: 'auto',
          }}>
            {this.state.error?.message ?? '未知错误'}
          </pre>
          <button
            // React.lazy caches rejected imports. Resetting this boundary alone
            // repeats the same rejection; a user-triggered reload fetches anew.
            onClick={() => moduleFailed
              ? (this.props.onReload ?? (() => window.location.reload()))()
              : this.setState({ hasError: false, error: null })}
            style={{
              marginTop: 12,
              padding: '6px 16px',
              borderRadius: 4,
              border: '1px solid var(--line-666)',
              background: 'var(--surface-333)',
              color: 'var(--ink-fff)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {moduleFailed ? '重新加载页面' : '重试'}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
