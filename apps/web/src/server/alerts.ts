import { setOrg, type Database, type Queryable } from './db';
import { CAPTURE_STALE_SECONDS, HEARTBEAT_TIMEOUT_SECONDS, MISSING_CAPTURES_FOR_DIVERGENCE } from './health';

export type Rule = 'collector_silent' | 'capture_stale' | 'asset_offline' | 'asset_missing';

const heartbeatFresh = `h.last_heartbeat_at >= now() - make_interval(secs => ${HEARTBEAT_TIMEOUT_SECONDS})`;
const captureFresh = `h.last_capture_at >= now() - make_interval(secs => ${CAPTURE_STALE_SECONDS})`;
const assetFresh = `a.last_observed_at >= now() - make_interval(secs => ${CAPTURE_STALE_SECONDS})`;
const activeCollector = `collector_keys k JOIN collector_health h
  ON h.org_id = k.org_id AND h.farm_id = k.farm_id AND h.collector_id = k.collector_id`;
const assetWithActiveCollector = `assets a JOIN collector_keys k
  ON k.org_id = a.org_id AND k.farm_id = a.farm_id AND k.collector_id = a.last_collector_id AND k.revoked_at IS NULL
  JOIN collector_health h ON h.org_id = k.org_id AND h.farm_id = k.farm_id AND h.collector_id = k.collector_id`;

/**
 * Cada regra descreve os recursos que devem ter um episódio aberto (`candidates`) e os que encerram
 * o episódio (`cleared`). Um recurso fora dos dois conjuntos mantém o episódio como está, por exemplo
 * um ativo indeterminado após perda de contato. Regras de ativo exigem coletor em contato, o que
 * suprime alertas individuais enquanto a fazenda estiver sem comunicação.
 */
const rules: Array<{ rule: Rule; kind: 'collector' | 'asset'; candidates: string; cleared: string }> = [
  {
    rule: 'collector_silent', kind: 'collector',
    candidates: `SELECT k.farm_id, k.collector_id AS resource_id, 'critical' AS severity, 'Coletor sem contato' AS title,
        h.last_heartbeat_at AS first_observed_at
      FROM ${activeCollector}
      WHERE k.org_id = $1 AND k.revoked_at IS NULL AND h.last_heartbeat_at IS NOT NULL AND NOT (${heartbeatFresh})`,
    cleared: `SELECT k.collector_id FROM ${activeCollector}
      WHERE k.org_id = $1 AND (k.revoked_at IS NOT NULL OR ${heartbeatFresh})`,
  },
  {
    rule: 'capture_stale', kind: 'collector',
    candidates: `SELECT k.farm_id, k.collector_id AS resource_id, 'warning' AS severity, 'Coleta UniFi desatualizada' AS title,
        h.last_capture_at AS first_observed_at
      FROM ${activeCollector}
      WHERE k.org_id = $1 AND k.revoked_at IS NULL AND ${heartbeatFresh}
        AND h.last_capture_at IS NOT NULL AND NOT (${captureFresh})`,
    cleared: `SELECT k.collector_id FROM ${activeCollector}
      WHERE k.org_id = $1 AND (k.revoked_at IS NOT NULL OR ${captureFresh})`,
  },
  {
    rule: 'asset_offline', kind: 'asset',
    candidates: `SELECT a.farm_id, a.id AS resource_id, CASE WHEN a.critical THEN 'critical' ELSE 'warning' END AS severity,
        'Ativo offline: ' || a.name AS title, COALESCE(a.offline_since, a.last_observed_at) AS first_observed_at
      FROM ${assetWithActiveCollector}
      WHERE a.org_id = $1 AND a.archived_at IS NULL AND a.status = 'offline' AND ${assetFresh} AND ${heartbeatFresh}`,
    cleared: `SELECT a.id FROM assets a
      WHERE a.org_id = $1 AND (a.archived_at IS NOT NULL OR (a.status = 'online' AND ${assetFresh})
        OR NOT EXISTS (SELECT 1 FROM collector_keys k WHERE k.org_id = a.org_id AND k.farm_id = a.farm_id
          AND k.collector_id = a.last_collector_id AND k.revoked_at IS NULL))`,
  },
  {
    rule: 'asset_missing', kind: 'asset',
    candidates: `SELECT a.farm_id, a.id AS resource_id, 'warning' AS severity,
        'Divergência: ativo ausente na coleta: ' || a.name AS title, a.last_observed_at AS first_observed_at
      FROM ${assetWithActiveCollector}
      WHERE a.org_id = $1 AND a.archived_at IS NULL AND a.missing_captures >= ${MISSING_CAPTURES_FOR_DIVERGENCE} AND ${heartbeatFresh}`,
    cleared: `SELECT a.id FROM assets a WHERE a.org_id = $1 AND (a.missing_captures = 0 OR a.archived_at IS NOT NULL)`,
  },
];

