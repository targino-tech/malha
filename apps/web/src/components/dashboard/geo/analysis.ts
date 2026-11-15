import type { DashboardFarm } from '../../../server/dashboard';
import type { GeoFarm } from '../../../server/network/types';

/**
 * Geoprocessamento do mapa: saúde por fazenda, métricas do mapa de calor, agregação por UF e região,
 * distância até a fazenda mais próxima e ordenação da tabela. Tudo puro, sem DOM, para testar em node:test.
 * As fazendas chegam já filtradas pelo escopo do usuário (API /api/network/geo e /api/dashboard).
 */

export type Health = 'critical' | 'warning' | 'missing' | 'healthy';

/** Ordem de gravidade: o agregado (cluster, UF, região) mostra a pior. */
export const HEALTH: Record<Health, { label: string; rank: number; color: string }> = {
  healthy: { label: 'Saudável', rank: 0, color: '#b6f37a' },
  missing: { label: 'Sem coletor', rank: 1, color: '#9aac9d' },
  warning: { label: 'Atenção', rank: 2, color: '#f1b45b' },
  critical: { label: 'Crítico', rank: 3, color: '#ff8f85' },
};
export const HEALTH_BY_RANK: Health[] = ['healthy', 'missing', 'warning', 'critical'];

export type MetricKey = 'traffic' | 'offline' | 'occurrences' | 'collector';
export const METRICS: Record<MetricKey, { label: string; short: string; unit: 'bytes' | 'count' }> = {
  traffic: { label: 'Volume de tráfego', short: 'Tráfego', unit: 'bytes' },
  offline: { label: 'Ativos offline', short: 'Offline', unit: 'count' },
  occurrences: { label: 'Ocorrências abertas', short: 'Ocorrências', unit: 'count' },
  collector: { label: 'Dados enviados pelo coletor', short: 'Dados enviados', unit: 'bytes' },
};

export type MapFarm = {
  farmId: string;
  name: string;
  location: string;
  uf: string | null;
  region: Region | null;
  latitude: number | null;
  longitude: number | null;
  health: Health;
  synthetic: boolean;
  trafficBytes: number;
  offlineAssets: number;
  assets: number;
  openOccurrences: number;
  collector: GeoFarm['metrics']['collector'];
  collectorStatus: DashboardFarm['collectorStatus'] | null;
  offlineCritical: number;
  nearest: { farmId: string; name: string; km: number } | null;
};

export type Region = 'Norte' | 'Nordeste' | 'Centro-Oeste' | 'Sudeste' | 'Sul';

const REGION_BY_UF: Record<string, Region> = {
  AC: 'Norte', AP: 'Norte', AM: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte',
  AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste', PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste',
  DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
  ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste',
  PR: 'Sul', RS: 'Sul', SC: 'Sul',
};

/** Extrai a UF do campo `location` ("Rio Verde · GO", "Sorriso - MT", "Cascavel/PR"). Sem UF válida: null. */
export function parseUf(location: string): string | null {
  const match = /(?:^|[\s·,/–-])([A-Za-z]{2})\s*$/.exec(location.trim());
  if (!match) return null;
  const uf = match[1].toUpperCase();
  return uf in REGION_BY_UF ? uf : null;
}

export function regionOf(uf: string | null): Region | null {
  return uf ? REGION_BY_UF[uf] ?? null : null;
}

/**
 * Saúde da fazenda: crítico com coletor sem contato ou ativo crítico offline; atenção com ativo offline ou
 * ocorrência aberta; sem coletor quando não há coletor ativo; senão saudável.
 */
export function farmHealth(geo: GeoFarm, dashboard: DashboardFarm | undefined): Health {
  if (dashboard?.collectorStatus === 'offline' || (dashboard?.offlineCriticalCount ?? 0) > 0) return 'critical';
  if (geo.metrics.offlineAssets > 0 || geo.metrics.openOccurrences > 0) return 'warning';
  if (!geo.metrics.collector || dashboard?.collectorStatus === 'missing') return 'missing';
  return 'healthy';
}

