import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireFarm, requirePermission, ROLES, type Role } from './authz';
import { hash, setOrg, type Database, type Queryable } from './db';
import { HEARTBEAT_TIMEOUT_SECONDS } from './health';
import { HttpError, uuidPattern } from './http';
import type { Principal } from './identity';

const ENROLLMENT_MINUTES = 15;

async function audit(tx: Queryable, orgId: string, actor: string, action: string, scope: object) {
  await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [randomUUID(), orgId, actor, action, JSON.stringify(scope)]);
}

const plain = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\x00-\x1F\x7F]/.test(value));
const timezones = new Set(Intl.supportedValuesOf('timeZone'));
const farmSchema = z.object({
  name: plain(120),
  location: plain(120),
  timezone: z.string().refine((value) => timezones.has(value), 'Fuso horário inválido.').default('America/Cuiaba'),
});

function parse<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, message);
  return parsed.data;
}

// Fazendas

export async function createFarm(database: Database, user: Principal, body: unknown) {
  requirePermission(user, 'farms.manage');
  const data = parse(farmSchema, body, 'Informe nome, localização e fuso horário válidos.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const id = randomUUID();
    await tx.query('INSERT INTO farms (org_id, id, name, location, timezone) VALUES ($1, $2, $3, $4, $5)',
      [user.orgId, id, data.name, data.location, data.timezone]);
    await audit(tx, user.orgId, user.actor, 'farm.create', { farmId: id });
    return { id };
  });
}

export async function updateFarm(database: Database, user: Principal, farmId: string, body: unknown) {
  requirePermission(user, 'farms.manage');
  if (!uuidPattern.test(farmId)) throw new HttpError(404, 'Fazenda indisponível.');
  const data = parse(farmSchema, body, 'Informe nome, localização e fuso horário válidos.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query('UPDATE farms SET name = $3, location = $4, timezone = $5 WHERE org_id = $1 AND id = $2 RETURNING id',
      [user.orgId, farmId, data.name, data.location, data.timezone]);
    if (!rows.length) throw new HttpError(404, 'Fazenda indisponível.');
    await audit(tx, user.orgId, user.actor, 'farm.update', { farmId });
    return { id: farmId };
  });
}

// Coletores

/** Gera um código de uso único válido por 15 minutos. Só o hash fica no banco. */
export async function issueEnrollmentCode(tx: Queryable, orgId: string, farmId: string, actor: string) {
  const code = randomBytes(32).toString('base64url');
  const { rows: farms } = await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, farmId]);
  if (!farms.length) throw new HttpError(404, 'Fazenda indisponível.');
  const { rows: active } = await tx.query('SELECT 1 FROM collector_keys WHERE org_id = $1 AND farm_id = $2 AND revoked_at IS NULL', [orgId, farmId]);
  if (active.length) throw new HttpError(409, 'Já existe um coletor ativo nesta fazenda. Revogue a chave para substituí-lo.');
  await tx.query('DELETE FROM enrollment_codes WHERE org_id = $1 AND farm_id = $2', [orgId, farmId]);
  const { rows: [{ expires_at: expiresAt }] } = await tx.query<{ expires_at: Date }>(`INSERT INTO enrollment_codes (code_hash, org_id, farm_id, expires_at)
    VALUES ($1, $2, $3, now() + make_interval(mins => ${ENROLLMENT_MINUTES})) RETURNING expires_at`, [hash(code), orgId, farmId]);
  await audit(tx, orgId, actor, 'collector.enrollment_code', { farmId });
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export async function revokeCollectorKey(tx: Queryable, orgId: string, farmId: string, actor: string) {
  const { rows } = await tx.query<{ collector_id: string }>(`UPDATE collector_keys SET revoked_at = now()
    WHERE org_id = $1 AND farm_id = $2 AND revoked_at IS NULL RETURNING collector_id`, [orgId, farmId]);
  if (!rows.length) throw new HttpError(404, 'Nenhum coletor ativo nesta fazenda.');
  await audit(tx, orgId, actor, 'collector.revoke', { farmId, collectorId: rows[0].collector_id });
  return { collectorId: rows[0].collector_id };
}

