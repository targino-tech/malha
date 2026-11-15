import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createFarm } from '../apps/web/src/server/admin';
import { evaluateAll } from '../apps/web/src/server/alerts';
import { createAsset } from '../apps/web/src/server/assets';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { csvCell, exportAssets, exportAudit, exportOccurrences, listAudit, toCsv } from '../apps/web/src/server/exports';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import { indicators, recordService, saveBaseline } from '../apps/web/src/server/metrics';
import { acknowledgeOccurrence } from '../apps/web/src/server/occurrences';
import { processInventoryJob } from '../apps/web/src/server/projection';
import { assetHistory, reconcile, reconciliationQueue } from '../apps/web/src/server/reconciliation';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;

async function setup() {
  const orgId = randomUUID();
  const collectorId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo']);
  const admin: Principal = { orgId, actor: randomUUID(), role: 'admin', farmIds: null, demo: false };
  const farmId = (await createFarm(db, admin, { name: 'Fazenda', location: 'MT' })).id;
  await db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    await tx.query(`INSERT INTO collector_keys (org_id, farm_id, key_id, collector_id, public_key) VALUES ($1, $2, $3, $4, '{}')`, [orgId, farmId, randomUUID(), collectorId]);
    await tx.query(`INSERT INTO collector_health (org_id, farm_id, collector_id, last_heartbeat_at, last_capture_at) VALUES ($1, $2, $3, now(), now())`, [orgId, farmId, collectorId]);
  });
  let sequence = 0;
  async function capture(devices: Array<Record<string, string>>, minutesAgo = 0, seq = ++sequence) {
    const captureId = randomUUID();
    await db.transaction(async (tx) => {
      await setOrg(tx, orgId);
      await tx.query(`INSERT INTO captures (org_id, farm_id, collector_id, id, seq, observed_at, parts)
        VALUES ($1, $2, $3, $4, $5, now() - make_interval(mins => $6), 1)`, [orgId, farmId, collectorId, captureId, seq, minutesAgo]);
      await tx.query(`INSERT INTO capture_batches (org_id, farm_id, collector_id, capture_id, id, part, content_hash, devices)
        VALUES ($1, $2, $3, $4, $5, 1, 'fixture', $6)`, [orgId, farmId, collectorId, captureId, randomUUID(), JSON.stringify(devices)]);
      await tx.query('INSERT INTO inventory_outbox (id, org_id, farm_id, collector_id, capture_id) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), orgId, farmId, collectorId, captureId]);
    });
    while (await processInventoryJob(db)) { /* drena */ }
  }
  const query = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    return (await tx.query<T>(sql, params)).rows;
  });
  return { orgId, farmId, collectorId, admin, capture, query, nextSequence: () => ++sequence };
}

test('histórico registra observações, inclusive reenvio atrasado, e resume mudanças', async () => {
  const g = await setup();
  await g.capture([{ id: 'ap', name: 'AP', state: 'ONLINE', ip: '10.0.0.2', firmware: '1.0' }], 30);
  await g.capture([{ id: 'ap', name: 'AP', state: 'ONLINE', ip: '10.0.0.2', firmware: '1.0' }], 25);
  await g.capture([{ id: 'ap', name: 'AP', state: 'OFFLINE', ip: '10.0.0.2', firmware: '1.0' }], 20);
  await g.capture([{ id: 'ap', name: 'AP', state: 'ONLINE', ip: '10.0.0.9', firmware: '1.1' }], 10);
  // Reenvio atrasado com sequência antiga: entra no histórico sem alterar o estado atual.
  await g.capture([{ id: 'ap', name: 'AP', state: 'OFFLINE', ip: '10.0.0.9', firmware: '1.1' }], 40, 0);
  const [{ id, status: current }] = await g.query<{ id: string; status: string }>('SELECT id, status FROM assets WHERE org_id = $1', [g.orgId]);
  assert.equal(current, 'online');
  const observations = await g.query('SELECT 1 FROM asset_observations WHERE org_id = $1', [g.orgId]);
  assert.equal(observations.length, 5);
  const timeline = (await assetHistory(db, g.admin, id)).filter((entry) => entry.kind === 'observation');
  assert.deepEqual(timeline.map((entry) => entry.label), ['Observado online', 'Observado offline', 'Observado online', 'Observado offline']);
  assert.equal(timeline[0].detail, 'IP 10.0.0.9 · firmware 1.1');
  await assert.rejects(assetHistory(db, { ...g.admin, orgId: randomUUID() }, id), status(404));
});

