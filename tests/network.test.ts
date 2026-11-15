import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { acceptBatch, enrollCollector } from '../apps/web/src/server/collector';
import { database, DEMO_ENROLLMENT, DEMO_ORG, setOrg } from '../apps/web/src/server/db';
import { applyRetention } from '../apps/web/src/server/exports';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import { devicePorts, geo, resolveRange, roleOf, topology, traffic, vlanSummary } from '../apps/web/src/server/network/queries';
import { computeRate, counterDelta, ratesFromReadings } from '../apps/web/src/server/network/rates';

// O modo demo usa PGlite em memória com o seed do demo, e o mesmo caminho de ingestão assinada do coletor.
process.env.MALHA_MODE = 'demo';
process.env.MALHA_DEMO_DB = 'memory://';

const DEMO_FARM = '00000000-0000-4000-8000-000000000101';
const VALE_VERDE = '00000000-0000-4000-8000-000000000102';
const CERRADO = '00000000-0000-4000-8000-000000000104';
const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;
const admin: Principal = { orgId: DEMO_ORG, actor: 'teste', role: 'admin', farmIds: null, demo: false };
const BASE = Date.now();
const minutesAgo = (minutes: number) => new Date(BASE - minutes * 60_000).toISOString();

describe('taxas a partir de contadores', () => {
  test('diferença simples em bits por segundo', () => {
    const result = computeRate({ observedAt: '2026-01-01T00:00:00Z', rxBytes: 1000, txBytes: 0 }, { observedAt: '2026-01-01T00:05:00Z', rxBytes: 38_500, txBytes: 3750 });
    assert.deepEqual(result, { ok: true, rxBps: 1000, txBps: 100, intervalSeconds: 300, wrapped: false });
  });

  test('estouro de 32 bits é somado; queda grande é reinício e não vira tráfego', () => {
    assert.deepEqual(counterDelta(2 ** 32 - 1000, 500, 300), { delta: 1500, wrapped: true });
    // Contador acima de 32 bits que volta a um valor baixo: reinício (reboot), amostra descartada.
    assert.equal(counterDelta(50e9, 10, 300), null);
    const reset = computeRate({ observedAt: '2026-01-01T00:00:00Z', rxBytes: 50e9, txBytes: 50e9 }, { observedAt: '2026-01-01T00:05:00Z', rxBytes: 10, txBytes: 10 });
    assert.deepEqual(reset, { ok: false, reason: 'reset' });
    // Estouro de 32 bits implausível para o intervalo (um segundo) também é tratado como reinício.
    assert.equal(counterDelta(100, 50, 0.000001), null);
    assert.deepEqual(counterDelta(2 ** 64 - 4096, 4096, 300), { delta: 8192, wrapped: true });
  });

  test('intervalo inválido, lacuna longa, taxa impossível e contador ausente', () => {
    const at = (iso: string, value: number | null) => ({ observedAt: iso, rxBytes: value, txBytes: value });
    assert.deepEqual(computeRate(at('2026-01-01T00:05:00Z', 1), at('2026-01-01T00:05:00Z', 2)), { ok: false, reason: 'order' });
    assert.deepEqual(computeRate(at('2026-01-01T00:00:00Z', 1), at('2026-01-01T02:00:00Z', 2)), { ok: false, reason: 'gap' });
    assert.deepEqual(computeRate(at('2026-01-01T00:00:00Z', 0), at('2026-01-01T00:00:01Z', 1e12)), { ok: false, reason: 'implausible' });
    assert.deepEqual(computeRate(at('2026-01-01T00:00:00Z', null), at('2026-01-01T00:05:00Z', 2)), { ok: false, reason: 'missing' });
  });

  test('leitura fora de ordem divide o intervalo da série', () => {
    const readings = [
      { observedAt: '2026-01-01T00:10:00Z', rxBytes: 75_000, txBytes: 0 },
      { observedAt: '2026-01-01T00:00:00Z', rxBytes: 0, txBytes: 0 },
    ];
    assert.deepEqual(ratesFromReadings(readings).map((sample) => sample.rxBps), [1000]);
    readings.push({ observedAt: '2026-01-01T00:05:00Z', rxBytes: 15_000, txBytes: 0 });
    const samples = ratesFromReadings(readings);
    assert.deepEqual(samples.map((sample) => [sample.observedAt, sample.rxBps, sample.intervalSeconds]), [
      ['2026-01-01T00:05:00.000Z', 400, 300], ['2026-01-01T00:10:00.000Z', 1600, 300],
    ]);
  });

  test('intervalo de consulta é limitado e escolhe o agrupamento', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    assert.equal(resolveRange({ period: '24h' }, now).bucketSeconds, 300);
    assert.equal(resolveRange({ period: '7d' }, now).bucketSeconds, 3600);
    assert.equal(resolveRange({ period: '30d' }, now).bucketSeconds, 21_600);
    assert.throws(() => resolveRange({ from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }, now), status(400));
    assert.throws(() => resolveRange({ from: '2026-06-01T00:00:00Z', to: '2026-05-01T00:00:00Z' }, now), status(400));
    assert.throws(() => resolveRange({ period: '7d', from: '2026-05-01T00:00:00Z' }, now), status(400));
  });

  test('papel do dispositivo vem dos recursos UniFi e do catálogo', () => {
    assert.equal(roleOf({ category: 'Gateway', name: 'GW', model: 'UDM Pro', features: ['switching'] }), 'gateway');
    assert.equal(roleOf({ category: 'Dispositivo de rede', name: 'x', model: 'U7', features: ['accessPoint'] }), 'ap');
    assert.equal(roleOf({ category: 'Dispositivo de rede', name: 'x', model: 'USW', features: ['switching'] }), 'switch');
    assert.equal(roleOf({ category: 'Balança', name: 'Balança', model: null }), 'other');
  });
});

