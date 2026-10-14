import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ExportViewerModal, { validateExportForViewing } from '../components/ExportViewerModal';

const archive = () => ({
  format: 'gonglun-2', formatVersion: 2, scope: { messageId: null, title: '公论' },
  messages: [], relations: [], regionId: 'local', ledgerId: 'local', programVersion: '2.0.0',
  changes: [{ sequence: 1, messages: [], states: [], memberships: [], removedMemberships: [], ledger: [], treasury: { operating: 0, issued: 0 } }],
});

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
    expect(() => validateExportForViewing(discontinuous)).toThrow('记录不连续');
    const unbalanced = archive();
    unbalanced.changes[0].treasury.issued = 1;
    expect(() => validateExportForViewing(unbalanced)).toThrow('资金不守恒');
  });

  it('keeps existing exported views readable without claiming replay verification', () => {
    const { format: _format, changes: _changes, ...old } = archive();
    expect(validateExportForViewing(old).verification).toBeNull();
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
    const bad = archive(); bad.changes[0].sequence = 9;
    render(<MemoryRouter><ExportViewerModal open onClose={vi.fn()} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('选择导出文件'), { target: { files: [new File([JSON.stringify(bad)], 'broken.json', { type: 'application/json' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('记录不连续');
    expect(screen.queryByRole('button', { name: '阅览此文件' })).toBeNull();
    expect(sessionStorage.getItem('lastExportData')).toBeNull();
  });
});