export async function createEnrollment(database: Database, user: Principal, farmId: string) {
  requirePermission(user, 'collectors.enroll');
  if (!uuidPattern.test(farmId)) throw new HttpError(404, 'Fazenda indisponível.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    return issueEnrollmentCode(tx, user.orgId, farmId, user.actor);
  });
}

export async function revokeCollector(database: Database, user: Principal, farmId: string) {
  requirePermission(user, 'collectors.enroll');
  if (!uuidPattern.test(farmId)) throw new HttpError(404, 'Fazenda indisponível.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    return revokeCollectorKey(tx, user.orgId, farmId, user.actor);
  });
}

export type IntegrationFarm = {
  farmId: string;
  collectorId: string | null;
  version: string | null;
  healthy: boolean | null;
  queueDepth: number | null;
  lastHeartbeatAt: string | null;
  lastCaptureAt: string | null;
  online: boolean;
  firstCaptureReceived: boolean;
  pendingCodeExpiresAt: string | null;
  clockSkewSeconds: number | null;
};

const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;

export async function listIntegrations(database: Database, user: Principal): Promise<IntegrationFarm[]> {
  requirePermission(user, 'integrations.read');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query<{
      farm_id: string; collector_id: string | null; version: string | null; healthy: boolean | null; queue_depth: number | null;
      last_heartbeat_at: Date | null; last_capture_at: Date | null; online: boolean | null; code_expires_at: Date | null; clock_skew_seconds: number | null;
    }>(`SELECT f.id AS farm_id, k.collector_id, h.version, h.healthy, h.queue_depth, h.last_heartbeat_at, h.last_capture_at, h.clock_skew_seconds,
        h.last_heartbeat_at >= now() - make_interval(secs => ${HEARTBEAT_TIMEOUT_SECONDS}) AS online,
        (SELECT max(c.expires_at) FROM enrollment_codes c WHERE c.org_id = f.org_id AND c.farm_id = f.id
          AND c.used_key_id IS NULL AND c.expires_at > now()) AS code_expires_at
      FROM farms f LEFT JOIN collector_keys k ON k.org_id = f.org_id AND k.farm_id = f.id AND k.revoked_at IS NULL
      LEFT JOIN collector_health h ON h.org_id = k.org_id AND h.farm_id = k.farm_id AND h.collector_id = k.collector_id
      WHERE f.org_id = $1 AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[])) ORDER BY f.name`, [user.orgId, user.farmIds]);
    return rows.map((row) => ({
      farmId: row.farm_id, collectorId: row.collector_id, version: row.version, healthy: row.healthy, queueDepth: row.queue_depth,
      lastHeartbeatAt: iso(row.last_heartbeat_at), lastCaptureAt: iso(row.last_capture_at), online: Boolean(row.online),
      firstCaptureReceived: Boolean(row.last_capture_at), pendingCodeExpiresAt: user.role === 'admin' ? iso(row.code_expires_at) : null,
      clockSkewSeconds: row.clock_skew_seconds,
    }));
  });
}

// Membros

export type Member = { oid: string; displayName: string | null; role: Role; active: boolean; farmIds: string[] };

export async function listMembers(database: Database, user: Principal): Promise<Member[]> {
  requirePermission(user, 'members.manage');
  const { rows } = await database.query<{ entra_oid: string; display_name: string | null; role: Role; active: boolean; farm_ids: string[] | null }>(`
    SELECT m.entra_oid, m.display_name, m.role, m.active,
      (SELECT array_agg(mf.farm_id ORDER BY mf.farm_id) FROM membership_farms mf WHERE mf.org_id = m.org_id AND mf.entra_oid = m.entra_oid) AS farm_ids
    FROM memberships m WHERE m.org_id = $1 ORDER BY m.active DESC, coalesce(m.display_name, m.entra_oid::text)`, [user.orgId]);
  return rows.map((row) => ({ oid: row.entra_oid, displayName: row.display_name, role: row.role, active: row.active, farmIds: row.farm_ids ?? [] }));
}

const memberSchema = z.object({
  displayName: z.string().trim().max(120).refine((value) => !/[\x00-\x1F\x7F]/.test(value)).nullish().transform((value) => value || null),
  role: z.enum(ROLES),
  farmIds: z.array(z.string().regex(uuidPattern)).max(500).default([]),
});