export type EvaluationResult = { opened: number; resolved: number; notifications: number };

/** Avalia as regras de uma organização. Requer `setOrg` na mesma transação. */
export async function evaluateOrganization(tx: Queryable, orgId: string): Promise<EvaluationResult> {
  const result: EvaluationResult = { opened: 0, resolved: 0, notifications: 0 };
  for (const { rule, kind, candidates, cleared } of rules) {
    const { rows: resolved } = await tx.query<{ id: string }>(`WITH closed AS (
        UPDATE occurrences SET resolved_at = now(), resolution = 'auto'
        WHERE org_id = $1 AND rule = $2 AND resolved_at IS NULL AND resource_id IN (${cleared})
        RETURNING id
      ) INSERT INTO occurrence_events (org_id, occurrence_id, id, kind, actor)
        SELECT $1, id, gen_random_uuid(), 'resolved', 'malha' FROM closed RETURNING occurrence_id AS id`, [orgId, rule]);
    result.resolved += resolved.length;

    const { rows: opened } = await tx.query<{ id: string; severity: string }>(`WITH candidates AS (${candidates}),
      created AS (
        INSERT INTO occurrences (org_id, farm_id, id, rule, resource_kind, resource_id, severity, title, first_observed_at)
        SELECT $1, farm_id, gen_random_uuid(), $2, $3, resource_id, severity, left(title, 300), first_observed_at FROM candidates
        ON CONFLICT (org_id, farm_id, rule, resource_id) WHERE resolved_at IS NULL DO NOTHING
        RETURNING id, severity
      ), events AS (
        INSERT INTO occurrence_events (org_id, occurrence_id, id, kind, actor)
        SELECT $1, id, gen_random_uuid(), 'opened', 'malha' FROM created
      ) SELECT id, severity FROM created`, [orgId, rule, kind]);
    result.opened += opened.length;

    const critical = opened.filter((row) => row.severity === 'critical').map((row) => row.id);
    if (critical.length) {
      const { rows } = await tx.query(`INSERT INTO notifications (org_id, occurrence_id, recipient)
        SELECT $1, o.id, r.email FROM occurrences o JOIN alert_recipients r ON r.org_id = o.org_id AND r.active
        WHERE o.org_id = $1 AND o.id = ANY($2::uuid[]) AND NOT EXISTS (SELECT 1 FROM assets a
          WHERE o.resource_kind = 'asset' AND a.org_id = o.org_id AND a.farm_id = o.farm_id AND a.id = o.resource_id
            AND a.maintenance_until > now())
        ON CONFLICT DO NOTHING RETURNING recipient`, [orgId, critical]);
      result.notifications += rows.length;
    }
  }
  return result;
}

const EVALUATION_LOCK = 58147262;

/**
 * Avalia todas as organizações em uma transação. O lock transacional funciona como lease entre
 * réplicas do worker: só uma avalia por vez e as demais retornam `null`.
 */
export async function evaluateAll(database: Database): Promise<EvaluationResult | null> {
  return database.transaction(async (tx) => {
    const { rows: [lock] } = await tx.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS acquired', [EVALUATION_LOCK]);
    if (!lock.acquired) return null;
    const total: EvaluationResult = { opened: 0, resolved: 0, notifications: 0 };
    const { rows: organizations } = await tx.query<{ id: string }>('SELECT id FROM organizations ORDER BY id');
    for (const { id } of organizations) {
      await setOrg(tx, id);
      const partial = await evaluateOrganization(tx, id);
      total.opened += partial.opened;
      total.resolved += partial.resolved;
      total.notifications += partial.notifications;
    }
    return total;
  });
}
