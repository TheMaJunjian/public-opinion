import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareArchiveExport } from '../utils/exportTask';
import type { ExportUpdateData } from '../api/client';

const archive = { format: 'gonglun-2' as const, formatVersion: 2, regionId: 'local', ledgerId: 'local', programVersion: '2.0.0', exportedAt: '',
  scope: { messageId: null, title: '公论' }, messages: [], relations: [], changes: [] };
const oldFile = () => ({ text: async () => JSON.stringify(archive) }) as Blob;
const fetchMock = vi.fn();
beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
const read = (blob: Blob) => new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });

it('sends a checkpoint only and generates a complete verified update as a Blob', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams;
    expect([...query.keys()].sort()).toEqual(['after', 'baseCount', 'baseHash', 'ledgerId', 'parent', 'regionId']);
    expect(query.get('baseHash')).toMatch(/^[a-f0-9]{64}$/);
    const update: ExportUpdateData = { ...archive, format: 'gonglun-2-update',
      journal: { version: 1, entryCount: 0, lastSequence: 0 }, base: { regionId: 'local', ledgerId: 'local',
        sequence: 0, entryCount: 0, hash: query.get('baseHash')! } };
    return { ok: true, json: async () => update };
  });
  const progress = vi.fn();
  const result = await prepareArchiveExport({ task: { kind: 'update', file: oldFile() }, apiUrl: 'https://example.com/api/ui' }, progress);
  expect(JSON.parse(await read(result.blob))).toEqual({ ...archive, journal: { version: 1, entryCount: 0, lastSequence: 0 } });
  expect(progress).toHaveBeenCalledWith('正在生成文件…');
  expect(fetchMock).toHaveBeenCalledWith(expect.any(String), {
    credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal),
  });
});

it('stops before networking when an old file is invalid', async () => {
  await expect(prepareArchiveExport({ task: { kind: 'update', file: { text: async () => '{' } as Blob }, apiUrl: '/api/ui' }, () => {})).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('preserves the server source error instead of producing an output file', async () => {
  fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: '旧文件来自另一份公论数据，请回到原服务更新' }) });
  await expect(prepareArchiveExport({ task: { kind: 'update', file: oldFile() }, apiUrl: '/api/ui' }, () => {})).rejects.toThrow('请回到原服务更新');
});
