import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { farmAllowed, requireFarm, requirePermission } from './authz';
import { setOrg, type Database, type Queryable } from './db';
import { CAPTURE_STALE_SECONDS, HEARTBEAT_TIMEOUT_SECONDS } from './health';
import { HttpError, uuidPattern } from './http';
import type { Principal } from './identity';
import { normalizedMac } from './network';

/** Junção com o coletor ativo da fazenda, usada para derivar o estado exibido do ativo. */
export const ASSET_FROM = `assets a
  LEFT JOIN collector_keys k ON k.org_id = a.org_id AND k.farm_id = a.farm_id AND k.revoked_at IS NULL
  LEFT JOIN collector_health h ON h.org_id = k.org_id AND h.farm_id = k.farm_id AND h.collector_id = k.collector_id
  LEFT JOIN technical_locations l ON l.org_id = a.org_id AND l.farm_id = a.farm_id AND l.id = a.location_id`;

/**
 * Uma observação só vale como estado atual se for recente, do coletor ativo e com o coletor em contato.
 * Caso contrário o estado fica indeterminado e a última observação continua visível com sua data.
 */
export const ASSET_STATUS = `CASE WHEN a.last_observed_at >= now() - make_interval(secs => ${CAPTURE_STALE_SECONDS})
    AND a.last_collector_id = k.collector_id AND h.last_heartbeat_at >= now() - make_interval(secs => ${HEARTBEAT_TIMEOUT_SECONDS})
  THEN a.status ELSE 'unknown' END`;

export type InventoryAsset = {
  id: string;
  farmId: string;
  name: string;
  category: string;
  tag: string | null;
  ip: string | null;
  mac: string | null;
  model: string | null;
  firmware: string | null;
  critical: boolean;
  source: 'csv' | 'unifi' | 'manual';
  status: 'online' | 'offline' | 'unknown';
  lastObservedAt: string | null;
  locationId: string | null;
  locationName: string | null;
  owner: string | null;
  maintenanceUntil: string | null;
  archivedAt: string | null;
};

type AssetRow = {
  id: string; farm_id: string; name: string; category: string; tag: string | null; ip: string | null; mac: string | null;
  model: string | null; firmware: string | null; critical: boolean; source: InventoryAsset['source']; status: InventoryAsset['status'];
  last_observed_at: Date | null; location_id: string | null; location_name: string | null; owner: string | null;
  maintenance_until: Date | null; archived_at: Date | null;
};

const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;
const ASSET_COLUMNS = `a.id, a.farm_id, a.name, a.category, a.tag, a.ip, a.mac, a.model, a.firmware, a.critical, a.source,
  ${ASSET_STATUS} AS status, a.last_observed_at, a.location_id, l.name AS location_name, a.owner, a.maintenance_until, a.archived_at`;

function toAsset(row: AssetRow): InventoryAsset {
  return {
    id: row.id, farmId: row.farm_id, name: row.name, category: row.category, tag: row.tag, ip: row.ip, mac: row.mac,
    model: row.model, firmware: row.firmware, critical: row.critical, source: row.source, status: row.status,
    lastObservedAt: iso(row.last_observed_at), locationId: row.location_id, locationName: row.location_name, owner: row.owner,
    maintenanceUntil: iso(row.maintenance_until), archivedAt: iso(row.archived_at),
  };
}

const PAGE_SIZE = 25;
const listSchema = z.object({
  farmId: z.string().regex(uuidPattern).optional(),
  q: z.string().max(120).optional(),
  source: z.enum(['csv', 'unifi', 'manual']).optional(),
  status: z.enum(['online', 'offline', 'unknown']).optional(),
  archived: z.enum(['0', '1']).optional(),
  cursor: z.string().max(400).optional(),
});

function decodeCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const cursor = z.object({ name: z.string().max(200), id: z.string().regex(uuidPattern) })
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return cursor;
  } catch {
    throw new HttpError(400, 'Página inválida.');
  }
}

