/**
 * Painel macro da rede: indicadores, tráfego somado, tráfego por fazenda, maiores consumidores, VLANs e
 * utilização das portas por switch. Uma única consulta escopada (grupo + fazendas do usuário) para a aba
 * "Rede" dos Painéis. Contrato em docs/painel-graficos.md.
 */
import { z } from 'zod';
import { ASSET_FROM, ASSET_STATUS } from '../assets';
import type { Database } from '../db';
import type { Principal } from '../identity';
import { parse, resolveRange, roleOf, ROOT_FILTER, scoped, scopedFarm } from './queries';
import type { AssetStatus, DeviceRole, TrafficPeriod, TrafficPoint, TrafficSource } from './types';

export const TOP_LIMIT = 8;
export const MAX_SWITCHES = 40;
/** Teto de ativos com portas lidos para achar os switches; acima disso a resposta marca corte. */
export const SWITCH_CANDIDATE_LIMIT = 2000;
/** Teto de portas por switch na tira de calor (acima do maior switch de 52 portas com uplinks). */
export const MAX_PORTS_PER_SWITCH = 128;

export type PanelKpis = {
  ports: { up: number; down: number; other: number; total: number; devices: number };
  /** Utilização (0–1) das portas com série por porta no período. Nulo quando a fonte não expõe contadores por porta. */
  utilization: { avg: number; peak: number; peakAt: string; peakPort: { assetId: string; name: string; idx: number }; ports: number } | null;
  /** Soma dos contadores acumulados (desde o último reinício de cada equipamento). Nulo sem contadores. */
  errors: { rxErrors: number; txErrors: number; rxDropped: number; txDropped: number; ports: number } | null;
  /** powerMw nulo quando nenhuma porta informa potência (a API de Integrações do UniFi não informa). */
  poe: { activePorts: number; powerMw: number | null; measuredPorts: number };
  vlans: { enabled: number; total: number };
  devices: { offline: number; total: number };
};

export type PanelFarm = {
  farmId: string;
  name: string;
  rxBytes: number;
  txBytes: number;
  peakBps: number;
  /** Série curta (RX + TX médios por intervalo). Intervalos sem amostra não aparecem. */
  spark: Array<{ t: string; bps: number }>;
  synthetic: boolean;
};

export type PanelDevice = {
  assetId: string; farmId: string; farmName: string; name: string; role: DeviceRole; rxBytes: number; txBytes: number; peakBps: number;
};

export type PanelPort = {
  assetId: string; farmId: string; farmName: string; device: string; idx: number; name: string | null;
  rxBps: number; txBps: number; speedMbps: number | null; utilization: number | null; synthetic: boolean;
};

export type PanelVlan = { vlanId: number | null; name: string; farms: number; nativePorts: number; taggedPorts: number; enabled: boolean; synthetic: boolean };

export type HeatPort = { idx: number; name: string | null; state: string; speedMbps: number | null; utilization: number | null; poe: boolean };

export type PanelSwitch = { assetId: string; farmId: string; farmName: string; name: string; status: AssetStatus; ports: HeatPort[] };

export type NetworkPanel = {
  period: TrafficPeriod;
  farmId: string | null;
  from: string;
  to: string;
  bucketSeconds: number;
  sources: TrafficSource[];
  /** Verdadeiro quando algum dado exibido é fictício (demo). */
  synthetic: boolean;
  kpis: PanelKpis;
  traffic: TrafficPoint[];
  farms: PanelFarm[];
  topDevices: PanelDevice[];
  topPorts: PanelPort[];
  vlans: PanelVlan[];
  switches: PanelSwitch[];
  switchesTruncated: boolean;
};

// ------------------------------------------------------------------------------------------- funções puras

/** Fração da capacidade usada por uma porta full duplex: o maior sentido sobre a velocidade negociada. */
export function utilization(rxBps: number | null, txBps: number | null, speedMbps: number | null): number | null {
  if (rxBps === null || txBps === null || !speedMbps || speedMbps <= 0) return null;
  return Math.min(1, Math.max(0, Math.max(rxBps, txBps) / (speedMbps * 1e6)));
}