describe('ingestão de rede e API', () => {
  const keys = generateKeyPairSync('ed25519');
  let keyId = '';
  let sequence = 0;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  function signed(path: string, body: string, kid?: string) {
    const iat = Math.floor(Date.now() / 1000);
    const token = `${encode({ alg: 'Ed25519', ...(kid ? { kid } : {}) })}.${encode({ aud: 'malha-collector', method: 'POST', path, iat, exp: iat + 60,
      jti: randomUUID(), body_sha256: createHash('sha256').update(body).digest('hex') })}`;
    return new Request(`https://malha.test${path}`, { method: 'POST', body, headers: {
      'Content-Type': 'application/json', Authorization: `JWS ${token}.${sign(null, Buffer.from(token), keys.privateKey).toString('base64url')}` } });
  }
  function batch(devices: unknown[], extra: Record<string, unknown> = {}, observedAt = new Date().toISOString(), seq = ++sequence) {
    return JSON.stringify({ schemaVersion: 2, batchId: randomUUID(), captureId: randomUUID(), sequence: seq, observedAt, part: 1, parts: 1, devices, ...extra });
  }
  const send = (body: string) => acceptBatch(signed('/v1/collectors/batches', body, keyId));
  async function rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const db = await database();
    return db.transaction(async (tx) => { await setOrg(tx, DEMO_ORG); return (await tx.query<T>(sql, params)).rows; });
  }
  const assetId = async (externalId: string) => (await rows<{ id: string }>('SELECT id FROM assets WHERE org_id = $1 AND external_id = $2', [DEMO_ORG, externalId]))[0].id;

  const sw = '11111111-1111-4111-8111-111111111111';
  const gw = '22222222-2222-4222-8222-222222222222';
  const ports = (rx: number) => [
    { idx: 1, state: 'UP', connector: 'SFPPLUS', speedMbps: 10000, nativeVlanId: 20, taggedVlanIds: [30], rxBytes: rx, txBytes: rx / 2 },
    { idx: 2, state: 'DOWN', connector: 'RJ45', poe: { standard: '802.3at', enabled: true, state: 'OFF' } },
  ];
  const networks = [{ id: 'net-20', name: 'Produção', vlanId: 20, subnet: '10.20.0.0/24', enabled: true, management: 'GATEWAY' },
    { id: 'net-30', name: 'Visitantes', vlanId: 30 }];

  before(async () => {
    const body = JSON.stringify({ code: DEMO_ENROLLMENT, publicKey: keys.publicKey.export({ format: 'jwk' }) });
    keyId = (await enrollCollector(signed('/v1/collectors/enroll', body))).keyId;
  });
  after(async () => (await database()).close());

  test('lote versão 1 continua aceito e versão 1 com campos de rede é recusada', async () => {
    await send(JSON.stringify({ schemaVersion: 1, batchId: randomUUID(), captureId: randomUUID(), sequence: ++sequence,
      observedAt: minutesAgo(20), part: 1, parts: 1, devices: [{ id: gw, name: 'Gateway legado', state: 'ONLINE', model: 'UDM' }] }));
    assert.equal((await rows('SELECT 1 FROM assets WHERE org_id = $1 AND external_id = $2', [DEMO_ORG, gw])).length, 1);
    await assert.rejects(send(JSON.stringify({ schemaVersion: 1, batchId: randomUUID(), captureId: randomUUID(), sequence: ++sequence,
      observedAt: minutesAgo(19), part: 1, parts: 1, devices: [{ id: gw, state: 'ONLINE', ports: [] }] })), status(400));
    await assert.rejects(send(batch([{ id: gw, state: 'ONLINE', ports: [{ idx: 1 }, { idx: 1 }] }])), status(400));
    // A versão 1 não altera portas, VLANs nem ligações: ausência significa "não lido".
    assert.equal((await rows('SELECT 1 FROM device_ports WHERE org_id = $1 AND farm_id = $2', [DEMO_ORG, DEMO_FARM])).length, 0);
  });

  test('versão 2 projeta portas, VLANs, ligação entre dispositivos e taxa de uplink, de forma idempotente', async () => {
    const devices = [
      { id: gw, name: 'Gateway da sede', state: 'ONLINE', model: 'UDM Pro', features: ['switching'], uplinkRxBps: 8_000_000, uplinkTxBps: 2_000_000 },
      { id: sw, name: 'Switch', state: 'ONLINE', model: 'USW 24', features: ['switching'], uplinkDeviceId: gw, ports: ports(0) },
    ];
    const body = batch(devices, { networks }, minutesAgo(15));
    const receipt = await send(body);
    assert.deepEqual(await send(body), receipt, 'reenvio devolve o mesmo recibo');
    const switchId = await assetId(sw);
    const gatewayId = await assetId(gw);
    const listed = await devicePorts(await database(), admin, switchId);
    assert.equal(listed.role, 'switch');
    assert.deepEqual(listed.ports?.map((port) => [port.idx, port.state, port.nativeVlan?.name, port.taggedVlans.map((v) => v.name)]),
      [[1, 'UP', 'Produção', ['Visitantes']], [2, 'DOWN', undefined, []]]);
    assert.equal(listed.ports?.[1].poe?.standard, '802.3at');
    const graph = await topology(await database(), admin, new URLSearchParams({ farmId: DEMO_FARM }));
    const edge = graph.edges.find((item) => item.from === switchId);
    assert.deepEqual(edge && { to: edge.to, level: edge.level, evidence: edge.evidence, ports: [edge.fromPortIdx, edge.toPortIdx] },
      { to: gatewayId, level: 'device', evidence: 'unifi_uplink', ports: [null, null] });
    assert.equal(graph.nodes.find((node) => node.assetId === gatewayId)?.role, 'gateway');
    assert.equal(graph.nodes.find((node) => node.assetId === gatewayId)?.uplink?.rxBps, 8_000_000);
    const vlans = await vlanSummary(await database(), admin, new URLSearchParams({ farmId: DEMO_FARM }));
    assert.deepEqual(vlans.items.map((item) => [item.vlanId, item.subnet, item.nativePorts, item.taggedPorts]), [[20, '10.20.0.0/24', 1, 0], [30, null, 0, 1]]);
    const samples = await rows('SELECT 1 FROM traffic_samples WHERE org_id = $1 AND farm_id = $2', [DEMO_ORG, DEMO_FARM]);
    assert.equal(samples.length, 1);
  });

  test('contadores por porta viram taxa, inclusive com captura atrasada; captura velha não substitui o estado', async () => {
    const switchId = await assetId(sw);
    const at10 = minutesAgo(10);
    const at5 = minutesAgo(5);
    const device = (rx: number, extra: Record<string, unknown> = {}) => ({ id: sw, name: 'Switch', state: 'ONLINE', model: 'USW 24', uplinkDeviceId: gw, ports: ports(rx), ...extra });
    await send(batch([device(15_000_000)], {}, at5, sequence + 2));
    const before = await rows<{ rx_bps: string }>(`SELECT rx_bps FROM traffic_samples WHERE org_id = $1 AND asset_id = $2 AND kind = 'port' ORDER BY observed_at`, [DEMO_ORG, switchId]);
    assert.deepEqual(before.map((row) => Number(row.rx_bps)), [Math.round(15_000_000 * 8 / 600)]);
    // Chega atrasada (sequência menor) a leitura do meio: a série é recalculada, o estado atual não muda.
    await send(batch([device(3_000_000, { ports: [{ idx: 1, state: 'DOWN', rxBytes: 3_000_000, txBytes: 1_500_000 }] })], {}, at10, sequence - 1));
    const after = await rows<{ rx_bps: string }>(`SELECT rx_bps FROM traffic_samples WHERE org_id = $1 AND asset_id = $2 AND kind = 'port' ORDER BY observed_at`, [DEMO_ORG, switchId]);
    assert.deepEqual(after.map((row) => Number(row.rx_bps)), [Math.round(3_000_000 * 8 / 300), Math.round(12_000_000 * 8 / 300)]);
    const latest = await devicePorts(await database(), admin, switchId);
    assert.equal(latest.ports?.[0].state, 'UP');
    assert.equal(latest.ports?.[0].rxBps, Math.round(12_000_000 * 8 / 300), 'taxa da porta acompanha o recálculo');
    const series = await traffic(await database(), admin, new URLSearchParams({ farmId: DEMO_FARM, assetId: switchId, portIdx: '1', period: '24h' }));
    assert.equal(series.scope.kind, 'port');
    assert.deepEqual(series.sources, ['counter_delta']);
    assert.equal(series.points.reduce((sum, point) => sum + point.samples, 0), 2);
  });

  test('lista vazia de portas e uplink ausente após leitura removem dados antigos', async () => {
    const switchId = await assetId(sw);
    await send(batch([{ id: sw, name: 'Switch', state: 'ONLINE', ports: [] }], { networks: [] }, minutesAgo(1), sequence + 5));
    sequence += 5;
    assert.deepEqual((await devicePorts(await database(), admin, switchId)).ports, [], 'lida e sem portas');
    assert.equal((await devicePorts(await database(), admin, await assetId(gw))).ports, null, 'nunca lidas');
    const graph = await topology(await database(), admin, new URLSearchParams({ farmId: DEMO_FARM }));
    assert.equal(graph.edges.length, 0);
    assert.equal((await vlanSummary(await database(), admin, new URLSearchParams({ farmId: DEMO_FARM }))).total, 0);
  });

  test('demo tem fazendas pelo Brasil, topologia, VLANs e 7 dias de tráfego marcados como sintéticos', async () => {
    const db = await database();
    const map = await geo(db, admin, new URLSearchParams({ period: '7d' }));
    assert.ok(map.farms.length >= 7);
    const located = map.farms.filter((farm) => farm.latitude !== null);
    assert.ok(new Set(located.map((farm) => farm.location.split('·')[1]?.trim())).size >= 5, 'fazendas em vários estados');
    const cerrado = map.farms.find((farm) => farm.farmId === CERRADO)!;
    assert.equal(cerrado.synthetic, true);
    assert.ok(cerrado.metrics.trafficRxBytes > 0 && cerrado.metrics.collector!.captures > 100 && cerrado.metrics.collector!.payloadBytes > 0);
    const graph = await topology(db, admin, new URLSearchParams({ farmId: CERRADO }));
    assert.equal(graph.nodes.length, 4);
    assert.ok(graph.edges.every((edge) => edge.synthetic));
    assert.ok(graph.edges.some((edge) => edge.level === 'port' && edge.fromPortIdx !== null && edge.toPortIdx !== null));
    assert.ok(graph.edges.some((edge) => edge.level === 'device' && edge.fromPortIdx === null));
    const week = await traffic(db, admin, new URLSearchParams({ farmId: CERRADO, period: '7d' }));
    assert.equal(week.bucketSeconds, 3600);
    assert.ok(week.points.length >= 160 && week.points.length <= 169, `pontos: ${week.points.length}`);
    assert.deepEqual(week.sources, ['synthetic']);
    const vlans = await vlanSummary(db, admin, new URLSearchParams({ limit: '5' }));
    assert.equal(vlans.items.length, 5);
    assert.ok(vlans.nextCursor && vlans.items.every((item) => item.synthetic));
    const next = await vlanSummary(db, admin, new URLSearchParams({ limit: '5', cursor: vlans.nextCursor }));
    assert.notDeepEqual(next.items[0], vlans.items[0]);
    const ports = await devicePorts(db, admin, graph.nodes.find((node) => node.role === 'switch')!.assetId);
    assert.ok(ports.ports!.length > 20 && ports.ports!.every((port) => port.synthetic));
    await assert.rejects(traffic(db, admin, new URLSearchParams({ farmId: CERRADO, portIdx: '1' })), status(400));
    await assert.rejects(traffic(db, admin, new URLSearchParams({ farmId: CERRADO, period: '1y' })), status(400));
  });

  test('outro grupo e fazenda fora do escopo respondem como inexistentes em todas as rotas', async () => {
    const db = await database();
    const switchId = (await topology(db, admin, new URLSearchParams({ farmId: CERRADO }))).nodes.find((node) => node.role === 'switch')!.assetId;
    const outsider: Principal = { orgId: randomUUID(), actor: 'fora', role: 'admin', farmIds: null, demo: false };
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [outsider.orgId, 'Outro grupo']);
    const technician: Principal = { ...admin, role: 'tecnico', farmIds: [VALE_VERDE] };
    for (const user of [outsider, technician]) {
      await assert.rejects(topology(db, user, new URLSearchParams({ farmId: CERRADO })), status(404));
      await assert.rejects(devicePorts(db, user, switchId), status(404));
      await assert.rejects(vlanSummary(db, user, new URLSearchParams({ farmId: CERRADO })), status(404));
      await assert.rejects(traffic(db, user, new URLSearchParams({ farmId: CERRADO })), status(404));
      await assert.rejects(traffic(db, user, new URLSearchParams({ farmId: CERRADO, assetId: switchId })), status(404));
    }
    // Ativo de outra fazenda informado junto com uma fazenda permitida também é inexistente.
    await assert.rejects(traffic(db, technician, new URLSearchParams({ farmId: VALE_VERDE, assetId: switchId })), status(404));
    await assert.rejects(topology(db, admin, new URLSearchParams({ farmId: 'nao-e-uuid' })), status(404));
    assert.deepEqual((await geo(db, outsider, new URLSearchParams())).farms, []);
    assert.deepEqual((await geo(db, technician, new URLSearchParams())).farms.map((farm) => farm.farmId), [VALE_VERDE]);
    assert.equal((await vlanSummary(db, outsider, new URLSearchParams())).total, 0);
    assert.ok((await vlanSummary(db, technician, new URLSearchParams())).items.every((item) => item.farmId === VALE_VERDE));
    // RLS: com um papel sem privilégios, outro grupo não enxerga nenhuma linha das tabelas novas.
    const tables = ['device_ports', 'network_links', 'network_vlans', 'port_counter_readings', 'traffic_samples'];
    await db.transaction(async (tx) => {
      await tx.exec(`CREATE ROLE malha_rede_teste NOLOGIN NOBYPASSRLS; GRANT SELECT ON ${tables.join(', ')} TO malha_rede_teste; SET LOCAL ROLE malha_rede_teste`);
      for (const table of tables) {
        await setOrg(tx, outsider.orgId);
        assert.equal((await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length, 0, table);
        await setOrg(tx, DEMO_ORG);
        assert.ok((await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length > 0 || table === 'port_counter_readings', table);
      }
      await tx.exec(`RESET ROLE; REVOKE SELECT ON ${tables.join(', ')} FROM malha_rede_teste; DROP ROLE malha_rede_teste`);
    });
    const { rows: policies } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policy: string | null }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.polname AS policy FROM pg_class c
      LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'org_scope'
      WHERE c.relname = ANY($1::text[]) ORDER BY c.relname`, [tables]);
    assert.equal(policies.length, 5);
    assert.ok(policies.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policy === 'org_scope'));
  });

  test('retenção apaga tráfego antigo e leituras brutas de contador', async () => {
    const db = await database();
    const switchId = await assetId(sw);
    await db.transaction(async (tx) => {
      await setOrg(tx, DEMO_ORG);
      await tx.query(`INSERT INTO traffic_samples (org_id, farm_id, asset_id, kind, port_idx, observed_at, rx_bps, tx_bps, interval_seconds, source)
        VALUES ($1, $2, $3, 'uplink', 0, now() - interval '31 days', 1, 1, 300, 'unifi_rate')`, [DEMO_ORG, DEMO_FARM, switchId]);
      await tx.query(`INSERT INTO port_counter_readings (org_id, farm_id, asset_id, port_idx, observed_at, rx_bytes, tx_bytes)
        VALUES ($1, $2, $3, 1, now() - interval '3 days', 1, 1)`, [DEMO_ORG, DEMO_FARM, switchId]);
    });
    await applyRetention(db);
    assert.equal((await rows(`SELECT 1 FROM traffic_samples WHERE org_id = $1 AND observed_at < now() - interval '30 days'`, [DEMO_ORG])).length, 0);
    assert.equal((await rows(`SELECT 1 FROM port_counter_readings WHERE org_id = $1 AND observed_at < now() - interval '2 days'`, [DEMO_ORG])).length, 0);
  });
});
