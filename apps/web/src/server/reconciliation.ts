import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ASSET_FROM, ASSET_STATUS } from './assets';
import { farmAllowed, requirePermission } from './authz';
import { setOrg, type Database, type Queryable } from './db';
import { HttpError, uuidPattern } from './http';
import type { Principal } from './identity';

export type ReviewItem = {
  id: string; farmId: string; name: string; category: string; tag: string | null; mac: string | null; ip: string | null;
  model: string | null; source: 'csv' | 'unifi' | 'manual'; status: 'online' | 'offline' | 'unknown'; locationName: string | null;
  lastObservedAt: string | null; incomplete: boolean;
};

export type ReconciliationQueue = {
  discovered: ReviewItem[];
  links: ReviewItem[];
  reference: ReviewItem[];
  counts: { discovered: number; links: number; reference: number; incomplete: number };
};

const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;
const LIMIT = 100;

/**
 * Três filas: dispositivos descobertos pela coleta sem cadastro, vínculos automáticos por MAC ainda não
 * confirmados e itens do cadastro de referência que ninguém conferiu. Cadastro incompleto não tem etiqueta ou local.
 */
export async function reconciliationQueue(database: Database, user: Principal): Promise<ReconciliationQueue> {
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const base = `a.org_id = $1 AND ($2::uuid[] IS NULL OR a.farm_id = ANY($2::uuid[])) AND a.archived_at IS NULL AND a.reviewed_at IS NULL`;
    const queues = {
      discovered: `${base} AND a.source = 'unifi'`,
      links: `${base} AND a.source <> 'unifi' AND a.external_id IS NOT NULL`,
      reference: `${base} AND a.source <> 'unifi' AND a.external_id IS NULL`,
    };
    const scope = [user.orgId, user.farmIds];
    const result = { counts: { discovered: 0, links: 0, reference: 0, incomplete: 0 } } as ReconciliationQueue;
    for (const [key, where] of Object.entries(queues) as Array<[keyof typeof queues, string]>) {
      const { rows } = await tx.query<{
        id: string; farm_id: string; name: string; category: string; tag: string | null; mac: string | null; ip: string | null;
        model: string | null; source: ReviewItem['source']; status: ReviewItem['status']; location_name: string | null;
        last_observed_at: Date | null; incomplete: boolean; total: string;
      }>(`SELECT a.id, a.farm_id, a.name, a.category, a.tag, a.mac, a.ip, a.model, a.source, ${ASSET_STATUS} AS status,
          l.name AS location_name, a.last_observed_at, (a.tag IS NULL OR a.location_id IS NULL) AS incomplete, count(*) OVER () AS total
        FROM ${ASSET_FROM} WHERE ${where} ORDER BY a.farm_id, a.name, a.id LIMIT ${LIMIT}`, scope);
      result[key] = rows.map((row) => ({
        id: row.id, farmId: row.farm_id, name: row.name, category: row.category, tag: row.tag, mac: row.mac, ip: row.ip, model: row.model,
        source: row.source, status: row.status, locationName: row.location_name, lastObservedAt: iso(row.last_observed_at), incomplete: row.incomplete,
      }));
      result.counts[key] = Number(rows[0]?.total ?? 0);
    }
    const { rows: [{ incomplete }] } = await tx.query<{ incomplete: string }>(`SELECT count(*) AS incomplete FROM assets a
      WHERE a.org_id = $1 AND ($2::uuid[] IS NULL OR a.farm_id = ANY($2::uuid[])) AND a.archived_at IS NULL AND a.source <> 'unifi'
        AND (a.tag IS NULL OR a.location_id IS NULL)`, scope);
    result.counts.incomplete = Number(incomplete);
    return result;
  });
}

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), assetId: z.string().regex(uuidPattern) }),
  z.object({ action: z.literal('unlink'), assetId: z.string().regex(uuidPattern) }),
  z.object({ action: z.literal('merge'), assetId: z.string().regex(uuidPattern), targetId: z.string().regex(uuidPattern) }),
]);

