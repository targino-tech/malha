import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';

import {
  areaPath, formatBits, gapThreshold, formatBytes, formatPercent, formatPower, heatLevel, linePath, nearestIndex, niceCeiling, project, segments,
} from '../apps/web/src/components/dashboard/network-format';
import { database, DEMO_ORG } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import { groupVlans, mergeSeries, networkPanel, utilization } from '../apps/web/src/server/network/panel';

process.env.MALHA_MODE = 'demo';
process.env.MALHA_DEMO_DB = 'memory://';

const NBSP = ' ';
const VALE_VERDE = '00000000-0000-4000-8000-000000000102';
const CERRADO = '00000000-0000-4000-8000-000000000104';
const TRES_PINHEIROS = '00000000-0000-4000-8000-000000000107';
const admin: Principal = { orgId: DEMO_ORG, actor: 'teste', role: 'admin', farmIds: null, demo: false };
const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;

describe('formatação pt-BR do painel de rede', () => {
  test('taxas em bits por segundo com múltiplos decimais', () => {
    assert.equal(formatBits(0), `0${NBSP}bit/s`);
    assert.equal(formatBits(-5), `0${NBSP}bit/s`);
    assert.equal(formatBits(Number.NaN), `0${NBSP}bit/s`);
    assert.equal(formatBits(950), `950${NBSP}bit/s`);
    assert.equal(formatBits(1_234_567), `1,2${NBSP}Mbit/s`);
    assert.equal(formatBits(120_000_000), `120${NBSP}Mbit/s`);
    assert.equal(formatBits(999_960), `1${NBSP}Mbit/s`, 'arredondamento sobe de unidade em vez de mostrar 1.000 kbit/s');
    assert.equal(formatBits(10e9), `10${NBSP}Gbit/s`);
  });

  test('volumes em bytes, percentuais e potência', () => {
    assert.equal(formatBytes(512), `512${NBSP}B`);
    assert.equal(formatBytes(1_500_000_000), `1,5${NBSP}GB`);
    assert.equal(formatBytes(2.25e12), `2,3${NBSP}TB`);
    assert.equal(formatPercent(0.375), '37,5%');
    assert.equal(formatPercent(1), '100%');
    assert.equal(formatPower(12_400), `12,4${NBSP}W`);
  });

  test('teto do eixo, trechos com lacuna e caminhos SVG', () => {
    assert.equal(niceCeiling(0), 1);
    assert.equal(niceCeiling(830_000_000), 1e9);
    assert.equal(niceCeiling(210), 250);
    assert.equal(niceCeiling(500), 500);
    const points = ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '2026-01-01T05:00:00Z', '2026-01-01T06:00:00Z'].map((t, i) => ({ t, v: i }));
    assert.deepEqual(segments(points, 3_600_000).map((part) => part.length), [2, 2], 'lacuna de 4 h quebra a linha');
    const frame = { from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-01-01T10:00:00Z'), width: 100, height: 50, max: 4 };
    const projected = project(points.slice(0, 2), (p) => p.v, frame);
    assert.deepEqual(projected, [{ x: 0, y: 50 }, { x: 10, y: 37.5 }]);
    assert.equal(linePath(projected), 'M0 50L10 37.5');
    assert.equal(areaPath(projected, 50), 'M0 50L10 37.5L10 50L0 50Z');
    assert.equal(areaPath([{ x: 10, y: 20 }], 50), 'M9 20L11 20L11 50L9 50Z', 'ponto isolado continua visível');
    assert.equal(areaPath([], 50), '');
    assert.equal(nearestIndex(points, 0.45, frame.from, frame.to), 2);
    assert.equal(nearestIndex([], 0.5, 0, 1), -1);
    const every15 = [0, 15, 30, 45].map((m) => ({ t: new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString() }));
    assert.equal(gapThreshold(every15, 300), 15 * 60_000 * 2.5, 'coleta a cada 15 min agrupada em 5 min não vira lacuna');
    assert.equal(segments(every15, gapThreshold(every15, 300)).length, 1);
    assert.equal(gapThreshold([], 3600), 3_600_000 * 2.5);
  });

  test('faixas de utilização da tira de calor', () => {
    assert.deepEqual([null, 0, 0.1, 0.3, 0.6, 0.9, 1].map(heatLevel), [null, 0, 1, 2, 3, 4, 4]);
  });
});

