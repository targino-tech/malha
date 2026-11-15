import { setOrg, type Database } from './db';
import { CAPTURE_STALE_SECONDS, HEARTBEAT_TIMEOUT_SECONDS } from './health';

export type OperationalMetrics = {
  OutboxPending: number;
  OutboxOldestSeconds: number;
  OutboxFailed24h: number;
  CollectorsActive: number;
  CollectorsSilent: number;
  CollectorsStale: number;
  MaxCaptureAgeSeconds: number;
  NotificationsPending: number;
  NotificationsFailed24h: number;
  MaxClockSkewSeconds: number;
};

/**
 * Indicadores de operação da plataforma, agregados sem identificar clientes ou fazendas.
 * A fila de saída é uma tabela de roteamento sem RLS; as demais leituras passam pelo escopo de cada organização.
 */
export async function operationalMetrics(database: Database): Promise<OperationalMetrics> {
  const { rows: [outbox] } = await database.query<{ pending: string; oldest: string | null; failed: string }>(`
    SELECT count(*) FILTER (WHERE finished_at IS NULL AND failed_at IS NULL) AS pending,
      extract(epoch FROM now() - min(available_at) FILTER (WHERE finished_at IS NULL AND failed_at IS NULL)) AS oldest,
      count(*) FILTER (WHERE failed_at > now() - interval '24 hours') AS failed
    FROM inventory_outbox`);
  const metrics: OperationalMetrics = {
    OutboxPending: Number(outbox.pending), OutboxOldestSeconds: Math.round(Number(outbox.oldest ?? 0)), OutboxFailed24h: Number(outbox.failed),
    CollectorsActive: 0, CollectorsSilent: 0, CollectorsStale: 0, MaxCaptureAgeSeconds: 0, NotificationsPending: 0, NotificationsFailed24h: 0, MaxClockSkewSeconds: 0,
  };
  const { rows: organizations } = await database.query<{ id: string }>('SELECT id FROM organizations');
  for (const { id } of organizations) {
    await database.transaction(async (tx) => {
      await setOrg(tx, id);
      const { rows: [collectors] } = await tx.query<{ active: string; silent: string; stale: string; max_age: string | null; max_skew: number | null }>(`
        SELECT count(*) AS active, max(abs(h.clock_skew_seconds)) AS max_skew,
          count(*) FILTER (WHERE h.last_heartbeat_at < now() - make_interval(secs => ${HEARTBEAT_TIMEOUT_SECONDS})) AS silent,
          count(*) FILTER (WHERE h.last_capture_at < now() - make_interval(secs => ${CAPTURE_STALE_SECONDS})) AS stale,
          extract(epoch FROM now() - min(h.last_capture_at)) AS max_age
        FROM collector_keys k JOIN collector_health h ON h.org_id = k.org_id AND h.farm_id = k.farm_id AND h.collector_id = k.collector_id
        WHERE k.org_id = $1 AND k.revoked_at IS NULL AND h.last_heartbeat_at IS NOT NULL`, [id]);
      const { rows: [notifications] } = await tx.query<{ pending: string; failed: string }>(`
        SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
          count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours') AS failed
        FROM notifications WHERE org_id = $1`, [id]);
      metrics.CollectorsActive += Number(collectors.active);
      metrics.CollectorsSilent += Number(collectors.silent);
      metrics.CollectorsStale += Number(collectors.stale);
      metrics.MaxCaptureAgeSeconds = Math.max(metrics.MaxCaptureAgeSeconds, Math.round(Number(collectors.max_age ?? 0)));
      metrics.MaxClockSkewSeconds = Math.max(metrics.MaxClockSkewSeconds, Number(collectors.max_skew ?? 0));
      metrics.NotificationsPending += Number(notifications.pending);
      metrics.NotificationsFailed24h += Number(notifications.failed);
    });
  }
  return metrics;
}

/** Verifica se o processo alcança o banco. Usado pelo health check do balanceador. */
export async function databaseReachable(database: Database) {
  const { rows: [row] } = await database.query<{ ok: number }>('SELECT 1 AS ok');
  return row?.ok === 1;
}