type Locked = { id: string; farm_id: string; source: string; external_id: string | null; archived_at: Date | null };

async function lock(tx: Queryable, user: Principal, id: string) {
  const { rows: [row] } = await tx.query<Locked>(`SELECT id, farm_id, source, external_id, archived_at FROM assets
    WHERE org_id = $1 AND id = $2 FOR UPDATE`, [user.orgId, id]);
  if (!row || !farmAllowed(user, row.farm_id)) throw new HttpError(404, 'Ativo não encontrado.');
  return row;
}

async function audit(tx: Queryable, user: Principal, action: string, scope: object) {
  await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [randomUUID(), user.orgId, user.actor, action, JSON.stringify(scope)]);
}

export async function reconcile(database: Database, user: Principal, body: unknown) {
  requirePermission(user, 'inventory.write');
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Ação de conciliação inválida.');
  const command = parsed.data;
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const asset = await lock(tx, user, command.assetId);
    if (command.action === 'confirm') {
      await tx.query('UPDATE assets SET reviewed_at = now(), reviewed_by = $3 WHERE org_id = $1 AND id = $2', [user.orgId, asset.id, user.actor]);
      await audit(tx, user, 'reconciliation.confirm', { farmId: asset.farm_id, assetId: asset.id });
      return { assetId: asset.id };
    }
    if (command.action === 'unlink') {
      // Desfaz um vínculo automático por MAC. O dispositivo volta como descoberta na próxima captura.
      if (asset.source === 'unifi' || !asset.external_id) throw new HttpError(409, 'Este ativo não tem vínculo automático para desfazer.');
      await tx.query(`UPDATE assets SET rejected_external_ids = array_append(rejected_external_ids, external_id), external_id = NULL,
          last_collector_id = NULL, status = 'unknown', offline_observations = 0, offline_since = NULL, missing_captures = 0,
          model = NULL, firmware = NULL, reviewed_at = NULL, reviewed_by = NULL
        WHERE org_id = $1 AND id = $2`, [user.orgId, asset.id]);
      await audit(tx, user, 'reconciliation.unlink', { farmId: asset.farm_id, assetId: asset.id, externalId: asset.external_id });
      return { assetId: asset.id };
    }
    // Funde a descoberta UniFi no item do cadastro: o cadastro mantém identidade e intenção, a coleta passa a alimentá-lo.
    const target = await lock(tx, user, command.targetId);
    if (asset.source !== 'unifi' || !asset.external_id) throw new HttpError(409, 'Selecione um dispositivo descoberto pela coleta.');
    if (target.source === 'unifi' || target.external_id || target.archived_at) throw new HttpError(409, 'Selecione um item do cadastro ainda sem vínculo.');
    if (target.farm_id !== asset.farm_id) throw new HttpError(409, 'O item do cadastro precisa ser da mesma fazenda.');
    const { rows: [source] } = await tx.query<Record<string, unknown>>(`SELECT external_id, mac, ip, model, firmware, last_observed_at,
        last_collector_id, status, offline_observations, offline_since, missing_captures FROM assets WHERE org_id = $1 AND id = $2`, [user.orgId, asset.id]);
    await tx.query('UPDATE asset_observations SET asset_id = $3 WHERE org_id = $1 AND asset_id = $2', [user.orgId, asset.id, target.id]);
    await tx.query('UPDATE service_records SET asset_id = $3 WHERE org_id = $1 AND asset_id = $2', [user.orgId, asset.id, target.id]);
    await tx.query(`UPDATE occurrences SET resolved_at = now(), resolution = 'auto' WHERE org_id = $1 AND resource_id = $2 AND resolved_at IS NULL`,
      [user.orgId, asset.id]);
    await tx.query('DELETE FROM assets WHERE org_id = $1 AND id = $2', [user.orgId, asset.id]);
    await tx.query(`UPDATE assets SET external_id = $3, mac = COALESCE($4, mac), ip = COALESCE($5, ip), model = $6, firmware = $7,
        last_observed_at = $8, last_collector_id = $9, status = $10, offline_observations = $11, offline_since = $12, missing_captures = $13,
        reviewed_at = now(), reviewed_by = $14
      WHERE org_id = $1 AND id = $2`,
    [user.orgId, target.id, source.external_id, source.mac, source.ip, source.model, source.firmware, source.last_observed_at,
      source.last_collector_id, source.status, source.offline_observations, source.offline_since, source.missing_captures, user.actor]);
    await audit(tx, user, 'reconciliation.merge', { farmId: asset.farm_id, discoveredId: asset.id, assetId: target.id });
    return { assetId: target.id };
  });
}

