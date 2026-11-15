import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';

import {
  aggregateByArea, boundsOf, buildMapFarms, farmHealth, formatBytes, haversineKm, heatWeights, nearestFarms, parseUf, regionOf,
  sortFarms, toFeatureCollection, worstHealth,
} from '../apps/web/src/components/dashboard/geo/analysis';
import { mapCspOrigins, parseExtraOrigins, resolveMapStyle } from '../apps/web/src/components/dashboard/geo/config';
import { database, DEMO_ORG } from '../apps/web/src/server/db';
import type { DashboardFarm } from '../apps/web/src/server/dashboard';
import type { Principal } from '../apps/web/src/server/identity';
import { geo } from '../apps/web/src/server/network/queries';
import nextConfig from '../apps/web/next.config';
import type { GeoFarm } from '../apps/web/src/server/network/types';

process.env.MALHA_MODE = 'demo';
process.env.MALHA_DEMO_DB = 'memory://';

const VALE_VERDE = '00000000-0000-4000-8000-000000000102';
const admin: Principal = { orgId: DEMO_ORG, actor: 'teste', role: 'admin', farmIds: null, demo: false };

function geoFarm(id: string, overrides: Partial<Omit<GeoFarm, 'metrics'>> & { metrics?: Partial<GeoFarm['metrics']> } = {}): GeoFarm {
  const { metrics, ...rest } = overrides;
  return {
    farmId: id, name: `Fazenda ${id}`, location: 'Sorriso · MT', latitude: -12.5, longitude: -55.7, synthetic: false,
    ...rest,
    metrics: {
      trafficRxBytes: 0, trafficTxBytes: 0, offlineAssets: 0, assets: 3, openOccurrences: 0,
      collector: { captures: 10, batches: 10, payloadBytes: 1000, lastCaptureAt: null }, ...metrics,
    },
  };
}

function dashboardFarm(id: string, overrides: Partial<DashboardFarm> = {}): DashboardFarm {
  return {
    id, name: `Fazenda ${id}`, location: 'Sorriso · MT', timezone: 'America/Cuiaba', latitude: -12.5, longitude: -55.7,
    collectorStatus: 'online', lastHeartbeatAt: null, lastCaptureAt: null, assetCount: 3, unifiCount: 3, criticalCount: 0,
    offlineCount: 0, offlineCriticalCount: 0, openOccurrences: 0, ...overrides,
  };
}

