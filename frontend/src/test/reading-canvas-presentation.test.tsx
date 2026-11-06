import { useRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ReadingCanvasPresentation from '../components/ReadingCanvasPresentation';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';
import { deriveReadingProgress, type ReadingInput } from '../pages/workbench/model/readingProgress';

const context = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../components/MessageDisplayHints', () => ({ useReadingDisplayContext: context.read }));
const { readFileSync } = await vi.importActual<{ readFileSync(path: URL, encoding: 'utf8'): string }>('node:fs');
const testFileUrl = import.meta.url;
const css = readFileSync(new URL('../theme/reading-presentation.css', testFileUrl), 'utf8');

beforeEach(() => {
  const input: ReadingInput = { messages: ['owner', 'record', 'later'].map(id => ({ id, kind: 'normal', content: id, author: 'me', createdAt: '' })),
    edges: [], relations: [], readStatus: new Map(), marks: [], username: 'me' };
  context.read.mockReturnValue({ input: { readingMarks: input.marks }, readingInput: input, data: { reading: deriveReadingProgress(input) } });
});
function Canvas({ active = true }: { active?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  return <><style>{css}</style><div ref={viewport} data-testid="viewport">
    <ReadingCanvasPresentation viewport={viewport} active={active} />
    <div data-testid="canvas">
      <div data-msgid="owner" style={{ position: 'absolute', left: 120, top: 240, height: 160 }}>
        <button data-msgid="owner" data-jump-msgids="record">关系记录</button>
      </div>
    </div>
  </div></>;
}

it('reveals the carrier of an explicitly revisited inline record without moving or replacing it', async () => {
  const view = render(<Canvas />), viewport = view.getByTestId('viewport'), canvas = view.getByTestId('canvas');
  const owner = viewport.querySelector<HTMLElement>('[data-msgid="owner"]')!, record = owner.querySelector('button')!;
  const geometry = owner.getAttribute('style');
  await waitFor(() => expect(record).not.toBeVisible());
  act(() => canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: ['record'] } })));
  expect(record).toBeVisible();
  expect(owner).toHaveAttribute('data-reading-presentation', 'dimmed');
  expect(record).not.toHaveAttribute('data-reading-presentation');
  expect(owner.getAttribute('style')).toBe(geometry);
  act(() => viewport.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } })));
  expect(record).toBeVisible();
  expect(viewport.querySelector('[data-msgid="owner"]')).toBe(owner);
});

it('applies reading visibility to later virtual mounts and restores ordinary browsing on exit', async () => {
  const view = render(<Canvas />), canvas = view.getByTestId('canvas');
  const later = document.createElement('button'); later.dataset.msgid = 'later'; later.textContent = '后续挂载';
  act(() => canvas.append(later));
  await waitFor(() => expect(later).not.toBeVisible());
  act(() => { later.dataset.msgid = 'unknown'; });
  await waitFor(() => expect(later).toBeVisible());
  act(() => { later.dataset.msgid = 'later'; });
  await waitFor(() => expect(later).not.toBeVisible());
  view.rerender(<Canvas active={false} />);
  expect(later).toBeVisible();
  expect(view.getByText('关系记录')).toBeVisible();
  expect(view.getByTestId('viewport').querySelector('[data-reading-presentation]')).toBeNull();
});