describe('agregações do painel de rede', () => {
  test('utilização usa o maior sentido sobre a velocidade e trata ausência como não medido', () => {
    assert.equal(utilization(400e6, 100e6, 1000), 0.4);
    assert.equal(utilization(5e9, 0, 1000), 1, 'limitada a 100%');
    assert.equal(utilization(null, 10, 1000), null);
    assert.equal(utilization(10, 10, null), null);
    assert.equal(utilization(10, 10, 0), null);
  });

  test('séries por fazenda viram total por instante, em ordem', () => {
    const row = (farmId: string, t: string, rx: number) => ({ farmId, t, rxBps: rx, txBps: rx / 2, rxMaxBps: rx * 2, txMaxBps: rx, rxBytes: rx * 10, txBytes: rx * 5, samples: 1 });
    const { total, byFarm } = mergeSeries([row('b', '2026-01-01T01:00:00.000Z', 10), row('a', '2026-01-01T00:00:00.000Z', 4), row('a', '2026-01-01T01:00:00.000Z', 6)]);
    assert.deepEqual(total.map((point) => [point.t, point.rxBps, point.txBps, point.samples]), [
      ['2026-01-01T00:00:00.000Z', 4, 2, 1], ['2026-01-01T01:00:00.000Z', 16, 8, 2],
    ]);
    assert.deepEqual(byFarm.get('a')!.map((point) => point.rxBps), [4, 6]);
    assert.deepEqual(mergeSeries([]).total, []);
  });

  test('VLANs de fazendas diferentes se agrupam pelo número, com o nome mais comum', () => {
    const vlan = (farmId: string, vlanId: number | null, name: string, nativePorts: number, enabled: boolean | null = true) =>
      ({ farmId, vlanId, name, enabled, nativePorts, taggedPorts: 1, synthetic: false });
    const grouped = groupVlans([vlan('a', 20, 'Produção', 3), vlan('b', 20, 'Produção', 2), vlan('c', 20, 'Prod', 0), vlan('a', 99, 'Reserva', 0, false), vlan('a', null, 'Sem tag', 1)]);
    assert.deepEqual(grouped.map((item) => [item.vlanId, item.name, item.farms, item.nativePorts, item.taggedPorts, item.enabled]), [
      [20, 'Produção', 3, 5, 3, true], [null, 'Sem tag', 1, 1, 1, true], [99, 'Reserva', 1, 0, 1, false],
    ]);
  });
});