test('conciliação funde descoberta, desfaz vínculo e impede o religamento automático', async () => {
  const g = await setup();
  const scale = await createAsset(db, g.admin, { farmId: g.farmId, name: 'Balança', category: 'Balança', critical: true, tag: 'BAL-1' });
  const camera = await createAsset(db, g.admin, { farmId: g.farmId, name: 'Câmera', category: 'Câmera', critical: false, mac: '02:00:00:00:00:01' });
  await g.capture([{ id: 'dev-scale', name: 'scale-01', state: 'ONLINE' }, { id: 'dev-cam', name: 'cam', state: 'ONLINE', mac: '02:00:00:00:00:01' }]);

  let queue = await reconciliationQueue(db, g.admin);
  assert.deepEqual(queue.discovered.map((item) => item.name), ['scale-01']);
  assert.deepEqual(queue.links.map((item) => item.name), ['Câmera']);
  assert.deepEqual(queue.reference.map((item) => item.name), ['Balança']);

  await reconcile(db, g.admin, { action: 'merge', assetId: queue.discovered[0].id, targetId: scale.id });
  const [merged] = await g.query<{ external_id: string; status: string; reviewed_at: Date }>(
    'SELECT external_id, status, reviewed_at FROM assets WHERE org_id = $1 AND id = $2', [g.orgId, scale.id]);
  assert.equal(merged.external_id, 'dev-scale');
  assert.equal(merged.status, 'online');
  assert.ok(merged.reviewed_at);
  assert.equal((await g.query('SELECT 1 FROM asset_observations WHERE org_id = $1 AND asset_id = $2', [g.orgId, scale.id])).length, 1);

  await reconcile(db, g.admin, { action: 'unlink', assetId: camera.id });
  await g.capture([{ id: 'dev-scale', name: 'scale-01', state: 'ONLINE' }, { id: 'dev-cam', name: 'cam', state: 'ONLINE', mac: '02:00:00:00:00:01' }]);
  const cameras = await g.query<{ id: string; source: string; external_id: string | null }>(
    `SELECT id, source, external_id FROM assets WHERE org_id = $1 AND mac = '02:00:00:00:00:01' ORDER BY source`, [g.orgId]);
  assert.deepEqual(cameras.map((row) => [row.source, row.external_id]), [['manual', null], ['unifi', 'dev-cam']]);

  queue = await reconciliationQueue(db, g.admin);
  assert.equal(queue.counts.discovered, 1);
  await reconcile(db, g.admin, { action: 'confirm', assetId: queue.discovered[0].id });
  await assert.rejects(reconcile(db, g.admin, { action: 'merge', assetId: scale.id, targetId: camera.id }), status(409));
  await assert.rejects(reconcile(db, { ...g.admin, role: 'diretoria' }, { action: 'confirm', assetId: camera.id }), status(403));
  const history = await assetHistory(db, g.admin, scale.id);
  assert.ok(history.some((entry) => entry.label === 'Vinculado à coleta'));
});

test('indicadores medem cobertura, conferência, detecção, reconhecimento e economia', async () => {
  const g = await setup();
  await createAsset(db, g.admin, { farmId: g.farmId, name: 'Rádio', category: 'Rádio', critical: false });
  const csvFarm = (await createFarm(db, g.admin, { name: 'Só CSV', location: 'MT' })).id;
  const occurrenceIds = [randomUUID(), randomUUID(), randomUUID()];
  await g.query(`INSERT INTO occurrences (org_id, farm_id, id, rule, resource_kind, resource_id, severity, title, first_observed_at, opened_at)
    SELECT $1, $2, id, 'asset_offline', 'asset', gen_random_uuid(), 'critical', 'Ativo offline', now() - make_interval(mins => delay + 10), now() - interval '10 minutes'
    FROM unnest($3::uuid[], ARRAY[2, 4, 10]) AS x(id, delay)`, [g.orgId, g.farmId, occurrenceIds]);
  await g.query(`UPDATE occurrences SET acknowledged_at = opened_at + interval '6 minutes', acknowledged_by = 'x' WHERE org_id = $1 AND id = $2`, [g.orgId, occurrenceIds[0]]);

  let result = await indicators(db, g.admin, new URLSearchParams({ days: '30' }));
  assert.deepEqual(result.coverage, { eligible: 1, complete: 1, csvOnly: 1 });
  assert.equal(result.inventory.reference, 1);
  assert.equal(result.inventory.reviewed, 0);
  assert.equal(result.inventory.incomplete, 1);
  assert.deepEqual(result.detection, { episodes: 3, medianMinutes: 4, p90Minutes: 8.8 });
  assert.deepEqual(result.acknowledgement, { acknowledged: 1, medianMinutes: 6, pending: 2 });
  assert.equal(result.savings.hoursSaved, null, 'sem linha de base não há economia');
  assert.equal(result.weekly.farms.length, 2);
  assert.equal(result.weekly.farms.find((farm) => farm.farmId === g.farmId)?.counts.at(-1), 3);

  await assert.rejects(saveBaseline(db, { ...g.admin, role: 'ti' }, { diagnosisMinutes: 1, travelHours: 1, costPerHour: 1, costPerTrip: 1 }), status(403));
  await saveBaseline(db, g.admin, { diagnosisMinutes: 120, travelHours: 4, costPerHour: 80, costPerTrip: 350 });
  await recordService(db, g.admin, { occurrenceId: occurrenceIds[0], attendedAt: new Date().toISOString(), diagnosisMinutes: 30, tripAvoided: true });
  await recordService(db, g.admin, { farmId: g.farmId, attendedAt: new Date().toISOString(), diagnosisMinutes: 150, tripAvoided: false, notes: 'Troca de fonte' });
  await assert.rejects(recordService(db, g.admin, { farmId: csvFarm, attendedAt: new Date(Date.now() + 86_400_000).toISOString(), diagnosisMinutes: 1, tripAvoided: false }), status(400));
  await assert.rejects(recordService(db, { ...g.admin, role: 'tecnico', farmIds: [csvFarm] }, { occurrenceId: occurrenceIds[1], attendedAt: new Date().toISOString(), diagnosisMinutes: 1, tripAvoided: false }), status(404));

  result = await indicators(db, g.admin, new URLSearchParams({ days: '7' }));
  // (120 - 30) / 60 = 1,5 h de diagnóstico + 4 h da viagem evitada; o atendimento mais longo não gera economia negativa.
  assert.equal(result.savings.hoursSaved, 5.5);
  assert.equal(result.savings.costSaved, Math.round(5.5 * 80 + 350));
  assert.equal(result.savings.services, 2);
  assert.equal(result.services[0].notes ?? result.services[1].notes, 'Troca de fonte');
  await assert.rejects(indicators(db, g.admin, new URLSearchParams({ days: '12' })), status(400));
});

