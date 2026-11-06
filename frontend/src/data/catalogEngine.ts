import { decodeWorkbenchSnapshot, structureSnapshot, type CompactSnapshot, type WorkbenchSnapshot, type ReadingMark } from '@gonglun/core';
import { syncGlobalCatalog, type CatalogProgress } from './globalCatalog';
import { createGlobalCatalogCache } from './globalCatalogCache';
import { projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import type { buildLeaderboardRows } from '../utils/leaderboardRows';
import { deriveCleanVisibleIds } from '../utils/cleanProjection';
import { deriveHomeFilterResult } from '../pages/workbench/projections/homeFilterResult';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { getLatestUserReadStatusByMessageId } from '../pages/workbench/model/filters';
import {computeCorrectionVersions,computeEffectiveSuppressedRelIds} from '../utils/modelBridge';
import type { CleanFilterRule, User } from '../types';
import type { HomeFilterMode } from '../components/HomeFilterPanel';
import { fetchJsonWithDeadline } from '../utils/requestLifecycle';

export interface CatalogOptions { parent: string; key: string; baseUrl: string; deviceId: string; regionId?: string; structural?: boolean }
export interface CatalogData {
  snapshot: Pick<WorkbenchSnapshot, 'scope' | 'users' | 'attentionUsers' | 'tagCounts' | 'sequence' | 'regionId'>;
  projected: ReturnType<typeof projectWorkbenchSnapshot>;
  rows?: ReturnType<typeof buildLeaderboardRows>;
  index?: WorkbenchSnapshot;
}
export interface CatalogFilterQuery { rules: CleanFilterRule[]; home: HomeFilterMode | null; user: User | null; readingMarks?:ReadingMark[] }
export interface CatalogFilterResult {
  clean: ReturnType<typeof deriveCleanVisibleIds>;
  home: ReturnType<typeof deriveHomeFilterResult>;
}

/** Same formulas as the archive viewer; only their execution location changes. */
export function createCatalogEngine(options: CatalogOptions, callbacks: {
  idle(signal: AbortSignal): Promise<void>;
  onReady(data: CatalogData): void;
  onProgress(progress: CatalogProgress): void;
}): ReturnType<typeof syncGlobalCatalog> & { leaderboard(): Promise<ReturnType<typeof buildLeaderboardRows>>; filters(query: CatalogFilterQuery): Promise<CatalogFilterResult> } {
  let published: CatalogData | undefined;
  let stopped = false;
  let leaderboard: { data: CatalogData; result: Promise<ReturnType<typeof buildLeaderboardRows>> } | undefined;
  let full: Promise<ReturnType<typeof createCatalogEngine>> | undefined;
  let fullEngine: ReturnType<typeof createCatalogEngine> | undefined;
  let rejectFull: ((error: Error) => void) | undefined;
  const complete = async () => {
    if (stopped) throw new Error('讨论同步已停止');
    if (!full) full = new Promise((resolve, reject) => {
      rejectFull = reject;
      const engine = createCatalogEngine({ ...options, structural: false, key: `${options.key}:bodies` }, {
        idle: callbacks.idle, onReady: () => { rejectFull = undefined; resolve(engine); }, onProgress: progress => {
          if (progress.error) { full = undefined; rejectFull = undefined; engine.stop(); reject(new Error(progress.error)); }
        },
      });
      fullEngine = engine;
    });
    const engine = await full;
    if (stopped) throw new Error('讨论同步已停止');
    await engine.refresh();
    return engine;
  };
  const sync = syncGlobalCatalog({
    parent: options.parent, regionId: options.regionId, cache: createGlobalCatalogCache(options.key), idle: callbacks.idle,
    async load({ signal, ...query }) {
      const params = new URLSearchParams({ format: 'compact-v1' });
      if (options.structural) params.set('detail', 'structure');
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      const { response, data } = await fetchJsonWithDeadline<WorkbenchSnapshot | CompactSnapshot<WorkbenchSnapshot> & { error?: string }>(`${options.baseUrl}/ui/snapshot?${params}`, {
        credentials: 'same-origin', headers: { 'X-Device-Id': options.deviceId }, signal,
      });
      if (!response.ok) {
        const body = data as { error?: string };
        throw Object.assign(new Error(body.error || '全局消息同步失败'), { status: response.status });
      }
      const snapshot = decodeWorkbenchSnapshot<WorkbenchSnapshot>(data);
      if (options.structural && !snapshot.structureOnly) throw new Error('服务器尚未支持结构加载，请更新服务端后重试');
      return snapshot;
    },
    onProgress: callbacks.onProgress,
    onReady(snapshot) {
      const projected = projectWorkbenchSnapshot(options.structural ? { ...snapshot, messages: [], relations: [], stakes: {} } : snapshot);
      // Keep raw bodies in the worker; the UI only needs the projected model and scope metadata.
      published = { snapshot: { scope: snapshot.scope, users: snapshot.users, attentionUsers: snapshot.attentionUsers,
        tagCounts: snapshot.tagCounts, sequence: snapshot.sequence, regionId: snapshot.regionId },
        projected, ...(options.structural ? { index: snapshot } : {}) };
      leaderboard = undefined;
      callbacks.onReady(published);
    },
  });
  return {
    ...sync,
    applyCommitted(page: WorkbenchSnapshot) { sync.applyCommitted(options.structural ? structureSnapshot(page) : page); },
    stop() { stopped = true; leaderboard = undefined; rejectFull?.(new Error('讨论同步已停止')); rejectFull = undefined; fullEngine?.stop(); sync.stop(); },
    leaderboard(): Promise<ReturnType<typeof buildLeaderboardRows>> {
      if (options.structural) return complete().then(engine => engine.leaderboard());
      if (stopped) return Promise.reject(new Error('讨论同步已停止'));
      if (!published) return Promise.reject(new Error('正在准备全局消息'));
      const data = published;
      if (leaderboard?.data === data) return leaderboard.result;
      const result = Promise.all([import('../utils/leaderboardMetrics'), import('../utils/leaderboardRows')])
        .then(([{ buildLeaderboardMetrics }, { buildLeaderboardRows }]) => {
          if (stopped) throw new Error('讨论同步已停止');
          const { projected, snapshot } = data;
          return buildLeaderboardRows(buildLeaderboardMetrics(projected.messages, projected.edges, projected.relations, snapshot.users),
            snapshot.users, projected.counts, projected.bettors);
        }).catch(error => { if (leaderboard?.data === data) leaderboard = undefined; throw error; });
      leaderboard = { data, result };
      return result;
    },
    async filters(query: CatalogFilterQuery): Promise<CatalogFilterResult> {
      if (options.structural) return (await complete()).filters(query);
      if (!published) throw new Error('正在准备全局消息');
      const { projected, snapshot } = published;
      const { messages, edges, relations, counts } = projected;
      const effect = query.home ? deriveContainerEffect({ messages, edges, relations, username: query.user?.username ?? null, stakeCounts:counts }) : undefined;
      const memberships=effect?.memberships??[];
      return {
        clean: deriveCleanVisibleIds({ messages, edges, stakeCounts: counts, tagCounts: snapshot.tagCounts }, query.rules),
        home: deriveHomeFilterResult({ messages, edges, msgMap: new Map(messages.map(message => [message.id, message])),
          displayUser: query.user, homeFilterMode: query.home, traceContainerMemberships: memberships,relations,readingMarks:query.readingMarks,
          corrections:effect?computeCorrectionVersions(messages,edges,computeEffectiveSuppressedRelIds(edges,messages,query.user?.username??null),query.user?.username??null):undefined,
          readStatusByMessageId: getLatestUserReadStatusByMessageId(relations, relation => relation.createdBy.id === query.user?.id) }),
      };
    },
  };
}
