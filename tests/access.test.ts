import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createEnrollment, createFarm, deactivateMember, listIntegrations, listMembers, revokeCollector, saveMember } from '../apps/web/src/server/admin';
import { evaluateAll } from '../apps/web/src/server/alerts';
import { createAsset, listAssets, setAssetArchived, updateAsset } from '../apps/web/src/server/assets';
import { resolveFarmScope } from '../apps/web/src/server/authz';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;

async function group() {
  const orgId = randomUUID();
  const adminOid = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo']);
  await db.query(`INSERT INTO memberships (org_id, entra_oid, role) VALUES ($1, $2, 'admin')`, [orgId, adminOid]);
  const admin: Principal = { orgId, actor: adminOid, role: 'admin', farmIds: null, demo: false };
  const farmA = (await createFarm(db, admin, { name: 'Fazenda A', location: 'Sorriso · MT' })).id;
  const farmB = (await createFarm(db, admin, { name: 'Fazenda B', location: 'Sinop · MT', timezone: 'America/Sao_Paulo' })).id;
  const as = (role: Principal['role'], farmIds: string[] | null): Principal => ({ orgId, actor: randomUUID(), role, farmIds, demo: false });
  return { orgId, admin, farmA, farmB, as };
}

const asset = (farmId: string, name: string, extra: Record<string, unknown> = {}) => ({ farmId, name, category: 'Balança', critical: false, ...extra });

test('escopo de fazendas por papel', () => {
  const farm = randomUUID();
  assert.equal(resolveFarmScope('admin', [farm]), null);
  assert.deepEqual(resolveFarmScope('tecnico', null), []);
  assert.deepEqual(resolveFarmScope('tecnico', [farm]), [farm]);
  assert.equal(resolveFarmScope('ti', null), null);
  assert.deepEqual(resolveFarmScope('diretoria', [farm]), [farm]);
});

test('técnico só lê e altera ativos das fazendas atribuídas', async () => {
  const g = await group();
  const tech = g.as('tecnico', [g.farmA]);
  const own = await createAsset(db, tech, asset(g.farmA, 'Balança do armazém', { tag: 'bal-1', newLocation: 'Armazém', owner: 'Carlos' }));
  assert.equal(own.source, 'manual');
  assert.equal(own.tag, 'BAL-1');
  assert.equal(own.locationName, 'Armazém');
  await assert.rejects(createAsset(db, tech, asset(g.farmB, 'Fora do escopo')), status(404));
  const other = await createAsset(db, g.admin, asset(g.farmB, 'Câmera da portaria'));

  const visible = await listAssets(db, tech, new URLSearchParams());
  assert.deepEqual(visible.items.map((item) => item.name), ['Balança do armazém']);
  await assert.rejects(listAssets(db, tech, new URLSearchParams({ farmId: g.farmB })), status(404));
  await assert.rejects(updateAsset(db, tech, other.id, { name: 'x', category: 'y', critical: false }), status(404));
  await assert.rejects(setAssetArchived(db, tech, other.id, { archived: true }), status(404));

  const board = g.as('diretoria', null);
  assert.equal((await listAssets(db, board, new URLSearchParams())).total, 2);
  await assert.rejects(createAsset(db, board, asset(g.farmA, 'Diretoria')), status(403));

  const outsider = { ...g.admin, orgId: randomUUID() };
  await assert.rejects(updateAsset(db, outsider, own.id, { name: 'x', category: 'y', critical: false }), status(404));
});