async function assertAnotherAdmin(tx: Queryable, orgId: string, oid: string) {
  const { rows } = await tx.query(`SELECT 1 FROM memberships WHERE org_id = $1 AND entra_oid <> $2 AND role = 'admin' AND active`, [orgId, oid]);
  if (!rows.length) throw new HttpError(409, 'O grupo precisa de ao menos um admin ativo.');
}

/** Cria ou atualiza um membro pelo object ID do Entra ID. A troca de papel vale na próxima requisição. */
export async function saveMember(database: Database, user: Principal, oid: string, body: unknown) {
  requirePermission(user, 'members.manage');
  if (!uuidPattern.test(oid)) throw new HttpError(400, 'Informe o object ID (OID) do usuário no Entra ID.');
  const normalizedOid = oid.toLowerCase();
  const data = parse(memberSchema, body, 'Revise o papel e as fazendas do membro.');
  if (data.role === 'tecnico' && !data.farmIds.length) throw new HttpError(400, 'Atribua ao menos uma fazenda ao técnico.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const farmIds = [...new Set(data.farmIds.map((id) => id.toLowerCase()))];
    for (const farmId of farmIds) requireFarm(user, farmId);
    if (farmIds.length) {
      const { rows } = await tx.query('SELECT id FROM farms WHERE org_id = $1 AND id = ANY($2::uuid[])', [user.orgId, farmIds]);
      if (rows.length !== farmIds.length) throw new HttpError(400, 'Uma das fazendas não pertence ao grupo.');
    }
    const { rows: [current] } = await tx.query<{ role: Role; active: boolean }>(
      'SELECT role, active FROM memberships WHERE org_id = $1 AND entra_oid = $2 FOR UPDATE', [user.orgId, normalizedOid]);
    if (current?.role === 'admin' && current.active && data.role !== 'admin') await assertAnotherAdmin(tx, user.orgId, normalizedOid);
    await tx.query(`INSERT INTO memberships (org_id, entra_oid, role, display_name) VALUES ($1, $2, $3, $4)
      ON CONFLICT (org_id, entra_oid) DO UPDATE SET role = excluded.role, display_name = excluded.display_name, active = true`,
    [user.orgId, normalizedOid, data.role, data.displayName]);
    await tx.query('DELETE FROM membership_farms WHERE org_id = $1 AND entra_oid = $2', [user.orgId, normalizedOid]);
    if (data.role !== 'admin' && farmIds.length) {
      await tx.query(`INSERT INTO membership_farms (org_id, entra_oid, farm_id) SELECT $1, $2, unnest($3::uuid[])`,
        [user.orgId, normalizedOid, farmIds]);
    }
    await audit(tx, user.orgId, user.actor, current ? 'member.update' : 'member.create', { oid: normalizedOid, role: data.role, farmIds });
    return { oid: normalizedOid };
  });
}

/** Desativa o membro e encerra as sessões abertas no Malha. */
export async function deactivateMember(database: Database, user: Principal, oid: string) {
  requirePermission(user, 'members.manage');
  if (!uuidPattern.test(oid)) throw new HttpError(404, 'Membro não encontrado.');
  const normalizedOid = oid.toLowerCase();
  if (normalizedOid === user.actor) throw new HttpError(409, 'Peça a outro admin para desativar o seu acesso.');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows: [current] } = await tx.query<{ role: Role; active: boolean }>(
      'SELECT role, active FROM memberships WHERE org_id = $1 AND entra_oid = $2 FOR UPDATE', [user.orgId, normalizedOid]);
    if (!current) throw new HttpError(404, 'Membro não encontrado.');
    if (current.role === 'admin' && current.active) await assertAnotherAdmin(tx, user.orgId, normalizedOid);
    await tx.query('UPDATE memberships SET active = false WHERE org_id = $1 AND entra_oid = $2', [user.orgId, normalizedOid]);
    await tx.query('DELETE FROM sessions WHERE org_id = $1 AND entra_oid = $2', [user.orgId, normalizedOid]);
    await audit(tx, user.orgId, user.actor, 'member.deactivate', { oid: normalizedOid });
    return { oid: normalizedOid };
  });
}
