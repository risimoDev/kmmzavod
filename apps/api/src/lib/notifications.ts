import { db } from './db';
import { logger } from '../logger';

export interface EmitNotificationParams {
  tenantId: string;
  userId?: string | null;
  type?: 'system' | 'job_failed' | 'billing' | 'credits_low' | 'plan_expiring';
  title: string;
  body: string;
  actionUrl?: string | null;
}

/**
 * Creates a persistent notification in the database for the given tenant and user.
 * These notifications persist across browser restarts and device logins.
 */
export async function emitNotification(params: EmitNotificationParams) {
  try {
    const notification = await db.notification.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId ?? null,
        type: params.type ?? 'system',
        title: params.title,
        body: params.body,
        actionUrl: params.actionUrl ?? null,
      },
    });

    logger.info(
      { notificationId: notification.id, tenantId: params.tenantId, type: notification.type },
      'Persistent notification emitted',
    );
    return notification;
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), params },
      'Failed to emit persistent notification',
    );
    return null;
  }
}
