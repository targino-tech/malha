import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { farmAllowed, requireFarm, requirePermission } from './authz';
import { setOrg, type Database, type Queryable } from './db';
import { CAPTURE_STALE_SECONDS } from './health';
import { HttpError, uuidPattern } from './http';
import type { Principal } from './identity';

async function audit(tx: Queryable, user: Principal, action: string, scope: object) {
  await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [randomUUID(), user.orgId, user.actor, action, JSON.stringify(scope)]);
}

// Atendimentos

const serviceSchema = z.object({
  occurrenceId: z.string().regex(uuidPattern).nullish().transform((value) => value ?? null),
  farmId: z.string().regex(uuidPattern).nullish().transform((value) => value ?? null),
  attendedAt: z.iso.datetime({ offset: true }),
  diagnosisMinutes: z.number().int().min(0).max(10_080),
  tripAvoided: z.boolean(),
  notes: z.string().trim().max(1000).nullish().transform((value) => value || null),
});

/** Registra um atendimento real. O tempo de diagnóstico e a viagem evitada alimentam a medição de economia. */
export async function recordService(database: Database, user: Principal, body: unknown) {
  requirePermission(user, 'inventory.write');
  const parsed = serviceSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Revise a data, o tempo de diagnóstico e a viagem do atendimento.');
  const data = parsed.data;
  if (Date.parse(data.attendedAt) > Date.now() + 5 * 60_000) throw new HttpError(400, 'A data do atendimento está no futuro.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    let farmId = data.farmId;
    let assetId: string | null = null;
    if (data.occurrenceId) {
      const { rows: [occurrence] } = await tx.query<{ farm_id: string; resource_kind: string; resource_id: string }>(
        'SELECT farm_id, resource_kind, resource_id FROM occurrences WHERE org_id = $1 AND id = $2', [user.orgId, data.occurrenceId]);
      if (!occurrence || !farmAllowed(user, occurrence.farm_id)) throw new HttpError(404, 'Ocorrência não encontrada.');
      farmId = occurrence.farm_id;
      if (occurrence.resource_kind === 'asset') {
        const { rows } = await tx.query('SELECT 1 FROM assets WHERE org_id = $1 AND id = $2', [user.orgId, occurrence.resource_id]);
        if (rows.length) assetId = occurrence.resource_id;
      }
    }
    if (!farmId) throw new HttpError(400, 'Informe a fazenda do atendimento.');
    requireFarm(user, farmId);
    const id = randomUUID();
    await tx.query(`INSERT INTO service_records (org_id, farm_id, id, occurrence_id, asset_id, actor, attended_at, diagnosis_minutes, trip_avoided, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [user.orgId, farmId, id, data.occurrenceId, assetId, user.actor, data.attendedAt, data.diagnosisMinutes, data.tripAvoided, data.notes]);
    await audit(tx, user, 'service.record', { farmId, serviceId: id, occurrenceId: data.occurrenceId });
    return { id };
  });
}

const baselineSchema = z.object({
  diagnosisMinutes: z.number().int().min(0).max(10_080),
  travelHours: z.number().min(0).max(1000),
  costPerHour: z.number().min(0).max(1_000_000),
  costPerTrip: z.number().min(0).max(1_000_000),
});

/** Linha de base pré-piloto com valores aprovados pelo cliente. Só o admin define. */
export async function saveBaseline(database: Database, user: Principal, body: unknown) {
  requirePermission(user, 'baseline.manage');
  const parsed = baselineSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Revise os valores da linha de base.');
  const data = parsed.data;
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    await tx.query(`INSERT INTO baselines (org_id, diagnosis_minutes, travel_hours, cost_per_hour, cost_per_trip, defined_by)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (org_id) DO UPDATE SET diagnosis_minutes = excluded.diagnosis_minutes,
        travel_hours = excluded.travel_hours, cost_per_hour = excluded.cost_per_hour, cost_per_trip = excluded.cost_per_trip,
        defined_at = now(), defined_by = excluded.defined_by`,
    [user.orgId, data.diagnosisMinutes, data.travelHours, data.costPerHour, data.costPerTrip, user.actor]);
    await audit(tx, user, 'baseline.save', data);
    return data;
  });
}

// Indicadores

export type Indicators = {
  periodDays: number;
  from: string;
  coverage: { eligible: number; complete: number; csvOnly: number };
  inventory: { reference: number; reviewed: number; incomplete: number; discoveredPending: number; unifiEligible: number; unifiReconciled: number };
  detection: { episodes: number; medianMinutes: number | null; p90Minutes: number | null };
  acknowledgement: { acknowledged: number; medianMinutes: number | null; pending: number };
  savings: {
    baseline: { diagnosisMinutes: number; travelHours: number; costPerHour: number; costPerTrip: number; definedAt: string } | null;
    services: number; diagnosisMinutes: number; tripsAvoided: number; hoursSaved: number | null; costSaved: number | null;
  };
  weekly: { weeks: string[]; farms: Array<{ farmId: string; counts: number[] }> };
  services: Array<{ id: string; farmId: string; attendedAt: string; diagnosisMinutes: number; tripAvoided: boolean; notes: string | null; occurrenceTitle: string | null }>;
};

const minutes = (value: unknown) => value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10;

export async function indicators(database: Database, user: Principal, params: URLSearchParams): Promise<Indicators> {
  const days = Number(params.get('days') ?? 30);
  if (![7, 30, 90].includes(days)) throw new HttpError(400, 'Período inválido.');
  const farmParam = params.get('farmId');
  if (farmParam) {
    if (!uuidPattern.test(farmParam)) throw new HttpError(404, 'Fazenda indisponível.');
    requireFarm(user, farmParam);
  }
  const farmIds = farmParam ? [farmParam] : user.farmIds;
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const scope = [user.orgId, farmIds, days];
    const inScope = (alias: string) => `${alias}.org_id = $1 AND ($2::uuid[] IS NULL OR ${alias}.farm_id = ANY($2::uuid[]))`;
    const { rows: [{ from }] } = await tx.query<{ from: Date }>('SELECT now() - make_interval(days => $1) AS from', [days]);

    // Cobertura: fazendas com coletor ativo e captura completa recente, sobre as fazendas habilitadas para UniFi.
    const { rows: [coverage] } = await tx.query<{ eligible: string; complete: string; csv_only: string }>(`
      SELECT count(k.collector_id) AS eligible,
        count(k.collector_id) FILTER (WHERE h.last_capture_at >= now() - make_interval(secs => ${CAPTURE_STALE_SECONDS})) AS complete,
        count(*) FILTER (WHERE k.collector_id IS NULL) AS csv_only
      FROM farms f LEFT JOIN collector_keys k ON k.org_id = f.org_id AND k.farm_id = f.id AND k.revoked_at IS NULL
      LEFT JOIN collector_health h ON h.org_id = k.org_id AND h.farm_id = k.farm_id AND h.collector_id = k.collector_id
      WHERE f.org_id = $1 AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[]))`, scope.slice(0, 2));

    const { rows: [inventory] } = await tx.query<Record<string, string>>(`
      SELECT count(*) FILTER (WHERE source <> 'unifi') AS reference,
        count(*) FILTER (WHERE source <> 'unifi' AND reviewed_at IS NOT NULL) AS reviewed,
        count(*) FILTER (WHERE source <> 'unifi' AND (tag IS NULL OR location_id IS NULL)) AS incomplete,
        count(*) FILTER (WHERE source = 'unifi' AND reviewed_at IS NULL) AS discovered_pending,
        count(*) FILTER (WHERE external_id IS NOT NULL) AS unifi_eligible,
        count(*) FILTER (WHERE external_id IS NOT NULL AND reviewed_at IS NOT NULL) AS unifi_reconciled
      FROM assets a WHERE ${inScope('a')} AND a.archived_at IS NULL`, scope.slice(0, 2));

    // Tempo de detecção: da primeira observação offline do episódio até a abertura no Malha.
    const { rows: [detection] } = await tx.query<{ episodes: string; median: number | null; p90: number | null }>(`
      SELECT count(*) AS episodes,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.opened_at - o.first_observed_at) / 60) AS median,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM o.opened_at - o.first_observed_at) / 60) AS p90
      FROM occurrences o WHERE ${inScope('o')} AND o.rule IN ('asset_offline', 'collector_silent')
        AND o.first_observed_at IS NOT NULL AND o.opened_at >= now() - make_interval(days => $3)`, scope);

    const { rows: [acknowledgement] } = await tx.query<{ acknowledged: string; median: number | null; pending: string }>(`
      SELECT count(*) FILTER (WHERE o.acknowledged_at IS NOT NULL) AS acknowledged,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.acknowledged_at - o.opened_at) / 60)
          FILTER (WHERE o.acknowledged_at IS NOT NULL) AS median,
        count(*) FILTER (WHERE o.acknowledged_at IS NULL AND o.resolved_at IS NULL) AS pending
      FROM occurrences o WHERE ${inScope('o')} AND o.opened_at >= now() - make_interval(days => $3)`, scope);

    const { rows: [baseline] } = await tx.query<{ diagnosis_minutes: number; travel_hours: string; cost_per_hour: string; cost_per_trip: string; defined_at: Date }>(
      'SELECT diagnosis_minutes, travel_hours, cost_per_hour, cost_per_trip, defined_at FROM baselines WHERE org_id = $1', [user.orgId]);
    const { rows: services } = await tx.query<{
      id: string; farm_id: string; attended_at: Date; diagnosis_minutes: number; trip_avoided: boolean; notes: string | null; title: string | null;
    }>(`SELECT s.id, s.farm_id, s.attended_at, s.diagnosis_minutes, s.trip_avoided, s.notes, o.title
      FROM service_records s LEFT JOIN occurrences o ON o.org_id = s.org_id AND o.id = s.occurrence_id
      WHERE ${inScope('s')} AND s.attended_at >= now() - make_interval(days => $3) ORDER BY s.attended_at DESC`, scope);

    const tripsAvoided = services.filter((service) => service.trip_avoided).length;
    const diagnosisMinutes = services.reduce((sum, service) => sum + service.diagnosis_minutes, 0);
    const savedBaseline = baseline && {
      diagnosisMinutes: baseline.diagnosis_minutes, travelHours: Number(baseline.travel_hours),
      costPerHour: Number(baseline.cost_per_hour), costPerTrip: Number(baseline.cost_per_trip), definedAt: new Date(baseline.defined_at).toISOString(),
    };
    let hoursSaved: number | null = null;
    let costSaved: number | null = null;
    if (savedBaseline && services.length) {
      const diagnosisSaved = services.reduce((sum, service) => sum + Math.max(0, savedBaseline.diagnosisMinutes - service.diagnosis_minutes), 0) / 60;
      hoursSaved = Math.round((diagnosisSaved + tripsAvoided * savedBaseline.travelHours) * 10) / 10;
      costSaved = Math.round(hoursSaved * savedBaseline.costPerHour + tripsAvoided * savedBaseline.costPerTrip);
    }

    // Tendência semanal de ocorrências abertas por fazenda.
    const { rows: weekly } = await tx.query<{ farm_id: string; week: Date; total: string }>(`
      SELECT o.farm_id, date_trunc('week', o.opened_at) AS week, count(*) AS total
      FROM occurrences o WHERE ${inScope('o')} AND o.opened_at >= date_trunc('week', now()) - make_interval(weeks => ${Math.min(13, Math.ceil(days / 7))} - 1)
      GROUP BY 1, 2`, scope.slice(0, 2));
    const { rows: weekStarts } = await tx.query<{ week: Date }>(`SELECT generate_series(date_trunc('week', now()) - make_interval(weeks => $1 - 1),
      date_trunc('week', now()), interval '1 week') AS week`, [Math.min(13, Math.ceil(days / 7))]);
    const weeks = weekStarts.map((row) => new Date(row.week).toISOString());
    const { rows: farms } = await tx.query<{ id: string }>(`SELECT id FROM farms WHERE org_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) ORDER BY name`,
      [user.orgId, farmIds]);

    const count = (value: string | undefined) => Number(value ?? 0);
    return {
      periodDays: days,
      from: new Date(from).toISOString(),
      coverage: { eligible: count(coverage.eligible), complete: count(coverage.complete), csvOnly: count(coverage.csv_only) },
      inventory: {
        reference: count(inventory.reference), reviewed: count(inventory.reviewed), incomplete: count(inventory.incomplete),
        discoveredPending: count(inventory.discovered_pending), unifiEligible: count(inventory.unifi_eligible), unifiReconciled: count(inventory.unifi_reconciled),
      },
      detection: { episodes: count(detection.episodes), medianMinutes: minutes(detection.median), p90Minutes: minutes(detection.p90) },
      acknowledgement: { acknowledged: count(acknowledgement.acknowledged), medianMinutes: minutes(acknowledgement.median), pending: count(acknowledgement.pending) },
      savings: { baseline: savedBaseline ?? null, services: services.length, diagnosisMinutes, tripsAvoided, hoursSaved, costSaved },
      weekly: {
        weeks,
        farms: farms.map((farm) => ({
          farmId: farm.id,
          counts: weeks.map((week) => count(weekly.find((row) => row.farm_id === farm.id && new Date(row.week).toISOString() === week)?.total)),
        })),
      },
      services: services.slice(0, 50).map((service) => ({
        id: service.id, farmId: service.farm_id, attendedAt: new Date(service.attended_at).toISOString(), diagnosisMinutes: service.diagnosis_minutes,
        tripAvoided: service.trip_avoided, notes: service.notes, occurrenceTitle: service.title,
      })),
    };
  });
}