export function worstHealth(values: Iterable<Health>): Health {
  let rank = -1;
  for (const value of values) rank = Math.max(rank, HEALTH[value].rank);
  return rank < 0 ? 'healthy' : HEALTH_BY_RANK[rank];
}

function validCoordinate(latitude: number | null, longitude: number | null) {
  return latitude !== null && longitude !== null && Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

export function isLocated(farm: Pick<MapFarm, 'latitude' | 'longitude'>): farm is MapFarm & { latitude: number; longitude: number } {
  return validCoordinate(farm.latitude, farm.longitude);
}

const EARTH_KM = 6371.0088;

/** Distância do grande círculo, em km. */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Fazenda posicionada mais próxima de cada uma. O(n²), adequado para centenas de fazendas por grupo. */
export function nearestFarms<T extends { farmId: string; name: string; latitude: number | null; longitude: number | null }>(farms: T[]) {
  const located = farms.filter((farm) => validCoordinate(farm.latitude, farm.longitude)) as Array<T & { latitude: number; longitude: number }>;
  const result = new Map<string, { farmId: string; name: string; km: number }>();
  for (const farm of located) {
    let best: { farmId: string; name: string; km: number } | null = null;
    for (const other of located) {
      if (other.farmId === farm.farmId) continue;
      const km = haversineKm(farm, other);
      if (!best || km < best.km) best = { farmId: other.farmId, name: other.name, km };
    }
    if (best) result.set(farm.farmId, best);
  }
  return result;
}

/** Junta os indicadores da API de mapa com o estado do painel (coletor, críticos offline). */
export function buildMapFarms(geoFarms: GeoFarm[], dashboardFarms: DashboardFarm[]): MapFarm[] {
  const byId = new Map(dashboardFarms.map((farm) => [farm.id, farm]));
  const nearest = nearestFarms(geoFarms);
  return geoFarms.map((farm) => {
    const dashboard = byId.get(farm.farmId);
    const uf = parseUf(farm.location);
    const located = validCoordinate(farm.latitude, farm.longitude);
    return {
      farmId: farm.farmId, name: farm.name, location: farm.location, uf, region: regionOf(uf),
      latitude: located ? farm.latitude : null, longitude: located ? farm.longitude : null,
      health: farmHealth(farm, dashboard), synthetic: farm.synthetic,
      trafficBytes: farm.metrics.trafficRxBytes + farm.metrics.trafficTxBytes,
      offlineAssets: farm.metrics.offlineAssets, assets: farm.metrics.assets, openOccurrences: farm.metrics.openOccurrences,
      collector: farm.metrics.collector, collectorStatus: dashboard?.collectorStatus ?? null,
      offlineCritical: dashboard?.offlineCriticalCount ?? 0,
      nearest: nearest.get(farm.farmId) ?? null,
    };
  });
}

export function metricValue(farm: MapFarm, metric: MetricKey): number {
  switch (metric) {
    case 'traffic': return farm.trafficBytes;
    case 'offline': return farm.offlineAssets;
    case 'occurrences': return farm.openOccurrences;
    case 'collector': return farm.collector?.payloadBytes ?? 0;
  }
}

/**
 * Peso do mapa de calor entre 0 e 1, relativo ao maior valor entre as fazendas visíveis. Raiz quadrada para
 * que uma fazenda muito maior não apague as demais. Zero continua zero (não aparece no calor).
 */
export function heatWeights(farms: MapFarm[], metric: MetricKey): Map<string, number> {
  const max = Math.max(0, ...farms.map((farm) => metricValue(farm, metric)));
  return new Map(farms.map((farm) => {
    const value = metricValue(farm, metric);
    return [farm.farmId, max > 0 && value > 0 ? Math.sqrt(value / max) : 0];
  }));
}

export type AreaSummary = {
  key: string;
  label: string;
  farms: number;
  located: number;
  trafficBytes: number;
  offlineAssets: number;
  assets: number;
  openOccurrences: number;
  collectorBytes: number;
  captures: number;
  health: Health;
};

/** Soma as fazendas por UF ou por região. Fazenda sem UF reconhecida cai em "Sem UF". */
export function aggregateByArea(farms: MapFarm[], by: 'uf' | 'region'): AreaSummary[] {
  const groups = new Map<string, AreaSummary & { healths: Health[] }>();
  for (const farm of farms) {
    const key = (by === 'uf' ? farm.uf : farm.region) ?? '';
    const group = groups.get(key) ?? {
      key, label: key || (by === 'uf' ? 'Sem UF' : 'Sem região'), farms: 0, located: 0, trafficBytes: 0, offlineAssets: 0, assets: 0,
      openOccurrences: 0, collectorBytes: 0, captures: 0, health: 'healthy' as Health, healths: [],
    };
    group.farms += 1;
    if (isLocated(farm)) group.located += 1;
    group.trafficBytes += farm.trafficBytes;
    group.offlineAssets += farm.offlineAssets;
    group.assets += farm.assets;
    group.openOccurrences += farm.openOccurrences;
    group.collectorBytes += farm.collector?.payloadBytes ?? 0;
    group.captures += farm.collector?.captures ?? 0;
    group.healths.push(farm.health);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ healths, ...group }) => ({ ...group, health: worstHealth(healths) }))
    .sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0) || b.farms - a.farms || a.label.localeCompare(b.label, 'pt-BR'));
}