test('exportação neutraliza fórmulas, respeita escopo e fica auditada', async () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+55 65'), "'+55 65");
  // Em planilhas com separador vírgula, a vírgula não pode abrir uma célula nova começando com fórmula.
  assert.equal(csvCell('AP,=1+1'), '"AP,=1+1"');
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@SUM'), "'@SUM");
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.ok(toCsv(['a'], [['b']]).startsWith('﻿a\r\nb'));

  const g = await setup();
  await createAsset(db, g.admin, { farmId: g.farmId, name: '=cmd|calc', category: 'Teste', critical: false });
  const file = await exportAssets(db, g.admin, new URLSearchParams());
  assert.match(String(file.body), /'=cmd\|calc/);
  await assert.rejects(exportAssets(db, { ...g.admin, role: 'diretoria' }, new URLSearchParams()), status(403));
  await assert.rejects(exportAssets(db, { ...g.admin, role: 'ti', farmIds: [randomUUID()] }, new URLSearchParams({ farmId: g.farmId })), status(404));

  await g.query(`UPDATE collector_health SET last_heartbeat_at = now() - interval '10 minutes' WHERE org_id = $1`, [g.orgId]);
  await evaluateAll(db);
  const [{ id }] = await g.query<{ id: string }>('SELECT id FROM occurrences WHERE org_id = $1', [g.orgId]);
  await acknowledgeOccurrence(db, g.admin, id);
  const evidence = await exportOccurrences(db, { ...g.admin, role: 'auditor' }, new URLSearchParams({ days: '7' }));
  assert.match(String(evidence.body), /collector_silent;critical;Coletor sem contato/);

  const audit = await listAudit(db, { ...g.admin, role: 'auditor' }, new URLSearchParams());
  assert.deepEqual(audit.items.slice(0, 3).map((entry) => entry.action), ['export.occurrences', 'occurrence.acknowledge', 'export.assets']);
  await assert.rejects(listAudit(db, { ...g.admin, role: 'ti' }, new URLSearchParams()), status(403));

  // Auditor restrito a fazendas vê só os eventos delas; eventos do grupo inteiro ficam de fora.
  const ownFarm = await listAudit(db, { ...g.admin, role: 'auditor', farmIds: [g.farmId] }, new URLSearchParams());
  assert.ok(ownFarm.items.length > 0);
  assert.ok(ownFarm.items.every((entry) => entry.scope.farmId === g.farmId));
  const otherFarm = await listAudit(db, { ...g.admin, role: 'auditor', farmIds: [randomUUID()] }, new URLSearchParams());
  assert.equal(otherFarm.items.length, 0);
  const exported = await exportAudit(db, { ...g.admin, role: 'auditor', farmIds: [randomUUID()] }, new URLSearchParams({ days: '30' }));
  assert.equal(String(exported.body).trim().split('\r\n').length, 1);
});
