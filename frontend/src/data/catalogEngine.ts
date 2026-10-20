import { decodeWorkbenchSnapshot, type CompactSnapshot, type WorkbenchSnapshot } from '@gonglun/core';
import { syncGlobalCatalog, type CatalogProgress } from './globalCatalog';
import { createGlobalCatalogCache } from './globalCatalogCache';
import { projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { buildLeaderboardMetrics } from '../utils/leaderboardMetrics';
import { buildLeaderboardRows } from '../utils/leaderboardRows';
import { deriveCleanVisibleIds } from '../utils/cleanProjection';
import { deriveHomeFilterResult } from '../pages/workbench/projections/homeFilterResult';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { getLatestUserReadStatusByMessageId } from '../pages/workbench/model/filters';
import type { CleanFilterRule, User } from '../types';
import type { HomeFilterMode } from '../components/HomeFilterPanel';

export interface CatalogOptions { parent: string; key: string; baseUrl: string; deviceId: string; regionId?: string }
export interface CatalogData {
  snapshot: Pick<WorkbenchSnapshot, 'scope' | 'users' | 'attentionUsers' | 'tagCounts' | 'sequence' | 'regionId'>;
  projected: ReturnType<typeof projectWorkbenchSnapshot>;
  rows: ReturnType<typeof buildLeaderboardRows>;
}
export interface CatalogFilterQuery { rules: CleanFilterRule[]; home: HomeFilterMode | null; user: User | null }
export interface CatalogFilterResult {
  clean: ReturnType<typeof deriveCleanVisibleIds>;
  home: ReturnType<typeof deriveHomeFilterResult>;
}

/** Same formulas as the archive viewer; only their execution location changes. */
export function createCatalogEngine(options: CatalogOptions, callbacks: {
  idle(signal: AbortSignal): Promise<void>;
  onReady(data: CatalogData): void;
  onProgress(progress: CatalogProgress): void;
}) {
  let published: CatalogData | undefined;
  const sync = syncGlobalCatalog({
    parent: options.parent, regionId: options.regionId, cache: createGlobalCatalogCache(options.key), idle: callbacks.idle,
    async load({ signal, ...query }) {
      const params = new URLSearchParams({ format: 'compact-v1' });
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      const response = await fetch(`${options.baseUrl}/ui/snapshot?${params}`, {
        credentials: 'same-origin', headers: { 'X-Device-Id': options.deviceId }, signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw Object.assign(new Error(body.error || '全局消息同步失败'), { status: response.status });
      }
      return decodeWorkbenchSnapshot<WorkbenchSnapshot>(await response.json() as WorkbenchSnapshot | CompactSnapshot<WorkbenchSnapshot>);
    },
    onProgress: callbacks.onProgress,
    onReady(snapshot) {
      const projected = projectWorkbenchSnapshot(snapshot);
      const metrics = buildLeaderboardMetrics(projected.messages, projected.edges, projected.relations, snapshot.users);
      // Keep raw bodies in the worker; the UI only needs the projected model and scope metadata.
      published = { snapshot: { scope: snapshot.scope, users: snapshot.users, attentionUsers: snapshot.attentionUsers,
        tagCounts: snapshot.tagCounts, sequence: snapshot.sequence, regionId: snapshot.regionId },
        projected, rows: buildLeaderboardRows(metrics, snapshot.users, projected.counts, projected.bettors) };
      callbacks.onReady(published);
    },
  });
  return {
    ...sync,
    filters(query: CatalogFilterQuery): CatalogFilterResult {
      if (!published) throw new Error('正在准备全局消息');
      const { projected, snapshot } = published;
      const { messages, edges, relations, counts } = projected;
      const memberships = query.home ? deriveContainerEffect({ messages, edges, relations, username: query.user?.username ?? null }).memberships : [];
      return {
        clean: deriveCleanVisibleIds({ messages, edges, stakeCounts: counts, tagCounts: snapshot.tagCounts }, query.rules),
        home: deriveHomeFilterResult({ messages, edges, msgMap: new Map(messages.map(message => [message.id, message])),
          displayUser: query.user, homeFilterMode: query.home, traceContainerMemberships: memberships,
          readStatusByMessageId: getLatestUserReadStatusByMessageId(relations, relation => relation.createdBy.id === query.user?.id) }),
      };
    },
  };
}