const likePattern = (value: string) => `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

/** Lista ativos com filtro e paginação por cursor (nome, id) no servidor. */
export async function listAssets(database: Database, user: Principal, params: URLSearchParams) {
  const parsed = listSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new HttpError(400, 'Filtro de inventário inválido.');
  const filter = parsed.data;
  if (filter.farmId) requireFarm(user, filter.farmId);
  const cursor = decodeCursor(filter.cursor);
  const query = filter.q?.trim();
  const args = [user.orgId, filter.farmId ? [filter.farmId] : user.farmIds, query ? likePattern(query.toLowerCase()) : null,
    filter.source ?? null, filter.status ?? null, filter.archived === '1'];
  const where = `a.org_id = $1 AND ($2::uuid[] IS NULL OR a.farm_id = ANY($2::uuid[]))
    AND ($3::text IS NULL OR lower(a.name) LIKE $3 OR lower(a.category) LIKE $3 OR lower(coalesce(a.tag, '')) LIKE $3
      OR lower(coalesce(a.ip, '')) LIKE $3 OR lower(coalesce(a.mac, '')) LIKE $3 OR lower(coalesce(a.owner, '')) LIKE $3
      OR lower(coalesce(a.external_id, '')) LIKE $3)
    AND ($4::text IS NULL OR a.source = $4) AND ($5::text IS NULL OR ${ASSET_STATUS} = $5)
    AND (a.archived_at IS NOT NULL) = $6`;
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows: [{ total }] } = await tx.query<{ total: string | number }>(`SELECT count(*) AS total FROM ${ASSET_FROM} WHERE ${where}`, args);
    const { rows } = await tx.query<AssetRow>(`SELECT ${ASSET_COLUMNS} FROM ${ASSET_FROM} WHERE ${where}
      AND ($7::text IS NULL OR (a.name, a.id) > ($7::text, $8::uuid))
      ORDER BY a.name, a.id LIMIT ${PAGE_SIZE + 1}`, [...args, cursor?.name ?? null, cursor?.id ?? null]);
    const page = rows.slice(0, PAGE_SIZE).map(toAsset);
    const last = page.at(-1);
    return {
      items: page,
      total: Number(total),
      nextCursor: rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ name: last.name, id: last.id })).toString('base64url') : null,
    };
  });
}

const text = (max: number) => z.string().trim().max(max).refine((value) => !/[\x00-\x1F\x7F]/.test(value), 'Caracteres de controle.');
const optionalText = (max: number) => text(max).nullish().transform((value) => value || null);
const assetFields = z.object({
  name: text(160).min(1),
  category: text(80).min(1),
  tag: optionalText(80).transform((value) => value?.toUpperCase() ?? null),
  critical: z.boolean(),
  ip: optionalText(80).refine((value) => !value || isIP(value) !== 0, 'IP inválido.'),
  mac: optionalText(50).refine((value) => !value || normalizedMac(value) !== null, 'MAC inválido.')
    .transform((value) => value ? normalizedMac(value) : null),
  owner: optionalText(120),
  locationId: z.string().regex(uuidPattern).nullish().transform((value) => value ?? null),
  newLocation: optionalText(80),
  maintenanceUntil: z.iso.datetime({ offset: true }).nullish().transform((value) => value ?? null),
});
const createSchema = assetFields.extend({ farmId: z.string().regex(uuidPattern) });

function invalid(error: z.ZodError): never {
  const field = error.issues[0]?.path.join('.') ?? 'dados';
  throw new HttpError(400, `Revise o campo ${field}.`);
}

async function resolveLocation(tx: Queryable, orgId: string, farmId: string, locationId: string | null, newLocation: string | null) {
  if (newLocation) {
    const { rows: [location] } = await tx.query<{ id: string }>(`INSERT INTO technical_locations (org_id, farm_id, id, name)
      VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, farm_id, name) DO UPDATE SET name = excluded.name RETURNING id`,
    [orgId, farmId, randomUUID(), newLocation]);
    return location.id;
  }
  if (!locationId) return null;
  const { rows } = await tx.query('SELECT 1 FROM technical_locations WHERE org_id = $1 AND farm_id = $2 AND id = $3', [orgId, farmId, locationId]);
  if (!rows.length) throw new HttpError(400, 'Local técnico indisponível nesta fazenda.');
  return locationId;
}

function uniqueViolation(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && error.code === '23505';
}

async function audit(tx: Queryable, user: Principal, action: string, scope: object) {
  await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [randomUUID(), user.orgId, user.actor, action, JSON.stringify(scope)]);
}

async function readAsset(tx: Queryable, orgId: string, id: string) {
  const { rows: [row] } = await tx.query<AssetRow>(`SELECT ${ASSET_COLUMNS} FROM ${ASSET_FROM} WHERE a.org_id = $1 AND a.id = $2`, [orgId, id]);
  return toAsset(row);
}

export async function createAsset(database: Database, user: Principal, body: unknown) {
  requirePermission(user, 'inventory.write');
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) invalid(parsed.error);
  const data = parsed.data;
  requireFarm(user, data.farmId);
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows: farm } = await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2', [user.orgId, data.farmId]);
    if (!farm.length) throw new HttpError(404, 'Fazenda indisponível.');
    const locationId = await resolveLocation(tx, user.orgId, data.farmId, data.locationId, data.newLocation);
    const id = randomUUID();
    await tx.exec('SAVEPOINT create_asset');
    try {
      await tx.query(`INSERT INTO assets (org_id, farm_id, id, name, category, tag, critical, ip, mac, source, owner, location_id, maintenance_until)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10, $11, $12)`,
      [user.orgId, data.farmId, id, data.name, data.category, data.tag, data.critical, data.ip, data.mac, data.owner, locationId, data.maintenanceUntil]);
    } catch (error) {
      await tx.exec('ROLLBACK TO SAVEPOINT create_asset');
      if (uniqueViolation(error)) throw new HttpError(409, 'Já existe um ativo com esta etiqueta na fazenda.');
      throw error;
    }
    await audit(tx, user, 'asset.create', { farmId: data.farmId, assetId: id });
    return readAsset(tx, user.orgId, id);
  });
}

async function lockAsset(tx: Queryable, user: Principal, id: string) {
  if (!uuidPattern.test(id)) throw new HttpError(404, 'Ativo não encontrado.');
  const { rows: [current] } = await tx.query<{ farm_id: string; source: InventoryAsset['source']; name: string; archived_at: Date | null }>(
    'SELECT farm_id, source, name, archived_at FROM assets WHERE org_id = $1 AND id = $2 FOR UPDATE', [user.orgId, id]);
  if (!current || !farmAllowed(user, current.farm_id)) throw new HttpError(404, 'Ativo não encontrado.');
  return current;
}

export async function updateAsset(database: Database, user: Principal, id: string, body: unknown) {
  requirePermission(user, 'inventory.write');
  const parsed = assetFields.safeParse(body);
  if (!parsed.success) invalid(parsed.error);
  const data = parsed.data;
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const current = await lockAsset(tx, user, id);
    // O nome de um ativo UniFi vem da controladora e seria sobrescrito na próxima captura.
    if (current.source === 'unifi' && data.name !== current.name) {
      throw new HttpError(400, 'O nome de um ativo UniFi vem da controladora. Altere-o na console.');
    }
    const locationId = await resolveLocation(tx, user.orgId, current.farm_id, data.locationId, data.newLocation);
    await tx.exec('SAVEPOINT update_asset');
    try {
      // IP e MAC de ativos observados vêm da coleta; o cadastro só os define quando não há observação.
      await tx.query(`UPDATE assets SET name = $3, category = $4, tag = $5, critical = $6, owner = $7, location_id = $8, maintenance_until = $9,
          ip = CASE WHEN external_id IS NULL THEN $10 ELSE ip END, mac = CASE WHEN external_id IS NULL THEN $11 ELSE mac END
        WHERE org_id = $1 AND id = $2`,
      [user.orgId, id, data.name, data.category, data.tag, data.critical, data.owner, locationId, data.maintenanceUntil, data.ip, data.mac]);
    } catch (error) {
      await tx.exec('ROLLBACK TO SAVEPOINT update_asset');
      if (uniqueViolation(error)) throw new HttpError(409, 'Já existe um ativo com esta etiqueta na fazenda.');
      throw error;
    }
    await audit(tx, user, 'asset.update', { farmId: current.farm_id, assetId: id });
    return readAsset(tx, user.orgId, id);
  });
}

export async function setAssetArchived(database: Database, user: Principal, id: string, body: unknown) {
  requirePermission(user, 'inventory.write');
  const parsed = z.object({ archived: z.boolean() }).safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Informe se o ativo deve ser arquivado.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const current = await lockAsset(tx, user, id);
    if ((current.archived_at !== null) !== parsed.data.archived) {
      await tx.query(`UPDATE assets SET archived_at = CASE WHEN $3::boolean THEN now() END WHERE org_id = $1 AND id = $2`, [user.orgId, id, parsed.data.archived]);
      await audit(tx, user, parsed.data.archived ? 'asset.archive' : 'asset.restore', { farmId: current.farm_id, assetId: id });
    }
    return readAsset(tx, user.orgId, id);
  });
}
