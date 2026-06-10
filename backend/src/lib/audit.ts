import { prisma } from './prisma';
import { Prisma } from '@prisma/client';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  topicId?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Append an audit log entry. This is the single write path for all auditable actions.
 * In future decentralized phases, this becomes the event append point.
 */
export async function appendAuditLog(entry: AuditEntry) {
  return prisma.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      topicId: entry.topicId ?? null,
      data: (entry.data as Prisma.InputJsonValue) ?? undefined,
    },
  });
}