test('inventário pagina por cursor, busca e separa arquivados', async () => {
  const g = await group();
  for (let index = 0; index < 30; index++) {
    await createAsset(db, g.admin, asset(g.farmA, `Ativo ${String(index).padStart(2, '0')}`, { tag: `T-${index}`, mac: index === 7 ? '02-00-00-00-00-07' : null }));
  }
  const first = await listAssets(db, g.admin, new URLSearchParams({ farmId: g.farmA }));
  assert.equal(first.items.length, 25);
  assert.equal(first.total, 30);
  assert.ok(first.nextCursor);
  const second = await listAssets(db, g.admin, new URLSearchParams({ farmId: g.farmA, cursor: first.nextCursor! }));
  assert.deepEqual(second.items.map((item) => item.name), ['Ativo 25', 'Ativo 26', 'Ativo 27', 'Ativo 28', 'Ativo 29']);
  assert.equal(second.nextCursor, null);

  const byMac = await listAssets(db, g.admin, new URLSearchParams({ q: '02:00:00:00:00:07' }));
  assert.deepEqual(byMac.items.map((item) => item.name), ['Ativo 07']);
  const wildcard = await listAssets(db, g.admin, new URLSearchParams({ q: '%' }));
  assert.equal(wildcard.total, 0, 'curingas do LIKE são tratados como texto');

  await setAssetArchived(db, g.admin, byMac.items[0].id, { archived: true });
  assert.equal((await listAssets(db, g.admin, new URLSearchParams({ farmId: g.farmA }))).total, 29);
  const archived = await listAssets(db, g.admin, new URLSearchParams({ archived: '1' }));
  assert.deepEqual(archived.items.map((item) => item.name), ['Ativo 07']);
  await assert.rejects(listAssets(db, g.admin, new URLSearchParams({ cursor: 'invalido' })), status(400));
});

test('edição valida etiqueta única, preserva o nome UniFi e audita', async () => {
  const g = await group();
  const first = await createAsset(db, g.admin, asset(g.farmA, 'Tablet 1', { tag: 'TAB-1' }));
  await createAsset(db, g.admin, asset(g.farmA, 'Tablet 2', { tag: 'TAB-2' }));
  await assert.rejects(updateAsset(db, g.admin, first.id, { name: 'Tablet 1', category: 'Tablet', tag: 'TAB-2', critical: false }), status(409));
  await assert.rejects(createAsset(db, g.admin, asset(g.farmA, 'IP ruim', { ip: '999.1.1.1' })), status(400));

  const until = new Date(Date.now() + 3600_000).toISOString();
  const updated = await updateAsset(db, g.admin, first.id, { name: 'Tablet do talhão', category: 'Tablet', tag: 'TAB-1', critical: true,
    owner: 'Equipe de campo', maintenanceUntil: until });
  assert.equal(updated.name, 'Tablet do talhão');
  assert.equal(updated.maintenanceUntil, until);

  const unifiId = randomUUID();
  await db.transaction(async (tx) => {
    await setOrg(tx, g.orgId);
    await tx.query(`INSERT INTO assets (org_id, farm_id, id, name, category, source, external_id) VALUES ($1, $2, $3, 'AP portaria', 'AP', 'unifi', 'ext-1')`,
      [g.orgId, g.farmA, unifiId]);
  });
  await assert.rejects(updateAsset(db, g.admin, unifiId, { name: 'Outro nome', category: 'AP', critical: false }), status(400));
  const critical = await updateAsset(db, g.admin, unifiId, { name: 'AP portaria', category: 'AP', critical: true });
  assert.equal(critical.critical, true);

  const { rows } = await db.transaction(async (tx) => {
    await setOrg(tx, g.orgId);
    return tx.query<{ action: string }>(`SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'asset.%' ORDER BY occurred_at`, [g.orgId]);
  });
  assert.deepEqual(rows.map((row) => row.action), ['asset.create', 'asset.create', 'asset.update', 'asset.update']);
});

