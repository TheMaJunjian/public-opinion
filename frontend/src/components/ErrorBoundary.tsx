import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
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
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          padding: 24,
          background: '#101010',
          color: '#eee',
          height: '100%',
          fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12, color: '#ff6b6b' }}>
            渲染错误
          </div>
          <pre style={{
            whiteSpace: 'pre-wrap',
            color: '#ff8080',
            fontSize: 13,
            background: '#1a1a1a',
            padding: 12,
            borderRadius: 6,
            maxHeight: 400,
            overflow: 'auto',
          }}>
            {this.state.error?.message ?? '未知错误'}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: 12,
              padding: '6px 16px',
              borderRadius: 4,
              border: '1px solid #666',
              background: '#333',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