export type TimelineEntry = { at: string; kind: 'observation' | 'occurrence' | 'change'; label: string; detail: string | null };

/** Linha do tempo do ativo: mudanças de estado, IP ou firmware observadas, ocorrências e alterações auditadas. */
export async function assetHistory(database: Database, user: Principal, assetId: string): Promise<TimelineEntry[]> {
  if (!uuidPattern.test(assetId)) throw new HttpError(404, 'Ativo não encontrado.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows: [asset] } = await tx.query<{ farm_id: string }>('SELECT farm_id FROM assets WHERE org_id = $1 AND id = $2', [user.orgId, assetId]);
    if (!asset || !farmAllowed(user, asset.farm_id)) throw new HttpError(404, 'Ativo não encontrado.');
    const { rows } = await tx.query<{ at: Date; kind: TimelineEntry['kind']; label: string; detail: string | null }>(`
      WITH observed AS (
        SELECT observed_at, status, ip, firmware,
          lag(status) OVER w AS previous_status, lag(ip) OVER w AS previous_ip, lag(firmware) OVER w AS previous_firmware
        FROM asset_observations WHERE org_id = $1 AND asset_id = $2 WINDOW w AS (ORDER BY observed_at)
      )
      SELECT * FROM (
        SELECT observed_at AS at, 'observation' AS kind,
          CASE status WHEN 'online' THEN 'Observado online' WHEN 'offline' THEN 'Observado offline' ELSE 'Estado não informado' END AS label,
          concat_ws(' · ', CASE WHEN ip IS DISTINCT FROM previous_ip THEN 'IP ' || coalesce(ip, '—') END,
            CASE WHEN firmware IS DISTINCT FROM previous_firmware THEN 'firmware ' || coalesce(firmware, '—') END) AS detail
        FROM observed WHERE previous_status IS NULL OR status IS DISTINCT FROM previous_status
          OR ip IS DISTINCT FROM previous_ip OR firmware IS DISTINCT FROM previous_firmware
        UNION ALL
        SELECT e.occurred_at, 'occurrence', CASE e.kind WHEN 'opened' THEN 'Ocorrência aberta' WHEN 'acknowledged' THEN 'Ocorrência reconhecida'
          ELSE 'Ocorrência encerrada' END, o.title
        FROM occurrence_events e JOIN occurrences o ON o.org_id = e.org_id AND o.id = e.occurrence_id
        WHERE e.org_id = $1 AND o.resource_id = $2
        UNION ALL
        SELECT occurred_at, 'change', CASE action WHEN 'asset.create' THEN 'Cadastrado' WHEN 'asset.update' THEN 'Cadastro alterado'
          WHEN 'asset.archive' THEN 'Arquivado' WHEN 'asset.restore' THEN 'Restaurado' WHEN 'reconciliation.confirm' THEN 'Conferido'
          WHEN 'reconciliation.merge' THEN 'Vinculado à coleta' WHEN 'reconciliation.unlink' THEN 'Vínculo desfeito' ELSE action END, NULL
        FROM audit_log WHERE org_id = $1 AND (scope->>'assetId' = $2::text OR scope->>'discoveredId' = $2::text)
      ) timeline ORDER BY at DESC LIMIT 60`, [user.orgId, assetId]);
    return rows.map((row) => ({ at: new Date(row.at).toISOString(), kind: row.kind, label: row.label, detail: row.detail || null }));
  });
}