test('arquivamento encerra o alerta do ativo e manutenção suspende o e-mail', async () => {
  const g = await group();
  const collectorId = randomUUID();
  const archivedId = randomUUID();
  const maintenanceId = randomUUID();
  await db.transaction(async (tx) => {
    await setOrg(tx, g.orgId);
    await tx.query(`INSERT INTO collector_keys (org_id, farm_id, key_id, collector_id, public_key) VALUES ($1, $2, $3, $4, '{}')`, [g.orgId, g.farmA, randomUUID(), collectorId]);
    await tx.query(`INSERT INTO collector_health (org_id, farm_id, collector_id, last_heartbeat_at, last_capture_at) VALUES ($1, $2, $3, now(), now())`, [g.orgId, g.farmA, collectorId]);
    await tx.query('INSERT INTO alert_recipients (org_id, email) VALUES ($1, $2)', [g.orgId, 'ti@example.com']);
    for (const [id, name, maintenance] of [[archivedId, 'Switch', null], [maintenanceId, 'Gateway', 'now() + interval \'1 hour\'']] as const) {
      await tx.query(`INSERT INTO assets (org_id, farm_id, id, name, category, critical, source, external_id, status, last_observed_at, last_collector_id, maintenance_until)
        VALUES ($1, $2, $3, $4, 'Rede', true, 'unifi', $5, 'offline', now(), $6, ${maintenance ?? 'NULL'})`, [g.orgId, g.farmA, id, name, randomUUID(), collectorId]);
    }
  });
  await evaluateAll(db);
  await setAssetArchived(db, g.admin, archivedId, { archived: true });
  await evaluateAll(db);
  const { rows } = await db.transaction(async (tx) => {
    await setOrg(tx, g.orgId);
    return tx.query<{ resource_id: string; resolved: boolean; notified: boolean }>(`SELECT o.resource_id, o.resolved_at IS NOT NULL AS resolved,
        EXISTS (SELECT 1 FROM notifications n WHERE n.org_id = o.org_id AND n.occurrence_id = o.id) AS notified
      FROM occurrences o WHERE o.org_id = $1`, [g.orgId]);
  });
  const archived = rows.find((row) => row.resource_id === archivedId)!;
  const maintenance = rows.find((row) => row.resource_id === maintenanceId)!;
  assert.equal(archived.resolved, true);
  assert.equal(maintenance.resolved, false);
  assert.equal(maintenance.notified, false);
});

test('admin gerencia fazendas, coletores e membros com salvaguardas', async () => {
  const g = await group();
  const ti = g.as('ti', null);
  await assert.rejects(createFarm(db, ti, { name: 'X', location: 'Y' }), status(403));
  await assert.rejects(createFarm(db, g.admin, { name: 'X', location: 'Y', timezone: 'Lua/Base' }), status(400));
  await assert.rejects(createEnrollment(db, ti, g.farmA), status(403));

  const issued = await createEnrollment(db, g.admin, g.farmA);
  assert.ok(issued.code.length >= 40);
  const integrations = await listIntegrations(db, g.admin);
  assert.ok(integrations.find((row) => row.farmId === g.farmA)?.pendingCodeExpiresAt);
  assert.equal((await listIntegrations(db, g.as('tecnico', [g.farmB]))).length, 1);
  await assert.rejects(revokeCollector(db, g.admin, g.farmA), status(404));

  const techOid = randomUUID();
  await assert.rejects(saveMember(db, g.admin, techOid, { role: 'tecnico', farmIds: [] }), status(400));
  await assert.rejects(saveMember(db, g.admin, techOid, { role: 'tecnico', farmIds: [randomUUID()] }), status(400));
  await saveMember(db, g.admin, techOid, { role: 'tecnico', displayName: 'Ana', farmIds: [g.farmB] });
  const members = await listMembers(db, g.admin);
  assert.deepEqual(members.find((member) => member.oid === techOid), { oid: techOid, displayName: 'Ana', inviteEmail: null, role: 'tecnico', active: true, farmIds: [g.farmB] });

  await assert.rejects(saveMember(db, g.admin, g.admin.actor, { role: 'ti' }), status(409));
  await assert.rejects(deactivateMember(db, g.admin, g.admin.actor), status(409));

  await db.query(`INSERT INTO sessions (token_hash, org_id, entra_oid, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`, [randomUUID(), g.orgId, techOid]);
  await deactivateMember(db, g.admin, techOid);
  const { rows } = await db.query('SELECT 1 FROM sessions WHERE org_id = $1 AND entra_oid = $2', [g.orgId, techOid]);
  assert.equal(rows.length, 0);
  await assert.rejects(listMembers(db, ti), status(403));
});