export type BucketRow = {
  farmId: string; t: string; rxBps: number; txBps: number; rxMaxBps: number; txMaxBps: number; rxBytes: number; txBytes: number; samples: number;
};

/** Soma as séries por fazenda num total por instante e devolve também a série de cada fazenda. */
export function mergeSeries(rows: BucketRow[]) {
  const total = new Map<string, TrafficPoint>();
  const byFarm = new Map<string, BucketRow[]>();
  for (const row of rows) {
    const point = total.get(row.t) ?? { t: row.t, rxBps: 0, txBps: 0, rxMaxBps: 0, txMaxBps: 0, rxBytes: 0, txBytes: 0, samples: 0 };
    point.rxBps += row.rxBps; point.txBps += row.txBps; point.rxMaxBps += row.rxMaxBps; point.txMaxBps += row.txMaxBps;
    point.rxBytes += row.rxBytes; point.txBytes += row.txBytes; point.samples += row.samples;
    total.set(row.t, point);
    const list = byFarm.get(row.farmId) ?? [];
    list.push(row);
    byFarm.set(row.farmId, list);
  }
  const ordered = [...total.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  for (const list of byFarm.values()) list.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { total: ordered, byFarm };
}

/** Agrupa o catálogo de VLANs de várias fazendas pelo número da VLAN, com o nome mais frequente. */
export function groupVlans(rows: Array<{ farmId: string; vlanId: number | null; name: string; enabled: boolean | null; nativePorts: number; taggedPorts: number; synthetic: boolean }>): PanelVlan[] {
  const groups = new Map<string, { vlanId: number | null; names: Map<string, number>; farms: Set<string>; nativePorts: number; taggedPorts: number; enabled: boolean; synthetic: boolean }>();
  for (const row of rows) {
    // VLAN sem número (rede sem tag) fica separada por nome.
    const key = row.vlanId === null ? `sem-vlan:${row.name}` : String(row.vlanId);
    const group = groups.get(key) ?? { vlanId: row.vlanId, names: new Map(), farms: new Set(), nativePorts: 0, taggedPorts: 0, enabled: false, synthetic: false };
    group.names.set(row.name, (group.names.get(row.name) ?? 0) + 1);
    group.farms.add(row.farmId);
    group.nativePorts += row.nativePorts;
    group.taggedPorts += row.taggedPorts;
    group.enabled ||= row.enabled !== false;
    group.synthetic ||= row.synthetic;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    vlanId: group.vlanId,
    name: [...group.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'))[0][0],
    farms: group.farms.size, nativePorts: group.nativePorts, taggedPorts: group.taggedPorts, enabled: group.enabled, synthetic: group.synthetic,
  })).sort((a, b) => (b.nativePorts + b.taggedPorts) - (a.nativePorts + a.taggedPorts) || (a.vlanId ?? 0) - (b.vlanId ?? 0));
}

// ------------------------------------------------------------------------------------------- consulta

const panelQuery = z.object({ farmId: z.string().optional(), period: z.enum(['24h', '7d', '30d']).default('24h') });

/** Ativos de rede: os mesmos critérios dos nós da topologia (UniFi, com portas ou com ligação), sem arquivados. */
const NETWORK_ASSET = `a.archived_at IS NULL AND (a.source = 'unifi'
  OR EXISTS (SELECT 1 FROM device_ports p WHERE p.org_id = a.org_id AND p.farm_id = a.farm_id AND p.asset_id = a.id)
  OR EXISTS (SELECT 1 FROM network_links l WHERE l.org_id = a.org_id AND l.farm_id = a.farm_id AND (l.from_asset_id = a.id OR l.to_asset_id = a.id)))`;

const n = (value: string | number | null | undefined) => Number(value ?? 0);
const iso = (value: Date | string) => new Date(value).toISOString();

