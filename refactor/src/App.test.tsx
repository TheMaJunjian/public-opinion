import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';

describe('message identity navigation', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('loads a relation message from its URL and navigates to its target message', async () => {
    window.history.replaceState(null, '', '/?msg=rel-disagree');
    render(<App />);

    await screen.findByRole('heading', { name: '反对' });
    expect(screen.getByText('rel-disagree')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'msg-claim' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'TEXT' })).toBeInTheDocument());
    expect(screen.getByText('msg-claim')).toBeInTheDocument();
    expect(window.location.search).toBe('?msg=msg-claim');
  });

  it('opens a container as a message-scoped projection', async () => {
    render(<App />);

    await screen.findByText('责任与可解释性');
    fireEvent.click(document.querySelector('[data-msgid="rel-classify"]')!);
    fireEvent.click(await screen.findByRole('button', { name: '进入容器视图' }));

    expect(screen.getByRole('heading', { name: '容器：责任与可解释性' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回主题画布' })).toBeInTheDocument();
    expect(screen.getByText('内容消息')).toHaveTextContent('1');
    expect(screen.getByText('关系消息')).toHaveTextContent('2');
  });
});