describe('geoprocessamento do mapa', () => {
  test('UF e região vêm do campo de localização', () => {
    assert.equal(parseUf('Rio Verde · GO'), 'GO');
    assert.equal(parseUf('Cascavel/PR'), 'PR');
    assert.equal(parseUf('Sorriso - mt'), 'MT');
    assert.equal(parseUf('Rio Verde'), null, 'sem UF');
    assert.equal(parseUf('Cidade · XX'), null, 'sigla que não é UF');
    assert.equal(regionOf('BA'), 'Nordeste');
    assert.equal(regionOf('MS'), 'Centro-Oeste');
    assert.equal(regionOf(null), null);
  });

  test('saúde: crítico, atenção, sem coletor e saudável; o agregado usa a pior', () => {
    assert.equal(farmHealth(geoFarm('a'), dashboardFarm('a', { collectorStatus: 'offline' })), 'critical');
    assert.equal(farmHealth(geoFarm('a'), dashboardFarm('a', { offlineCriticalCount: 1 })), 'critical');
    assert.equal(farmHealth(geoFarm('a', { metrics: { openOccurrences: 2 } }), dashboardFarm('a')), 'warning');
    assert.equal(farmHealth(geoFarm('a', { metrics: { collector: null } }), dashboardFarm('a', { collectorStatus: 'missing' })), 'missing');
    assert.equal(farmHealth(geoFarm('a'), dashboardFarm('a')), 'healthy');
    assert.equal(farmHealth(geoFarm('a'), undefined), 'healthy');
    assert.equal(worstHealth(['healthy', 'missing', 'warning']), 'warning');
    assert.equal(worstHealth([]), 'healthy');
  });

  test('distância de grande círculo e fazenda mais próxima', () => {
    // Sorriso a Sinop: cerca de 76 km em linha reta.
    const km = haversineKm({ latitude: -12.545, longitude: -55.711 }, { latitude: -11.864, longitude: -55.502 });
    assert.ok(km > 70 && km < 85, `km: ${km}`);
    assert.equal(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
    const nearest = nearestFarms([
      { farmId: 'a', name: 'A', latitude: -12.545, longitude: -55.711 },
      { farmId: 'b', name: 'B', latitude: -11.864, longitude: -55.502 },
      { farmId: 'c', name: 'C', latitude: -24.956, longitude: -53.455 },
      { farmId: 'd', name: 'D', latitude: null, longitude: null },
    ]);
    assert.equal(nearest.get('a')?.farmId, 'b');
    assert.equal(nearest.get('c')?.farmId, 'a', 'Sorriso fica mais ao sul que Sinop');
    assert.equal(nearest.has('d'), false, 'sem coordenadas não entra');
    assert.equal(nearestFarms([{ farmId: 'a', name: 'A', latitude: 1, longitude: 1 }]).size, 0, 'sozinha não tem vizinha');
  });

  test('coordenada inválida vira sem coordenadas e fica fora do GeoJSON', () => {
    const farms = buildMapFarms([geoFarm('a'), geoFarm('b', { latitude: 200, longitude: 10 }), geoFarm('c', { latitude: null, longitude: null })], []);
    assert.deepEqual(farms.map((farm) => farm.latitude), [-12.5, null, null]);
    const collection = toFeatureCollection(farms, 'traffic');
    assert.equal(collection.features.length, 1);
    assert.deepEqual(collection.features[0].geometry.coordinates, [-55.7, -12.5]);
    assert.deepEqual(Object.keys(collection.features[0].properties).sort(), ['farmId', 'heat', 'name', 'severity']);
    assert.deepEqual(boundsOf(farms), [-55.7, -12.5, -55.7, -12.5]);
    assert.equal(boundsOf([]), null);
  });

  test('peso do mapa de calor relativo ao maior valor, com zero fora do calor', () => {
    const farms = buildMapFarms([
      geoFarm('a', { metrics: { trafficRxBytes: 400, trafficTxBytes: 0 } }),
      geoFarm('b', { metrics: { trafficRxBytes: 100, trafficTxBytes: 0 } }),
      geoFarm('c', { metrics: { collector: null } }),
    ], []);
    const traffic = heatWeights(farms, 'traffic');
    assert.equal(traffic.get('a'), 1);
    assert.equal(traffic.get('b'), 0.5);
    assert.equal(traffic.get('c'), 0);
    assert.equal(heatWeights(farms, 'collector').get('c'), 0, 'sem coletor não pesa');
    assert.ok([...heatWeights(farms, 'offline').values()].every((value) => value === 0), 'tudo zero sem dividir por zero');
  });

  test('agrega por UF e região somando métricas e mantendo a pior saúde', () => {
    const farms = buildMapFarms([
      geoFarm('a', { location: 'Sorriso · MT', metrics: { trafficRxBytes: 10, trafficTxBytes: 5, offlineAssets: 1 } }),
      geoFarm('b', { location: 'Sinop · MT', metrics: { trafficRxBytes: 20, trafficTxBytes: 0 } }),
      geoFarm('c', { location: 'Rio Verde · GO', metrics: { openOccurrences: 3 } }),
      geoFarm('d', { location: 'Sem estado', latitude: null, longitude: null }),
    ], [dashboardFarm('a', { offlineCriticalCount: 1 })]);
    const byUf = aggregateByArea(farms, 'uf');
    assert.deepEqual(byUf.map((area) => [area.label, area.farms]), [['MT', 2], ['GO', 1], ['Sem UF', 1]]);
    const mt = byUf[0];
    assert.equal(mt.trafficBytes, 35);
    assert.equal(mt.offlineAssets, 1);
    assert.equal(mt.health, 'critical');
    assert.equal(mt.collectorBytes, 2000);
    const byRegion = aggregateByArea(farms, 'region');
    assert.deepEqual(byRegion.map((area) => [area.label, area.farms, area.located]), [['Centro-Oeste', 3, 3], ['Sem região', 1, 0]]);
  });

  test('ordenação da tabela, com ausentes sempre no fim', () => {
    const farms = buildMapFarms([
      geoFarm('a', { name: 'Beta', metrics: { trafficRxBytes: 5 } }),
      geoFarm('b', { name: 'Alfa', metrics: { trafficRxBytes: 50 }, latitude: -11.8, longitude: -55.5 }),
      geoFarm('c', { name: 'Gama', latitude: null, longitude: null }),
    ], []);
    assert.deepEqual(sortFarms(farms, 'name', 'asc').map((farm) => farm.name), ['Alfa', 'Beta', 'Gama']);
    assert.deepEqual(sortFarms(farms, 'traffic', 'desc').map((farm) => farm.name), ['Alfa', 'Beta', 'Gama']);
    assert.deepEqual(sortFarms(farms, 'nearest', 'desc').map((farm) => farm.name).at(-1), 'Gama');
    assert.deepEqual(sortFarms(farms, 'nearest', 'asc').map((farm) => farm.name).at(-1), 'Gama');
  });

  test('bytes em unidades decimais', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1_500_000), '1,5 MB');
    assert.equal(formatBytes(Number.NaN), '0 B');
  });
});