describe('API do painel de rede no demo', () => {
  after(async () => (await database()).close());

  test('todas as fazendas: indicadores, tráfego, consumidores, VLANs e switches, marcados como fictícios', async () => {
    const panel = await networkPanel(await database(), admin, new URLSearchParams({ period: '7d' }));
    assert.equal(panel.bucketSeconds, 3600);
    assert.equal(panel.synthetic, true);
    assert.deepEqual(panel.sources, ['synthetic']);
    const { kpis } = panel;
    assert.ok(kpis.ports.up > 0 && kpis.ports.down > 0 && kpis.ports.total === kpis.ports.up + kpis.ports.down + kpis.ports.other);
    assert.ok(kpis.utilization && kpis.utilization.avg > 0 && kpis.utilization.peak >= kpis.utilization.avg && kpis.utilization.peak <= 1);
    assert.ok(kpis.errors && kpis.errors.rxErrors > 0);
    assert.ok(kpis.poe.activePorts > 0 && kpis.poe.powerMw !== null && kpis.poe.powerMw > 0);
    assert.ok(kpis.vlans.enabled > 0 && kpis.vlans.enabled < kpis.vlans.total, 'VLAN 99 desativada não conta como ativa');
    assert.ok(kpis.devices.offline >= 1 && kpis.devices.total > kpis.devices.offline);
    assert.ok(panel.traffic.length >= 160 && panel.traffic.length <= 169, `pontos: ${panel.traffic.length}`);
    assert.ok(panel.traffic.every((point, index) => index === 0 || Date.parse(point.t) > Date.parse(panel.traffic[index - 1].t)));
    assert.ok(panel.farms.length >= 7, 'inclui fazendas sem tráfego para mostrar o vazio');
    const cerrado = panel.farms.find((farm) => farm.farmId === CERRADO)!;
    assert.ok(cerrado.spark.length > 100 && cerrado.rxBytes > 0 && cerrado.peakBps > 0);
    const farmSum = panel.farms.reduce((sum, farm) => sum + farm.rxBytes, 0);
    assert.equal(farmSum, panel.traffic.reduce((sum, point) => sum + point.rxBytes, 0), 'total bate com a soma das fazendas');
    assert.equal(panel.topDevices.length, 8);
    assert.ok(panel.topDevices.every((item, index) => index === 0 || item.rxBytes + item.txBytes <= panel.topDevices[index - 1].rxBytes + panel.topDevices[index - 1].txBytes));
    assert.ok(panel.topPorts.length > 0 && panel.topPorts.every((port) => port.synthetic && (port.utilization === null || port.utilization <= 1)));
    assert.ok(panel.vlans.some((vlan) => vlan.vlanId === 20 && vlan.farms >= 5));
    assert.ok(panel.switches.length >= 5 && panel.switches.every((item) => item.ports.length > 0));
    assert.ok(panel.switches.some((item) => item.ports.some((port) => port.utilization !== null)));
    assert.equal(panel.switchesTruncated, false);
  });

  test('filtro por fazenda limita tudo à fazenda; período 24h usa intervalos de 5 min', async () => {
    const panel = await networkPanel(await database(), admin, new URLSearchParams({ farmId: TRES_PINHEIROS, period: '24h' }));
    assert.equal(panel.farmId, TRES_PINHEIROS);
    assert.equal(panel.bucketSeconds, 300);
    assert.deepEqual(panel.farms.map((farm) => farm.farmId), [TRES_PINHEIROS]);
    assert.ok(panel.topDevices.every((item) => item.farmId === TRES_PINHEIROS));
    assert.ok(panel.topPorts.every((item) => item.farmId === TRES_PINHEIROS));
    assert.ok(panel.switches.every((item) => item.farmId === TRES_PINHEIROS));
    assert.ok(panel.kpis.devices.offline >= 1, 'switch da balança offline');
  });

  test('fazenda sem dados de rede responde vazio, não erro', async () => {
    const santaLuzia = (await networkPanel(await database(), admin, new URLSearchParams())).farms.find((farm) => farm.name.includes('Santa Luzia'));
    assert.ok(santaLuzia, 'Santa Luzia existe no demo');
    const panel = await networkPanel(await database(), admin, new URLSearchParams({ farmId: santaLuzia.farmId }));
    assert.equal(panel.kpis.ports.total, 0);
    assert.equal(panel.kpis.utilization, null);
    assert.equal(panel.kpis.errors, null);
    assert.equal(panel.kpis.poe.powerMw, null);
    assert.deepEqual([panel.traffic, panel.topDevices, panel.topPorts, panel.vlans, panel.switches], [[], [], [], [], []]);
  });

  test('outro grupo e fazenda fora do escopo respondem como inexistentes; sem fazenda, só o escopo do usuário', async () => {
    const db = await database();
    const outsider: Principal = { orgId: randomUUID(), actor: 'fora', role: 'admin', farmIds: null, demo: false };
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [outsider.orgId, 'Outro grupo do painel']);
    const technician: Principal = { ...admin, role: 'tecnico', farmIds: [VALE_VERDE] };
    for (const user of [outsider, technician]) {
      await assert.rejects(networkPanel(db, user, new URLSearchParams({ farmId: CERRADO })), status(404));
    }
    await assert.rejects(networkPanel(db, admin, new URLSearchParams({ farmId: 'nao-e-uuid' })), status(404));
    await assert.rejects(networkPanel(db, admin, new URLSearchParams({ farmId: randomUUID() })), status(404));
    await assert.rejects(networkPanel(db, admin, new URLSearchParams({ period: '1y' })), status(400));

    const foreign = await networkPanel(db, outsider, new URLSearchParams({ period: '7d' }));
    assert.deepEqual([foreign.farms, foreign.traffic, foreign.topDevices, foreign.topPorts, foreign.vlans, foreign.switches], [[], [], [], [], [], []]);
    assert.deepEqual([foreign.kpis.ports.total, foreign.kpis.devices.total, foreign.kpis.vlans.total], [0, 0, 0]);
    assert.equal(foreign.synthetic, false);

    const scoped = await networkPanel(db, technician, new URLSearchParams({ period: '7d' }));
    assert.deepEqual(scoped.farms.map((farm) => farm.farmId), [VALE_VERDE]);
    for (const list of [scoped.topDevices, scoped.topPorts, scoped.switches]) assert.ok(list.every((item) => item.farmId === VALE_VERDE));
    const vale = await networkPanel(db, admin, new URLSearchParams({ farmId: VALE_VERDE, period: '7d' }));
    assert.deepEqual(scoped.kpis, vale.kpis, 'técnico vê exatamente o mesmo que o filtro pela fazenda dele');
    assert.deepEqual(scoped.traffic, vale.traffic);
  });
});