export type SortKey = 'name' | 'uf' | 'health' | MetricKey | 'nearest';

export function sortFarms(farms: MapFarm[], key: SortKey, direction: 'asc' | 'desc'): MapFarm[] {
  const sign = direction === 'asc' ? 1 : -1;
  const value = (farm: MapFarm): number | string | null => {
    switch (key) {
      case 'name': return farm.name;
      case 'uf': return farm.uf;
      case 'health': return HEALTH[farm.health].rank;
      case 'nearest': return farm.nearest?.km ?? null;
      default: return metricValue(farm, key);
    }
  };
  return [...farms].sort((a, b) => {
    const va = value(a), vb = value(b);
    // Valores ausentes ficam sempre no fim, em qualquer direção.
    if (va === null || vb === null) return va === vb ? a.name.localeCompare(b.name, 'pt-BR') : va === null ? 1 : -1;
    const compare = typeof va === 'string' ? va.localeCompare(vb as string, 'pt-BR') : va - (vb as number);
    return compare * sign || a.name.localeCompare(b.name, 'pt-BR');
  });
}

/** Enquadramento [oeste, sul, leste, norte] das fazendas posicionadas, ou null sem nenhuma. */
export function boundsOf(farms: MapFarm[]): [number, number, number, number] | null {
  const located = farms.filter(isLocated);
  if (!located.length) return null;
  const lons = located.map((farm) => farm.longitude);
  const lats = located.map((farm) => farm.latitude);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

type Feature = {
  type: 'Feature';
  id: number;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { farmId: string; name: string; severity: number; heat: number };
};

/**
 * GeoJSON das fazendas posicionadas. As propriedades levam só id, nome (para o rótulo) e números: o popup
 * busca o resto na lista em memória e monta o DOM com textContent.
 */
export function toFeatureCollection(farms: MapFarm[], metric: MetricKey): { type: 'FeatureCollection'; features: Feature[] } {
  const weights = heatWeights(farms, metric);
  return {
    type: 'FeatureCollection',
    features: farms.filter(isLocated).map((farm, index) => ({
      type: 'Feature', id: index,
      geometry: { type: 'Point', coordinates: [farm.longitude, farm.latitude] },
      properties: { farmId: farm.farmId, name: farm.name, severity: HEALTH[farm.health].rank, heat: weights.get(farm.farmId) ?? 0 },
    })),
  };
}

const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('pt-BR');

/** Bytes em unidades decimais (kB, MB, GB, TB), como nas faturas de link. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${unit === 0 ? integer.format(Math.round(value)) : decimal.format(value)} ${units[unit]}`;
}

export function formatKm(km: number): string {
  return km < 10 ? `${decimal.format(km)} km` : `${integer.format(Math.round(km))} km`;
}

export function formatMetric(value: number, metric: MetricKey): string {
  return METRICS[metric].unit === 'bytes' ? formatBytes(value) : integer.format(value);
}
