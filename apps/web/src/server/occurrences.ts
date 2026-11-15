import { randomUUID } from 'node:crypto';
import { setOrg, type Database, type Queryable } from './db';
import { HttpError, uuidPattern } from './http';
import { farmAllowed, requirePermission } from './authz';
import type { Principal } from './identity';

export type DashboardOccurrence = {
  id: string;
  farmId: string;
  rule: 'collector_silent' | 'capture_stale' | 'asset_offline' | 'asset_missing';
  resourceKind: 'collector' | 'asset';
  resourceId: string;
  severity: 'critical' | 'warning';
  title: string;
  firstObservedAt: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
};

const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;

/** Ocorrências abertas e as encerradas nos últimos 7 dias, no escopo da organização da transação. */
export async function listOccurrences(tx: Queryable, orgId: string, farmIds: string[] | null): Promise<DashboardOccurrence[]> {
  const { rows } = await tx.query<{
    id: string; farm_id: string; rule: DashboardOccurrence['rule']; resource_kind: DashboardOccurrence['resourceKind'];
    resource_id: string; severity: DashboardOccurrence['severity']; title: string; first_observed_at: Date | null;
    opened_at: Date; acknowledged_at: Date | null; resolved_at: Date | null;
  }>(`SELECT id, farm_id, rule, resource_kind, resource_id, severity, title, first_observed_at, opened_at, acknowledged_at, resolved_at
    FROM occurrences WHERE org_id = $1 AND ($2::uuid[] IS NULL OR farm_id = ANY($2::uuid[]))
      AND (resolved_at IS NULL OR resolved_at > now() - interval '7 days')
    ORDER BY resolved_at IS NULL DESC, severity = 'critical' DESC, opened_at DESC LIMIT 300`, [orgId, farmIds]);
  return rows.map((row) => ({
    id: row.id, farmId: row.farm_id, rule: row.rule, resourceKind: row.resource_kind, resourceId: row.resource_id,
    severity: row.severity, title: row.title, firstObservedAt: iso(row.first_observed_at), openedAt: iso(row.opened_at)!,
    acknowledgedAt: iso(row.acknowledged_at), resolvedAt: iso(row.resolved_at),
  }));
}

export async function acknowledgeOccurrence(database: Database, user: Principal, occurrenceId: string) {
  requirePermission(user, 'occurrences.acknowledge');
  if (!uuidPattern.test(occurrenceId)) throw new HttpError(404, 'Ocorrência não encontrada.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows: [current] } = await tx.query<{ farm_id: string; acknowledged_at: Date | null }>(`SELECT farm_id, acknowledged_at
      FROM occurrences WHERE org_id = $1 AND id = $2 FOR UPDATE`, [user.orgId, occurrenceId]);
    if (!current || !farmAllowed(user, current.farm_id)) throw new HttpError(404, 'Ocorrência não encontrada.');
    if (current.acknowledged_at) return { acknowledgedAt: new Date(current.acknowledged_at).toISOString() };
    const { rows: [updated] } = await tx.query<{ acknowledged_at: Date }>(`UPDATE occurrences SET acknowledged_at = now(), acknowledged_by = $3
      WHERE org_id = $1 AND id = $2 RETURNING acknowledged_at`, [user.orgId, occurrenceId, user.actor]);
    await tx.query(`INSERT INTO occurrence_events (org_id, occurrence_id, id, kind, actor) VALUES ($1, $2, $3, 'acknowledged', $4)`,
      [user.orgId, occurrenceId, randomUUID(), user.actor]);
    await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), user.orgId, user.actor, 'occurrence.acknowledge', JSON.stringify({ farmId: current.farm_id, occurrenceId })]);
    return { acknowledgedAt: new Date(updated.acknowledged_at).toISOString() };
  });
}