describe('configuração do mapa base e CSP', () => {
  test('padrão é o OpenFreeMap; none desliga; só https; caminho relativo usa o próprio Malha', () => {
    assert.deepEqual(resolveMapStyle(undefined), { kind: 'remote', url: 'https://tiles.openfreemap.org/styles/dark', origin: 'https://tiles.openfreemap.org' });
    assert.deepEqual(resolveMapStyle('none'), { kind: 'none' });
    assert.deepEqual(resolveMapStyle('http://tiles.example/style.json'), { kind: 'none' });
    assert.deepEqual(resolveMapStyle('https://user:senha@tiles.example/s.json'), { kind: 'none' });
    assert.deepEqual(resolveMapStyle('javascript:alert(1)'), { kind: 'none' });
    assert.deepEqual(resolveMapStyle('/mapa/estilo.json'), { kind: 'local', url: '/mapa/estilo.json' });
    assert.deepEqual(resolveMapStyle('//evil.example/s.json'), { kind: 'none' });
  });

  test('origens extras aceitam só https exato, sem curinga nem caminho', () => {
    assert.deepEqual(parseExtraOrigins('https://a.example, https://b.example:8443/,*.example,https://*.c.example,http://d.example,https://e.example/path,lixo'),
      ['https://a.example', 'https://b.example:8443']);
    assert.deepEqual(parseExtraOrigins(undefined), []);
  });

  test('a CSP recebe a origem do estilo e as extras, e nada quando o mapa base está desligado', () => {
    assert.deepEqual(mapCspOrigins(resolveMapStyle(undefined), undefined), ['https://tiles.openfreemap.org']);
    assert.deepEqual(mapCspOrigins(resolveMapStyle('https://tiles.example/s.json'), 'https://cdn.example'), ['https://cdn.example', 'https://tiles.example']);
    assert.deepEqual(mapCspOrigins(resolveMapStyle('none'), 'https://cdn.example'), []);
    assert.deepEqual(mapCspOrigins(resolveMapStyle('/estilo.json'), undefined), []);
  });

  test('o worker do MapLibre tem CSP própria com as mesmas origens e nada além de conexões e imagens', async () => {
    const rules = await nextConfig.headers!();
    const worker = rules.find((rule) => rule.source.includes('maplibre-gl-worker'));
    const policy = worker?.headers.find((header) => header.key === 'Content-Security-Policy')?.value;
    assert.equal(policy, `default-src 'none'; connect-src 'self' ${mapCspOrigins().join(' ')}; img-src 'self' data: blob:`);
    const site = rules.find((rule) => rule.source === '/:path((?!entrar$).+)')?.headers[0].value ?? '';
    assert.doesNotMatch(site, /openfreemap/, 'as páginas estáticas não ganham as origens do mapa');
  });
});

describe('escopo do mapa', () => {
  after(async () => (await database()).close());

  test('técnico de uma fazenda e outro grupo não veem nomes, distâncias nem somas de outras fazendas', async () => {
    const db = await database();
    const all = buildMapFarms((await geo(db, admin, new URLSearchParams({ period: '7d' }))).farms, []);
    assert.ok(all.length >= 7);
    assert.ok(new Set(aggregateByArea(all, 'uf').map((area) => area.key)).size >= 5, 'demo cobre vários estados');
    assert.ok(all.find((farm) => farm.farmId === VALE_VERDE)?.nearest, 'admin vê a vizinha');

    const technician: Principal = { ...admin, role: 'tecnico', farmIds: [VALE_VERDE] };
    const scoped = buildMapFarms((await geo(db, technician, new URLSearchParams({ period: '7d' }))).farms, []);
    assert.deepEqual(scoped.map((farm) => farm.farmId), [VALE_VERDE]);
    assert.equal(scoped[0].nearest, null, 'a fazenda mais próxima nunca vem de fora do escopo');
    const areas = aggregateByArea(scoped, 'region');
    assert.deepEqual(areas.map((area) => [area.label, area.farms]), [['Centro-Oeste', 1]]);
    assert.equal(areas[0].trafficBytes, scoped[0].trafficBytes, 'soma só da fazenda permitida');

    const outsider: Principal = { orgId: randomUUID(), actor: 'fora', role: 'admin', farmIds: null, demo: false };
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [outsider.orgId, 'Outro grupo do mapa']);
    const foreign = buildMapFarms((await geo(db, outsider, new URLSearchParams())).farms, []);
    assert.deepEqual(foreign, []);
    assert.deepEqual(toFeatureCollection(foreign, 'traffic').features, []);
  });
});