export async function networkPanel(database: Database, user: Principal, params: URLSearchParams): Promise<NetworkPanel> {
  const query = parse(panelQuery, params);
  const range = resolveRange({ period: query.period });
  return scoped(database, user, async (tx) => {
    if (query.farmId) await scopedFarm(tx, user, query.farmId);
    // Escopo: uma fazenda conferida acima, ou todas as fazendas do usuário (nulo = todas do grupo). O RLS fixa o grupo.
    const farms = query.farmId ? [query.farmId] : user.farmIds;
    const scope = [user.orgId, farms];
    const inScope = (alias: string) => `${alias}.org_id = $1 AND ($2::uuid[] IS NULL OR ${alias}.farm_id = ANY($2::uuid[]))`;
    const window = [...scope, range.from, range.to];

    const { rows: [ports] } = await tx.query<Record<string, string | null>>(`
      SELECT count(*) FILTER (WHERE p.state = 'UP') AS up, count(*) FILTER (WHERE p.state = 'DOWN') AS down, count(*) AS total,
        count(DISTINCT p.asset_id) AS devices,
        count(*) FILTER (WHERE num_nonnulls(p.rx_errors, p.tx_errors, p.rx_dropped, p.tx_dropped) > 0) AS counter_ports,
        sum(p.rx_errors) AS rx_errors, sum(p.tx_errors) AS tx_errors, sum(p.rx_dropped) AS rx_dropped, sum(p.tx_dropped) AS tx_dropped,
        count(*) FILTER (WHERE p.poe_enabled AND p.poe_state = 'UP') AS poe_active,
        count(p.poe_power_mw) AS poe_measured, sum(p.poe_power_mw) AS poe_mw,
        bool_or(p.synthetic) AS synthetic
      FROM device_ports p JOIN assets a ON a.org_id = p.org_id AND a.farm_id = p.farm_id AND a.id = p.asset_id
      WHERE ${inScope('p')} AND a.archived_at IS NULL`, scope);

    const { rows: [devices] } = await tx.query<{ total: string; offline: string }>(`
      SELECT count(*) AS total, count(*) FILTER (WHERE ${ASSET_STATUS} = 'offline') AS offline
      FROM ${ASSET_FROM} WHERE ${inScope('a')} AND ${NETWORK_ASSET}`, scope);

    // Utilização no período: série por porta (contadores) sobre a velocidade atual da porta.
    const { rows: [usage] } = await tx.query<{ avg: string | null; ports: string; peak: string | null; peak_at: Date | null; peak_asset: string | null; peak_name: string | null; peak_idx: number | null }>(`
      WITH u AS (
        SELECT s.asset_id, s.port_idx, s.observed_at, least(1, greatest(s.rx_bps, s.tx_bps)::float8 / (p.speed_mbps * 1e6)) AS ratio
        FROM traffic_samples s JOIN device_ports p ON p.org_id = s.org_id AND p.farm_id = s.farm_id AND p.asset_id = s.asset_id AND p.idx = s.port_idx
        WHERE ${inScope('s')} AND s.kind = 'port' AND s.observed_at >= $3::timestamptz AND s.observed_at < $4::timestamptz AND p.speed_mbps > 0
      ), top AS (SELECT * FROM u ORDER BY ratio DESC, observed_at DESC LIMIT 1)
      SELECT (SELECT avg(ratio) FROM u) AS avg, (SELECT count(DISTINCT (asset_id, port_idx)) FROM u) AS ports,
        top.ratio AS peak, top.observed_at AS peak_at, top.asset_id AS peak_asset, a.name AS peak_name, top.port_idx AS peak_idx
      FROM (SELECT 1) one LEFT JOIN top ON true LEFT JOIN assets a ON a.org_id = $1 AND a.id = top.asset_id`, window);

    const { rows: [vlanCount] } = await tx.query<{ total: string; enabled: string }>(`
      SELECT count(*) AS total, count(*) FILTER (WHERE v.enabled IS DISTINCT FROM false) AS enabled FROM network_vlans v WHERE ${inScope('v')}`, scope);

    // Tráfego: média por dispositivo raiz e intervalo, somada por fazenda (mesma regra de /api/network/traffic).
    const { rows: buckets } = await tx.query<{ farm_id: string; t: Date; rx: string; tx: string; rx_max: string; tx_max: string; rx_bytes: string; tx_bytes: string; n: string }>(`
      WITH per_device AS (
        -- Intervalos alinhados ao relógio (origem fixa), estáveis entre atualizações do painel.
        SELECT s.farm_id, date_bin(make_interval(secs => $5), s.observed_at, timestamptz '2000-01-01 00:00:00+00') AS t, s.asset_id,
          avg(s.rx_bps) AS rx, avg(s.tx_bps) AS tx, max(s.rx_bps) AS rx_max, max(s.tx_bps) AS tx_max,
          sum(s.rx_bps::numeric * s.interval_seconds / 8) AS rx_bytes, sum(s.tx_bps::numeric * s.interval_seconds / 8) AS tx_bytes, count(*) AS n
        FROM traffic_samples s
        WHERE ${inScope('s')} AND s.kind = 'uplink' AND s.observed_at >= $3::timestamptz AND s.observed_at < $4::timestamptz AND ${ROOT_FILTER}
        GROUP BY 1, 2, 3
      )
      SELECT farm_id, t, round(sum(rx)) AS rx, round(sum(tx)) AS tx, sum(rx_max) AS rx_max, sum(tx_max) AS tx_max,
        round(sum(rx_bytes)) AS rx_bytes, round(sum(tx_bytes)) AS tx_bytes, sum(n) AS n
      FROM per_device GROUP BY farm_id, t ORDER BY t`, [...window, range.bucketSeconds]);

    const { rows: found } = await tx.query<{ source: TrafficSource }>(`
      SELECT DISTINCT s.source FROM traffic_samples s
      WHERE ${inScope('s')} AND s.observed_at >= $3::timestamptz AND s.observed_at < $4::timestamptz ORDER BY 1`, window);

    const { rows: farmRows } = await tx.query<{ id: string; name: string }>(`
      SELECT f.id, f.name FROM farms f WHERE f.org_id = $1 AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[])) ORDER BY f.name, f.id`, scope);

    const { rows: deviceRows } = await tx.query<{ id: string; farm_id: string; farm_name: string; name: string; category: string; model: string | null; network_features: string[] | null; rx_bytes: string; tx_bytes: string; peak: string }>(`
      SELECT a.id, a.farm_id, f.name AS farm_name, a.name, a.category, a.model, a.network_features, t.rx_bytes, t.tx_bytes, t.peak
      FROM (SELECT s.farm_id, s.asset_id, round(sum(s.rx_bps::numeric * s.interval_seconds / 8)) AS rx_bytes,
          round(sum(s.tx_bps::numeric * s.interval_seconds / 8)) AS tx_bytes, max(s.rx_bps + s.tx_bps) AS peak
        FROM traffic_samples s WHERE ${inScope('s')} AND s.kind = 'uplink' AND s.observed_at >= $3::timestamptz AND s.observed_at < $4::timestamptz
        GROUP BY 1, 2) t
      JOIN assets a ON a.org_id = $1 AND a.farm_id = t.farm_id AND a.id = t.asset_id AND a.archived_at IS NULL
      JOIN farms f ON f.org_id = a.org_id AND f.id = a.farm_id
      ORDER BY t.rx_bytes + t.tx_bytes DESC, a.name, a.id LIMIT ${TOP_LIMIT}`, window);

    const { rows: portRows } = await tx.query<{ asset_id: string; farm_id: string; farm_name: string; device: string; idx: number; name: string | null; rx_bps: string; tx_bps: string; speed_mbps: string | null; synthetic: boolean }>(`
      SELECT p.asset_id, p.farm_id, f.name AS farm_name, a.name AS device, p.idx, p.name, p.rx_bps, p.tx_bps, p.speed_mbps, p.synthetic
      FROM device_ports p JOIN assets a ON a.org_id = p.org_id AND a.farm_id = p.farm_id AND a.id = p.asset_id AND a.archived_at IS NULL
      JOIN farms f ON f.org_id = p.org_id AND f.id = p.farm_id
      WHERE ${inScope('p')} AND p.rx_bps IS NOT NULL AND p.tx_bps IS NOT NULL
      ORDER BY p.rx_bps + p.tx_bps DESC, a.name, p.idx LIMIT ${TOP_LIMIT}`, scope);

    const { rows: vlanRows } = await tx.query<{ farm_id: string; vlan_id: number | null; name: string; enabled: boolean | null; native_ports: string; tagged_ports: string; synthetic: boolean }>(`
      SELECT v.farm_id, v.vlan_id, v.name, v.enabled, v.synthetic,
        (SELECT count(*) FROM device_ports p WHERE p.org_id = v.org_id AND p.farm_id = v.farm_id AND p.native_vlan_id = v.vlan_id) AS native_ports,
        (SELECT count(*) FROM device_ports p WHERE p.org_id = v.org_id AND p.farm_id = v.farm_id AND v.vlan_id = ANY(p.tagged_vlan_ids)) AS tagged_ports
      FROM network_vlans v WHERE ${inScope('v')}`, scope);

    // Duas etapas com limite no SQL: primeiro uma lista leve de candidatos (sem as portas), classificada
    // em JS pela mesma regra da topologia; depois as portas só dos switches que vão aparecer.
    const { rows: candidateRows } = await tx.query<{ id: string; farm_id: string; farm_name: string; name: string; category: string; model: string | null; network_features: string[] | null; status: AssetStatus }>(`
      SELECT a.id, a.farm_id, f.name AS farm_name, a.name, a.category, a.model, a.network_features, ${ASSET_STATUS} AS status
      FROM ${ASSET_FROM} JOIN farms f ON f.org_id = a.org_id AND f.id = a.farm_id
      WHERE ${inScope('a')} AND a.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM device_ports p WHERE p.org_id = a.org_id AND p.farm_id = a.farm_id AND p.asset_id = a.id)
      ORDER BY f.name, a.name, a.id
      LIMIT ${SWITCH_CANDIDATE_LIMIT}`, scope);
    const switchCandidates = candidateRows.filter((row) => roleOf({ category: row.category, name: row.name, model: row.model, features: row.network_features }) === 'switch');
    const shownSwitches = switchCandidates.slice(0, MAX_SWITCHES);
    const { rows: switchPortRows } = shownSwitches.length ? await tx.query<HeatPortRow & { asset_id: string }>(`
      SELECT p.asset_id, p.idx, p.name, p.state, p.speed_mbps AS "speedMbps", p.rx_bps AS "rxBps", p.tx_bps AS "txBps",
        coalesce(p.poe_enabled AND p.poe_state = 'UP', false) AS poe
      FROM unnest($3::uuid[]) AS s(asset_id)
      CROSS JOIN LATERAL (
        SELECT * FROM device_ports p WHERE ${inScope('p')} AND p.asset_id = s.asset_id ORDER BY p.idx LIMIT ${MAX_PORTS_PER_SWITCH}
      ) p
      ORDER BY p.asset_id, p.idx`, [...scope, shownSwitches.map((row) => row.id)]) : { rows: [] };
    const portsBySwitch = new Map<string, HeatPortRow[]>();
    for (const { asset_id: assetId, ...port } of switchPortRows) portsBySwitch.set(assetId, [...(portsBySwitch.get(assetId) ?? []), port]);
    const switchesTruncated = switchCandidates.length > MAX_SWITCHES || candidateRows.length === SWITCH_CANDIDATE_LIMIT;

    const { total, byFarm } = mergeSeries(buckets.map((row) => ({
      farmId: row.farm_id, t: iso(row.t), rxBps: n(row.rx), txBps: n(row.tx), rxMaxBps: n(row.rx_max), txMaxBps: n(row.tx_max),
      rxBytes: n(row.rx_bytes), txBytes: n(row.tx_bytes), samples: n(row.n),
    })));
    const sources = found.map((row) => row.source);
    const synthetic = sources.includes('synthetic') || Boolean(ports?.synthetic) || vlanRows.some((row) => row.synthetic);
    const switches = shownSwitches
      .map((row) => ({
        assetId: row.id, farmId: row.farm_id, farmName: row.farm_name, name: row.name, status: row.status,
        ports: (portsBySwitch.get(row.id) ?? []).map((port) => ({
          idx: port.idx, name: port.name, state: port.state, speedMbps: port.speedMbps === null ? null : Number(port.speedMbps),
          utilization: utilization(port.rxBps === null ? null : Number(port.rxBps), port.txBps === null ? null : Number(port.txBps), port.speedMbps === null ? null : Number(port.speedMbps)),
          poe: port.poe,
        })),
      }));

    const usageKnown = usage && usage.avg !== null && usage.peak !== null && usage.peak_asset && usage.peak_at && usage.peak_idx !== null;
    return {
      period: query.period, farmId: query.farmId ?? null, ...range, sources, synthetic,
      kpis: {
        ports: { up: n(ports?.up), down: n(ports?.down), other: n(ports?.total) - n(ports?.up) - n(ports?.down), total: n(ports?.total), devices: n(ports?.devices) },
        utilization: usageKnown ? {
          avg: Number(usage.avg), peak: Number(usage.peak), peakAt: iso(usage.peak_at!), ports: n(usage.ports),
          peakPort: { assetId: usage.peak_asset!, name: usage.peak_name ?? 'Dispositivo', idx: usage.peak_idx! },
        } : null,
        errors: n(ports?.counter_ports) > 0 ? {
          rxErrors: n(ports?.rx_errors), txErrors: n(ports?.tx_errors), rxDropped: n(ports?.rx_dropped), txDropped: n(ports?.tx_dropped), ports: n(ports?.counter_ports),
        } : null,
        poe: { activePorts: n(ports?.poe_active), powerMw: n(ports?.poe_measured) > 0 ? n(ports?.poe_mw) : null, measuredPorts: n(ports?.poe_measured) },
        vlans: { enabled: n(vlanCount?.enabled), total: n(vlanCount?.total) },
        devices: { offline: n(devices?.offline), total: n(devices?.total) },
      },
      traffic: total,
      farms: farmRows.map((farm) => {
        const series = byFarm.get(farm.id) ?? [];
        return {
          farmId: farm.id, name: farm.name,
          rxBytes: series.reduce((sum, row) => sum + row.rxBytes, 0), txBytes: series.reduce((sum, row) => sum + row.txBytes, 0),
          peakBps: series.reduce((max, row) => Math.max(max, row.rxMaxBps + row.txMaxBps), 0),
          spark: series.map((row) => ({ t: row.t, bps: row.rxBps + row.txBps })),
          synthetic,
        };
      }),
      topDevices: deviceRows.map((row) => ({
        assetId: row.id, farmId: row.farm_id, farmName: row.farm_name, name: row.name,
        role: roleOf({ category: row.category, name: row.name, model: row.model, features: row.network_features }),
        rxBytes: n(row.rx_bytes), txBytes: n(row.tx_bytes), peakBps: n(row.peak),
      })),
      topPorts: portRows.map((row) => {
        const speed = row.speed_mbps === null ? null : Number(row.speed_mbps);
        return {
          assetId: row.asset_id, farmId: row.farm_id, farmName: row.farm_name, device: row.device, idx: row.idx, name: row.name,
          rxBps: n(row.rx_bps), txBps: n(row.tx_bps), speedMbps: speed, utilization: utilization(n(row.rx_bps), n(row.tx_bps), speed), synthetic: row.synthetic,
        };
      }),
      vlans: groupVlans(vlanRows.map((row) => ({
        farmId: row.farm_id, vlanId: row.vlan_id, name: row.name, enabled: row.enabled, nativePorts: n(row.native_ports), taggedPorts: n(row.tagged_ports), synthetic: row.synthetic,
      }))),
      switches,
      switchesTruncated,
    };
  });
}

type HeatPortRow = { idx: number; name: string | null; state: string; speedMbps: number | string | null; rxBps: number | string | null; txBps: number | string | null; poe: boolean };
