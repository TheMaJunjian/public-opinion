import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ExportViewerModal, { validateExportForViewing } from '../components/ExportViewerModal';
import {migrateViewFile} from '../../../apps/migrate/src/migrate-view-file';

const archive = () => ({
  format: 'gonglun-2', formatVersion: 2, scope: { messageId: null, title: '公论' },
  messages: [], relations: [], regionId: 'local', ledgerId: 'local', programVersion: '2.0.0',
  changes: [{ sequence: 1, previousSequence:0, messages: [], states: [], memberships: [], removedMemberships: [], ledger: [], treasury: { operating: 0, issued: 0 } }],
});

function archiveWithout<K extends keyof ReturnType<typeof archive>>(...keys: K[]): Omit<ReturnType<typeof archive>, K> {
  const data = archive();
  for (const key of keys) Reflect.deleteProperty(data, key);
  return data;
}

afterEach(() => { cleanup(); sessionStorage.clear(); });

describe('export viewer verification', () => {
  it('replays region records while preserving the selected read-only view', () => {
    const data = archive();
    const result = validateExportForViewing(data);
    expect(result.data).toBe(data);
    expect(result.verification).toContain('记录连续性及资金守恒校验通过');
    expect(result.verification).toContain('1 次变更');
  });

  it('rejects missing changes and money creation before opening the viewer', () => {
    const discontinuous = archive();
    discontinuous.changes[0].sequence = 2;
    discontinuous.changes[0].previousSequence = 1;
    expect(() => validateExportForViewing(discontinuous)).toThrow('记录不连续');
    const unbalanced = archive();
    unbalanced.changes[0].treasury.issued = 1;
    expect(() => validateExportForViewing(unbalanced)).toThrow('资金不守恒');
  });

  it('keeps existing exported views readable without claiming replay verification', () => {
    const old = archiveWithout('format', 'changes');
    expect(validateExportForViewing(old).verification).toBeNull();
  });

  it('normalizes historical topic exports without treating old topic IDs as message IDs', () => {
    const view = archiveWithout('scope', 'format', 'changes');
    const old = { ...view, topic: { id: 'old-topic', title: '旧版讨论' } };
    expect(()=>validateExportForViewing(old)).toThrow('独立迁移程序');
    const result = validateExportForViewing(migrateViewFile(old));
    expect(result.data.scope).toEqual({ messageId: null, title: '旧版讨论' });
    expect(result.data.messages).toEqual(old.messages);
    expect(result.data.relations).toEqual(old.relations);
    expect(result.verification).toBeNull();
    expect(old).not.toHaveProperty('scope');
    expect(validateExportForViewing(JSON.parse(JSON.stringify(result.data))).data.scope.title).toBe('旧版讨论');
  });

  it('continues to reject incomplete files with specific missing-field errors', () => {
    expect(() => validateExportForViewing({ scope: { title: '消息' }, relations: [] })).toThrow('缺少消息列表（messages）');
    expect(() => validateExportForViewing({ scope: { title: '讨论' }, messages: [] })).toThrow('缺少关系列表（relations）');
    expect(() => validateExportForViewing({ messages: [], relations: [] })).toThrow('缺少阅览范围信息');
    const journal = archiveWithout('scope', 'messages', 'relations');
    expect(() => validateExportForViewing(journal)).toThrow('仅含执行记录的文件');
    expect(() => validateExportForViewing({ ...archive(), view: { mode: 'graph' } })).toThrow('阅览设置格式无效');
  });

  it('verifies journal archives that still export topic metadata', () => {
    const data = archiveWithout('scope');
    const legacy = { ...data, topic: { id: 'root', title: '公论' } };
    expect(validateExportForViewing(migrateViewFile(legacy))).toMatchObject({
      data: { scope: { messageId: null, title: '公论' } },
      verification: expect.stringContaining('记录连续性及资金守恒校验通过'),
    });
    legacy.changes[0].treasury.issued = 1;
    expect(() => validateExportForViewing(legacy)).toThrow('资金不守恒');
  });

  it('shows the historical title when selecting an old export', async () => {
    const view = archiveWithout('scope', 'format', 'changes');
    const old = migrateViewFile({ ...view, topic: { id: 'old-topic', title: '旧版讨论' } });
    sessionStorage.setItem('lastExportData', JSON.stringify(old));
    render(<MemoryRouter><ExportViewerModal open onClose={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /上次阅览：旧版讨论/ })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('选择导出文件'), { target: { files: [new File([JSON.stringify(old)], '旧版讨论.json', { type: 'application/json' })] } });
    expect(await screen.findByRole('button', { name: '阅览此文件' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows verification after file selection and keeps the original open action', async () => {
    const onClose = vi.fn();
    render(<MemoryRouter><ExportViewerModal open onClose={onClose} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('选择导出文件'), { target: { files: [new File([JSON.stringify(archive())], '公论.json', { type: 'application/json' })] } });
    expect(await screen.findByRole('status')).toHaveTextContent('资金守恒校验通过');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '阅览此文件' })).toBeEnabled();
  });

  it('shows a replay error and prevents an invalid archive from being opened', async () => {
    const bad = archive(); bad.changes[0].sequence = 9;bad.changes[0].previousSequence=8;
    render(<MemoryRouter><ExportViewerModal open onClose={vi.fn()} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('选择导出文件'), { target: { files: [new File([JSON.stringify(bad)], 'broken.json', { type: 'application/json' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('记录不连续');
    expect(screen.queryByRole('button', { name: '阅览此文件' })).toBeNull();
    expect(sessionStorage.getItem('lastExportData')).toBeNull();
  });
});
