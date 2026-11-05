import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import WorkbenchViewToolbar from '../pages/workbench/ui/WorkbenchViewToolbar';

vi.mock('../theme/theme', () => ({ useThemeSettings: () => ({ layout: { messageJump: 'none' } }) }));
vi.mock('../components/HomeFilterPanel', () => ({ default: () => null }));
vi.mock('../components/CleanFilterPanel', () => ({ default: () => null }));
vi.mock('../components/DeferredWorkbench', () => ({ default: ({ children }: { children: ReactNode }) => children }));

function toolbar(): ComponentProps<typeof WorkbenchViewToolbar> {
  return {
    top: 0, scopeMessageId: 'root', exportTitle: '', showAlert: vi.fn(), onJump: vi.fn(), onLeaderboard: vi.fn(),
    home: { mode: null, onChange: vi.fn() },
    clean: { active: false, filters: [], matchCount: 0, totalCount: 0, onAdd: vi.fn(), onRemove: vi.fn(), onUpdate: vi.fn(), onClear: vi.fn() },
    filter: { settings: { hideJoin: true, hideSettlement: true }, onChange: vi.fn() },
    view: {
      viewMode: 'graph', setViewMode: vi.fn(), leftPanelRef: { current: null }, viewModeScrollRef: { current: { list: null, graph: null } },
      draftUnits: [{ messageId: 'source', selection: { kind: 'whole' } }], targetUnits: [{ messageId: 'target', selection: { kind: 'whole' } }], traceCount: 0,
      currentClassifyRelMsgId: null, messages: [], relations: [], findContainingClassification: vi.fn(),
      exitClassification: vi.fn(), enterClassification: vi.fn(), scheduleViewNavigation: vi.fn(),
    },
    comparison: { comparisonMode: false, comparisonReviewed: false, comparisonTargetId: null, setComparisonTargetId: vi.fn(), onStartComparison: vi.fn() },
    correctionFilterTargetId: null,
    discussion: { value: { mode: 'discussion', collapsed: [JSON.stringify(['target', 'reply'])] }, onChange: vi.fn(), error: null, retry: vi.fn() },
    onLocalExport: vi.fn(),
  };
}

it('offers one layout settings entry and the two named native radio options', async () => {
  render(<WorkbenchViewToolbar {...toolbar()} />);
  const trigger = await screen.findByRole('button', { name: '布局设置' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '讨论布局' })).toBeNull();
  expect(screen.queryByRole('button', { name: '关系图' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: '布局设置' })).toBeNull();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '布局设置' });
  expect(trigger).toHaveAttribute('aria-controls', dialog.id);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const options = within(dialog).getByRole('radiogroup', { name: '消息图布局' });
  expect(within(options).getByRole('radio', { name: '讨论布局（默认）' })).toBeChecked();
  expect(within(options).getByRole('radio', { name: '原关系图排布' })).not.toBeChecked();
});

it('changes only the layout choice, preserving folds and selections until an explicit export', async () => {
  const props = toolbar(), snapshot = JSON.stringify(props.view), ui = render(<WorkbenchViewToolbar {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '布局设置' }));
  fireEvent.click(screen.getByRole('radio', { name: '原关系图排布' }));
  const next = { ...props.discussion!.value, mode: 'graph' as const };
  expect(props.discussion!.onChange).toHaveBeenCalledExactlyOnceWith(next);
  expect(props.view.setViewMode).not.toHaveBeenCalled();
  expect(props.view.scheduleViewNavigation).not.toHaveBeenCalled();
  expect(props.view.enterClassification).not.toHaveBeenCalled();
  expect(props.view.exitClassification).not.toHaveBeenCalled();
  expect(props.onLocalExport).not.toHaveBeenCalled();
  expect(JSON.stringify(props.view)).toBe(snapshot);
  ui.rerender(<WorkbenchViewToolbar {...props} discussion={{ ...props.discussion!, value: next }} />);
  expect(screen.getByRole('radio', { name: '原关系图排布' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '关闭布局设置' }));
  fireEvent.click(screen.getByRole('button', { name: '下载阅览文件' }));
  expect(props.onLocalExport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'graph', discussion: next }));
});

it('closes on an outside pointer and Escape, restoring trigger focus only on Escape', async () => {
  const props = toolbar();
  render(<><button>外部操作</button><WorkbenchViewToolbar {...props} /></>);
  const trigger = await screen.findByRole('button', { name: '布局设置' });
  fireEvent.click(trigger);
  const radio = screen.getByRole('radio', { name: '讨论布局（默认）' });
  expect(radio).toHaveFocus();
  fireEvent.pointerDown(radio);
  expect(screen.getByRole('dialog', { name: '布局设置' })).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole('button', { name: '外部操作' }));
  expect(screen.queryByRole('dialog', { name: '布局设置' })).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('radio', { name: '讨论布局（默认）' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: '布局设置' })).toBeNull();
  expect(trigger).toHaveFocus();
  expect(props.discussion!.onChange).not.toHaveBeenCalled();
});

it('opens from the keyboard and uses native arrow-key radio selection', async () => {
  const user = userEvent.setup(), props = toolbar(), ui = render(<WorkbenchViewToolbar {...props} />);
  const trigger = await screen.findByRole('button', { name: '布局设置' });
  trigger.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('radio', { name: '讨论布局（默认）' })).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  expect(props.discussion!.onChange).toHaveBeenCalledWith({ ...props.discussion!.value, mode: 'graph' });
  ui.rerender(<WorkbenchViewToolbar {...props} discussion={{ ...props.discussion!, value: { ...props.discussion!.value, mode: 'graph' } }} />);
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('dialog', { name: '布局设置' })).toBeNull();
  await user.keyboard(' ');
  expect(screen.getByRole('radio', { name: '原关系图排布' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: '关闭布局设置' })).toHaveFocus();
});

it('unmounts the settings on list view and retains the existing save failure controls', async () => {
  const props = toolbar(); props.discussion!.error = '布局尚未保存';
  const ui = render(<WorkbenchViewToolbar {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '布局设置' }));
  ui.rerender(<WorkbenchViewToolbar {...props} view={{ ...props.view, viewMode: 'list' }} />);
  expect(screen.queryByRole('button', { name: '布局设置' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: '布局设置' })).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent('布局尚未保存');
  fireEvent.click(screen.getByRole('button', { name: '重试保存布局' }));
  expect(props.discussion!.retry).toHaveBeenCalledOnce();
  ui.rerender(<WorkbenchViewToolbar {...props} />);
  expect(screen.getByRole('button', { name: '布局设置' })).toHaveAttribute('aria-expanded', 'false');
});
