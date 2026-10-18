import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { api } from '../api';
import type { WorkbenchSnapshot } from '../data/workbench';
import type { Message, Relation } from '../types';
import WorkbenchViewToolbar from '../pages/workbench/ui/WorkbenchViewToolbar';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';

vi.mock('../api', () => ({ api: { exportMessages: vi.fn() } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const user = { id: 'u2', username: '当前用户', createdAt: '' };
const time = '2026-10-18T10:00:00.000Z';
const message = (id: string): Message => ({ id, kind: 'TEXT', content: id, contentType: 'TEXT', createdBy: user, createdAt: time });

it('preserves messages, pinned references, relation states, order and display counts across export and viewing', () => {
  const relation: Relation = { id: 'relation', relationType: 'REFERENCE', sourceMessageId: 'b', createdAt: time, createdBy: user,
    targetRefs: [{ kind: 'text-fragment', messageId: 'a', text: 'a', hash: '', reference: { messageId: 'a', revision: 1, partId: 'body', range: { start: 0, end: 1 } } }],
    parts: [{ id: 'reference', type: 'relation', relation: 'reference', roles: { target: [{ id: 'target', reference: { messageId: 'a', revision: 1, partId: 'body' } }] } }],
    state: { messageId: 'relation', revision: 1, suppressed: true, supportCount: 0, oppositionCount: 1, recommendationTotal: 0 },
  };
  const messages: Message[] = [{ ...message('old'), supersededBy: 'a' }, { ...message('relation'), kind: 'RELATION', ...relation }, message('b'), message('a')];
  const snapshot: WorkbenchSnapshot = { scope: { messageId: null, title: '公论' }, messages, relations: [relation], users: [user], sequence: 7,
    stakes: { a: { messageId: 'a', pool: { lockedPro: 10, lockedCon: 3 }, counts: { pro: 1, con: 1 },
      stakes: [{ id: 'stake', side: 'PRO', amount: 10, user, createdAt: time }] } },
    tagCounts: { a: { VALUABLE: 2 } }, attentionUsers: { a: [user.id] },
  };
  const archive: ExportData = { formatVersion: 1, exportedAt: time, scope: snapshot.scope, users: snapshot.users,
    messages: [...messages].reverse().map(message => ({ ...message, authorId: message.createdBy.id, author: message.createdBy.username })),
    relations: [relation].map(relation => ({ ...relation, payload: relation.payload ?? null, supersededBy: null, authorId: relation.createdBy.id, author: relation.createdBy.username })),
    stakes: snapshot.stakes, tagCounts: snapshot.tagCounts, attentionUsers: snapshot.attentionUsers,
  };
  const reopened = archiveToWorkbenchSnapshot(JSON.parse(JSON.stringify(archive)));
  const display = ({ relations: _records, ...view }: ReturnType<typeof projectWorkbenchSnapshot>) => view;
  expect(display(projectWorkbenchSnapshot(reopened))).toEqual(display(projectWorkbenchSnapshot(snapshot)));
  expect(projectWorkbenchSnapshot(reopened).messages.map(message => message.id)).toEqual(['a', 'b', 'relation']);
  expect(projectWorkbenchSnapshot(reopened).authorAmounts.a).toBe(10);
  expect(reopened.tagCounts).toEqual(snapshot.tagCounts);
  expect(reopened.attentionUsers).toEqual(snapshot.attentionUsers);
});

it('re-exports the open archive with the current viewer and filters without fetching newer online messages', async () => {
  let downloaded: Blob | undefined;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { downloaded = blob; return 'blob:export'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const data: ExportData = { formatVersion: 1, exportedAt: time, scope: { messageId: null, title: '原文件' },
    messages: [{ ...message('archived'), authorId: user.id, author: user.username }], relations: [] };
  const props: Parameters<typeof WorkbenchViewToolbar>[0] = {
    top: 0, scopeMessageId: 'root', exportTitle: '原文件', exportData: data, exportUsername: user.username, showAlert: vi.fn(),
    home: { mode: 'read-self', onChange: vi.fn() }, filter: { settings: { hideJoin: false, hideSettlement: true }, onChange: vi.fn() },
    clean: { active: true, filters: [{ id: 'sender', kind: 'sender', username: user.username }], matchCount: 1, totalCount: 1, onAdd: vi.fn(), onRemove: vi.fn(), onUpdate: vi.fn(), onClear: vi.fn() },
    view: { viewMode: 'list', setViewMode: vi.fn(), leftPanelRef: { current: null }, viewModeScrollRef: { current: { graph: { top: 0, left: 0 }, list: { top: 0, left: 0 } } },
      draftUnits: [], targetUnits: [], traceCount: 0, currentClassifyRelMsgId: null, messages: [], relations: [], findContainingClassification: () => null,
      exitClassification: vi.fn(), enterClassification: vi.fn(), scheduleViewNavigation: vi.fn() },
    comparison: { comparisonMode: false, comparisonReviewed: false, comparisonTargetId: null, setComparisonTargetId: vi.fn(), onStartComparison: vi.fn() },
    correctionFilterTargetId: null, onLeaderboard: vi.fn(),
  };
  render(<WorkbenchViewToolbar {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '导出' }));
  await waitFor(() => expect(downloaded).toBeDefined());
  const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(downloaded!); });
  const reopened = JSON.parse(text) as ExportData;
  expect(reopened.messages.map(message => message.id)).toEqual(['archived']);
  expect(reopened.view).toEqual({ username: user.username, mode: 'list', messageFilter: props.filter.settings,
    homeFilter: 'read-self', cleanFilters: props.clean.filters, classificationId: null });
  expect(api.exportMessages).not.toHaveBeenCalled();
});
