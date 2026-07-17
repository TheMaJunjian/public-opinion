/**
 * auditLog.ts — Unified audit log writer.
 *
 * All audit log writes go through writeAuditLog(). It is best-effort:
 * failures are logged but never thrown — audit log should not block
 * business state mutations.
 *
 * payload structure:
 *   { summary: string, details: Record<string, unknown>, version: 1 }
 */
import { prisma } from './prisma';
import { Prisma } from '@prisma/client';
import { log } from './logger';

export interface AuditLogParams {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  topicId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
}

async function resolveActorName(actorId: string | null): Promise<string> {
  if (!actorId) return '系统';
  try {
    const u = await prisma.user.findUnique({ where: { id: actorId }, select: { username: true } });
    return u?.username ?? actorId.slice(-6);
  } catch {
    return actorId.slice(-6);
  }
}

/**
 * Write a single audit log entry. Best-effort — never throws.
 * The summary is automatically prefixed with the actor's username.
 */
export async function writeAuditLog(params: AuditLogParams): Promise<void> {
  try {
    const actorName = await resolveActorName(params.actorId);
    const fullSummary = `${actorName} ${params.summary}`;

    await prisma.auditLog.create({
      data: {
        actorId: params.actorId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        topicId: params.topicId ?? null,
        data: {
          summary: fullSummary,
          details: params.details ?? {},
          version: 1,
        } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    log('AuditLog', `FAILED action=${params.action} entityId=${params.entityId.slice(-6)} — ${(err as Error).message}`);
  }
}
