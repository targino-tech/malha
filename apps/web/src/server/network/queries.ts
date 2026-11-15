import { z } from 'zod';
import { ASSET_FROM, ASSET_STATUS } from '../assets';
import { requireFarm } from '../authz';
import { classify, VENDORS } from '../catalog';
import { setOrg, type Database, type Queryable } from '../db';
import { HttpError, uuidPattern } from '../http';
import type { Principal } from '../identity';
import type {
  DevicePort, DevicePorts, DeviceRole, Geo, Topology, TopologyEdge, TopologyNode, TrafficPeriod, TrafficSeries, TrafficSource, VlanSummary,
} from './types';

export const MAX_TOPOLOGY_NODES = 2000;
export const MAX_RANGE_DAYS = 31;
const MAX_POINTS = 500;
const BUCKETS = [300, 900, 3600, 21_600, 86_400];
const PERIODS: Record<TrafficPeriod, number> = { '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400 };

const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : null;
const num = (value: string | number | null | undefined) => value === null || value === undefined ? null : Number(value);
const notFound = () => new HttpError(404, 'Fazenda indisponível.');

function parse<T extends z.ZodType>(schema: T, params: URLSearchParams): z.infer<T> {
  const result = schema.safeParse(Object.fromEntries(params));
  if (!result.success) throw new HttpError(400, 'Parâmetros inválidos.');
  return result.data;
}

/** Fazenda informada precisa estar no escopo do usuário e existir no grupo; caso contrário responde 404. */
async function scopedFarm(tx: Queryable, user: Principal, farmId: string) {
  if (!uuidPattern.test(farmId)) throw notFound();
  requireFarm(user, farmId);
  const { rows } = await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2', [user.orgId, farmId]);
  if (!rows.length) throw notFound();
}

async function scoped<T>(database: Database, user: Principal, operation: (tx: Queryable) => Promise<T>) {
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    return operation(tx);
  });
}

const GATEWAY_WORDS = /\b(gateway|udm|usg|uxg|ucg|udr|roteador|router|firewall)\b/i;

/** Papel do dispositivo na topologia: recursos UniFi primeiro, depois o texto do cadastro pelo catálogo. */
export function roleOf(asset: { category: string | null; name: string | null; model: string | null; features?: string[] | null }): DeviceRole {
  const text = `${asset.category ?? ''} ${asset.name ?? ''} ${asset.model ?? ''}`;
  if (GATEWAY_WORDS.test(text)) return 'gateway';
  const features = asset.features ?? [];
  if (features.includes('accessPoint')) return 'ap';
  if (features.includes('switching')) return 'switch';
  const { family } = classify(asset);
  if (family === 'wifi') return 'ap';
  if (family === 'radio') return 'radio';
  if (family === 'core') return /switch|usw/i.test(text) ? 'switch' : 'gateway';
  return 'other';
}

const vendorLabel = (asset: Parameters<typeof classify>[0]) => {
  const { vendor } = classify(asset);
  return vendor ? VENDORS.find((item) => item.id === vendor)?.label ?? null : null;
};

// ---------------------------------------------------------------------------------------------- topologia

const topologyQuery = z.object({ farmId: z.string() });

export async function topology(database: Database, user: Principal, params: URLSearchParams): Promise<Topology> {
  const { farmId } = parse(topologyQuery, params);
  return scoped(database, user, async (tx) => {
    await scopedFarm(tx, user, farmId);
    // Nós: ativos de rede (UniFi, com portas ou com ligação). Ativos arquivados ficam fora.
    const { rows } = await tx.query<{
      id: string; name: string; category: string; model: string | null; ip: string | null; mac: string | null; status: TopologyNode['status'];
      critical: boolean; last_observed_at: Date | null; network_features: string[] | null; ports_observed_at: Date | null; ports_total: string | null; ports_up: string | null;
      up_rx: string | null; up_tx: string | null; up_at: Date | null;
    }>(`
      SELECT a.id, a.name, a.category, a.model, a.ip, a.mac, ${ASSET_STATUS} AS status, a.critical, a.last_observed_at, a.network_features, a.ports_observed_at,
        p.total AS ports_total, p.up AS ports_up, u.rx_bps AS up_rx, u.tx_bps AS up_tx, u.observed_at AS up_at
      FROM ${ASSET_FROM}
      LEFT JOIN LATERAL (SELECT count(*) AS total, count(*) FILTER (WHERE dp.state = 'UP') AS up FROM device_ports dp
        WHERE dp.org_id = a.org_id AND dp.farm_id = a.farm_id AND dp.asset_id = a.id) p ON true
      LEFT JOIN LATERAL (SELECT s.rx_bps, s.tx_bps, s.observed_at FROM traffic_samples s
        WHERE s.org_id = a.org_id AND s.farm_id = a.farm_id AND s.asset_id = a.id AND s.kind = 'uplink'
        ORDER BY s.observed_at DESC LIMIT 1) u ON true
      WHERE a.org_id = $1 AND a.farm_id = $2 AND a.archived_at IS NULL
        AND (a.source = 'unifi' OR p.total > 0 OR EXISTS (SELECT 1 FROM network_links l WHERE l.org_id = a.org_id AND l.farm_id = a.farm_id
          AND (l.from_asset_id = a.id OR l.to_asset_id = a.id)))
      ORDER BY a.name, a.id LIMIT $3`, [user.orgId, farmId, MAX_TOPOLOGY_NODES + 1]);
    const truncated = rows.length > MAX_TOPOLOGY_NODES;
    const nodes: TopologyNode[] = rows.slice(0, MAX_TOPOLOGY_NODES).map((row) => {
      const descriptor = { category: row.category, name: row.name, model: row.model, features: row.network_features };
      return {
        assetId: row.id, name: row.name, role: roleOf(descriptor), vendor: vendorLabel(descriptor) ?? (row.network_features ? 'Ubiquiti' : null),
        model: row.model, ip: row.ip, mac: row.mac, status: row.status, critical: row.critical, lastObservedAt: iso(row.last_observed_at),
        ports: Number(row.ports_total ?? 0) > 0 || row.ports_observed_at ? { total: Number(row.ports_total ?? 0), up: Number(row.ports_up ?? 0) } : null,
        uplink: row.up_at ? { rxBps: Number(row.up_rx), txBps: Number(row.up_tx), observedAt: iso(row.up_at)! } : null,
      };
    });
    const ids = new Set(nodes.map((node) => node.assetId));
    const { rows: links } = await tx.query<{
      from_asset_id: string; to_asset_id: string; level: TopologyEdge['level']; evidence: TopologyEdge['evidence'];
      from_port_idx: number | null; to_port_idx: number | null; first_seen_at: Date; last_seen_at: Date;
    }>(`SELECT from_asset_id, to_asset_id, level, evidence, from_port_idx, to_port_idx, first_seen_at, last_seen_at
      FROM network_links WHERE org_id = $1 AND farm_id = $2 ORDER BY from_asset_id, evidence`, [user.orgId, farmId]);
    const edges: TopologyEdge[] = links.filter((link) => ids.has(link.from_asset_id) && ids.has(link.to_asset_id)).map((link) => ({
      from: link.from_asset_id, to: link.to_asset_id, level: link.level, evidence: link.evidence,
      // Defesa extra: porta a porta só com as duas pontas identificadas.
      fromPortIdx: link.level === 'port' ? link.from_port_idx : null, toPortIdx: link.level === 'port' ? link.to_port_idx : null,
      firstSeenAt: iso(link.first_seen_at)!, lastSeenAt: iso(link.last_seen_at)!, synthetic: link.evidence === 'synthetic',
    }));
    return { farmId, generatedAt: new Date().toISOString(), nodes, edges, truncated };
  });
}

// ---------------------------------------------------------------------------------------------- portas

export async function devicePorts(database: Database, user: Principal, assetId: string): Promise<DevicePorts> {
  if (!uuidPattern.test(assetId)) throw new HttpError(404, 'Ativo não encontrado.');
  return scoped(database, user, async (tx) => {
    const { rows: [asset] } = await tx.query<{ farm_id: string; name: string; category: string; model: string | null; network_features: string[] | null; read: boolean }>(`
      SELECT a.farm_id, a.name, a.category, a.model, a.network_features,
        (a.ports_observed_at IS NOT NULL OR EXISTS (SELECT 1 FROM device_ports p WHERE p.org_id = a.org_id AND p.farm_id = a.farm_id
          AND p.asset_id = a.id)) AS read
      FROM assets a WHERE a.org_id = $1 AND a.id = $2 AND ($3::uuid[] IS NULL OR a.farm_id = ANY($3::uuid[]))`,
    [user.orgId, assetId, user.farmIds]);
    if (!asset) throw new HttpError(404, 'Ativo não encontrado.');
    const { rows } = await tx.query<Record<string, unknown> & { idx: number; tagged_vlan_ids: number[] | null; observed_at: Date }>(`
      SELECT p.*, nv.name AS native_name,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('vlanId', t.v, 'name', v.name) ORDER BY t.v), '[]'::jsonb)
          FROM unnest(coalesce(p.tagged_vlan_ids, '{}')) AS t(v)
          LEFT JOIN LATERAL (SELECT name FROM network_vlans x WHERE x.org_id = p.org_id AND x.farm_id = p.farm_id AND x.vlan_id = t.v
            ORDER BY x.id LIMIT 1) v ON true) AS tagged
      FROM device_ports p
      LEFT JOIN LATERAL (SELECT name FROM network_vlans x WHERE x.org_id = p.org_id AND x.farm_id = p.farm_id AND x.vlan_id = p.native_vlan_id
        ORDER BY x.id LIMIT 1) nv ON true
      WHERE p.org_id = $1 AND p.farm_id = $2 AND p.asset_id = $3 ORDER BY p.idx`, [user.orgId, asset.farm_id, assetId]);
    const ports: DevicePort[] = rows.map((row) => {
      const hasCounters = ['rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets', 'rx_errors', 'tx_errors', 'rx_dropped', 'tx_dropped']
        .some((key) => row[key] !== null);
      const poe = row.poe_standard !== null || row.poe_enabled !== null || row.poe_state !== null || row.poe_power_mw !== null;
      return {
        idx: row.idx, name: row.name as string | null, state: row.state as string, connector: row.connector as string | null,
        speedMbps: num(row.speed_mbps as string | null), maxSpeedMbps: num(row.max_speed_mbps as string | null),
        poe: poe ? { standard: row.poe_standard as string | null, enabled: row.poe_enabled as boolean | null, state: row.poe_state as string | null,
          powerMw: num(row.poe_power_mw as number | null) } : null,
        nativeVlan: row.native_vlan_id !== null ? { vlanId: Number(row.native_vlan_id), name: row.native_name as string | null } : null,
        taggedVlans: row.tagged as DevicePort['taggedVlans'],
        rxBps: num(row.rx_bps as string | null), txBps: num(row.tx_bps as string | null),
        counters: hasCounters ? {
          rxBytes: num(row.rx_bytes as string | null), txBytes: num(row.tx_bytes as string | null),
          rxPackets: num(row.rx_packets as string | null), txPackets: num(row.tx_packets as string | null),
          rxErrors: num(row.rx_errors as string | null), txErrors: num(row.tx_errors as string | null),
          rxDropped: num(row.rx_dropped as string | null), txDropped: num(row.tx_dropped as string | null),
        } : null,
        observedAt: iso(row.observed_at)!, synthetic: row.synthetic as boolean,
      };
    });
    const descriptor = { category: asset.category, name: asset.name, model: asset.model, features: asset.network_features };
    return { assetId, farmId: asset.farm_id, name: asset.name, role: roleOf(descriptor), ports: asset.read ? ports : null };
  });
}

// ---------------------------------------------------------------------------------------------- VLANs

const vlanQuery = z.object({
  farmId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});

export async function vlanSummary(database: Database, user: Principal, params: URLSearchParams): Promise<VlanSummary> {
  const query = parse(vlanQuery, params);
  const offset = Number(query.cursor ?? 0);
  return scoped(database, user, async (tx) => {
    if (query.farmId) await scopedFarm(tx, user, query.farmId);
    const farmIds = query.farmId ? [query.farmId] : user.farmIds;
    const { rows } = await tx.query<{
      farm_id: string; farm_name: string; id: string; name: string; vlan_id: number | null; subnet: string | null; enabled: boolean | null;
      management: string | null; native_ports: string; tagged_ports: string; observed_at: Date; synthetic: boolean; total: string;
    }>(`
      SELECT v.farm_id, f.name AS farm_name, v.id, v.name, v.vlan_id, v.subnet::text AS subnet, v.enabled, v.management, v.observed_at, v.synthetic,
        (SELECT count(*) FROM device_ports p WHERE p.org_id = v.org_id AND p.farm_id = v.farm_id AND p.native_vlan_id = v.vlan_id) AS native_ports,
        (SELECT count(*) FROM device_ports p WHERE p.org_id = v.org_id AND p.farm_id = v.farm_id AND v.vlan_id = ANY(p.tagged_vlan_ids)) AS tagged_ports,
        count(*) OVER () AS total
      FROM network_vlans v JOIN farms f ON f.org_id = v.org_id AND f.id = v.farm_id
      WHERE v.org_id = $1 AND ($2::uuid[] IS NULL OR v.farm_id = ANY($2::uuid[]))
      ORDER BY f.name, v.farm_id, v.vlan_id NULLS FIRST, v.name, v.id LIMIT $3 OFFSET $4`, [user.orgId, farmIds, query.limit, offset]);
    const total = Number(rows[0]?.total ?? 0);
    return {
      items: rows.map((row) => ({
        farmId: row.farm_id, farmName: row.farm_name, id: row.id, name: row.name, vlanId: row.vlan_id, subnet: row.subnet, enabled: row.enabled,
        management: row.management, nativePorts: Number(row.native_ports), taggedPorts: Number(row.tagged_ports),
        observedAt: iso(row.observed_at)!, synthetic: row.synthetic,
      })),
      total,
      nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------- tráfego

const rangeQuery = z.object({
  period: z.enum(['24h', '7d', '30d']).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** Resolve o período pedido em um intervalo fechado, limitado a 31 dias e sem futuro. */
export function resolveRange(params: { period?: TrafficPeriod; from?: string; to?: string }, now = Date.now()) {
  if (params.period && (params.from || params.to)) throw new HttpError(400, 'Use period ou from/to, não os dois.');
  let to = params.to ? Date.parse(params.to) : now;
  let from = params.from ? Date.parse(params.from) : to - PERIODS[params.period ?? '24h'] * 1000;
  if (params.from && !params.to) to = Math.min(now, from + PERIODS['24h'] * 1000);
  if (!params.from && params.to) from = to - PERIODS['24h'] * 1000;
  if (!(from < to) || to > now + 300_000 || to - from > MAX_RANGE_DAYS * 86_400_000) throw new HttpError(400, 'Intervalo inválido.');
  const span = (to - from) / 1000;
  const bucketSeconds = BUCKETS.find((bucket) => span / bucket <= MAX_POINTS) ?? BUCKETS.at(-1)!;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucketSeconds };
}

const trafficQuery = rangeQuery.extend({
  farmId: z.string(),
  assetId: z.string().regex(uuidPattern).optional(),
  portIdx: z.coerce.number().int().min(1).max(10_000).optional(),
}).refine((query) => query.portIdx === undefined || query.assetId !== undefined);

/** Raízes da fazenda: dispositivos sem ligação a montante. A soma dos seus uplinks é o tráfego da fazenda. */
const ROOT_FILTER = `NOT EXISTS (SELECT 1 FROM network_links l WHERE l.org_id = s.org_id AND l.farm_id = s.farm_id AND l.from_asset_id = s.asset_id)`;

export async function traffic(database: Database, user: Principal, params: URLSearchParams): Promise<TrafficSeries> {
  const query = parse(trafficQuery, params);
  const range = resolveRange(query);
  return scoped(database, user, async (tx) => {
    await scopedFarm(tx, user, query.farmId);
    if (query.assetId) {
      const { rows } = await tx.query('SELECT 1 FROM assets WHERE org_id = $1 AND farm_id = $2 AND id = $3', [user.orgId, query.farmId, query.assetId]);
      if (!rows.length) throw new HttpError(404, 'Ativo não encontrado.');
    }
    const kind = query.portIdx !== undefined ? 'port' : query.assetId ? 'uplink' : 'farm';
    const filter = kind === 'farm' ? `s.kind = 'uplink' AND ${ROOT_FILTER}`
      : kind === 'uplink' ? `s.kind = 'uplink' AND s.asset_id = $6` : `s.kind = 'port' AND s.asset_id = $6 AND s.port_idx = $7`;
    const values: unknown[] = [user.orgId, query.farmId, range.from, range.to, range.bucketSeconds];
    if (kind !== 'farm') values.push(query.assetId);
    if (kind === 'port') values.push(query.portIdx);
    // Média por dispositivo e intervalo, depois soma entre dispositivos (só a fazenda agrega vários).
    const where = `s.org_id = $1 AND s.farm_id = $2 AND s.observed_at >= $3::timestamptz AND s.observed_at < $4::timestamptz AND ${filter}`;
    const { rows } = await tx.query<{ t: Date; rx: string; tx: string; rx_max: string; tx_max: string; rx_bytes: string; tx_bytes: string; n: string }>(`
      WITH per_device AS (
        SELECT date_bin(make_interval(secs => $5), s.observed_at, $3::timestamptz) AS t, s.asset_id,
          avg(s.rx_bps) AS rx, avg(s.tx_bps) AS tx, max(s.rx_bps) AS rx_max, max(s.tx_bps) AS tx_max,
          sum(s.rx_bps::numeric * s.interval_seconds / 8) AS rx_bytes, sum(s.tx_bps::numeric * s.interval_seconds / 8) AS tx_bytes,
          count(*) AS n
        FROM traffic_samples s WHERE ${where}
        GROUP BY 1, 2
      )
      SELECT t, round(sum(rx)) AS rx, round(sum(tx)) AS tx, sum(rx_max) AS rx_max, sum(tx_max) AS tx_max,
        round(sum(rx_bytes)) AS rx_bytes, round(sum(tx_bytes)) AS tx_bytes, sum(n) AS n
      FROM per_device GROUP BY t ORDER BY t`, values);
    const { rows: found } = await tx.query<{ source: TrafficSource }>(`SELECT DISTINCT s.source FROM traffic_samples s WHERE ${where}
      AND $5::int > 0 ORDER BY 1`, values);
    const sources = found.map((row) => row.source);
    return {
      scope: { farmId: query.farmId, assetId: query.assetId ?? null, portIdx: query.portIdx ?? null, kind },
      ...range,
      sources,
      points: rows.map((row) => ({
        t: iso(row.t)!, rxBps: Number(row.rx), txBps: Number(row.tx), rxMaxBps: Number(row.rx_max), txMaxBps: Number(row.tx_max),
        rxBytes: Number(row.rx_bytes), txBytes: Number(row.tx_bytes), samples: Number(row.n),
      })),
    };
  });
}

// ---------------------------------------------------------------------------------------------- mapa

const geoQuery = z.object({ period: z.enum(['24h', '7d', '30d']).default('24h') });

export async function geo(database: Database, user: Principal, params: URLSearchParams): Promise<Geo> {
  const { period } = parse(geoQuery, params);
  const range = resolveRange({ period });
  return scoped(database, user, async (tx) => {
    const { rows } = await tx.query<{
      id: string; name: string; location: string; latitude: number | null; longitude: number | null; rx_bytes: string | null; tx_bytes: string | null;
      offline: string; assets: string; open_occurrences: string; collector_id: string | null; captures: string; batches: string;
      payload_bytes: string | null; last_capture_at: Date | null; synthetic: boolean;
    }>(`
      SELECT f.id, f.name, f.location, f.latitude, f.longitude,
        (SELECT round(sum(s.rx_bps::numeric * s.interval_seconds / 8)) FROM traffic_samples s WHERE s.org_id = f.org_id AND s.farm_id = f.id
          AND s.kind = 'uplink' AND s.observed_at >= $3 AND s.observed_at < $4 AND ${ROOT_FILTER}) AS rx_bytes,
        (SELECT round(sum(s.tx_bps::numeric * s.interval_seconds / 8)) FROM traffic_samples s WHERE s.org_id = f.org_id AND s.farm_id = f.id
          AND s.kind = 'uplink' AND s.observed_at >= $3 AND s.observed_at < $4 AND ${ROOT_FILTER}) AS tx_bytes,
        (SELECT count(*) FROM ${ASSET_FROM} WHERE a.org_id = f.org_id AND a.farm_id = f.id AND a.archived_at IS NULL AND ${ASSET_STATUS} = 'offline') AS offline,
        (SELECT count(*) FROM assets a WHERE a.org_id = f.org_id AND a.farm_id = f.id AND a.archived_at IS NULL) AS assets,
        (SELECT count(*) FROM occurrences o WHERE o.org_id = f.org_id AND o.farm_id = f.id AND o.resolved_at IS NULL) AS open_occurrences,
        k.collector_id, h.last_capture_at,
        (SELECT count(*) FROM captures c WHERE c.org_id = f.org_id AND c.farm_id = f.id AND c.observed_at >= $3 AND c.observed_at < $4) AS captures,
        (SELECT count(*) FROM capture_batches b WHERE b.org_id = f.org_id AND b.farm_id = f.id AND b.received_at >= $3 AND b.received_at < $4) AS batches,
        (SELECT sum(b.payload_bytes) FROM capture_batches b WHERE b.org_id = f.org_id AND b.farm_id = f.id AND b.received_at >= $3 AND b.received_at < $4) AS payload_bytes,
        EXISTS (SELECT 1 FROM traffic_samples s WHERE s.org_id = f.org_id AND s.farm_id = f.id AND s.source = 'synthetic') AS synthetic
      FROM farms f
      LEFT JOIN collector_keys k ON k.org_id = f.org_id AND k.farm_id = f.id AND k.revoked_at IS NULL
      LEFT JOIN collector_health h ON h.org_id = k.org_id AND h.farm_id = k.farm_id AND h.collector_id = k.collector_id
      WHERE f.org_id = $1 AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[]))
      ORDER BY f.name, f.id`, [user.orgId, user.farmIds, range.from, range.to]);
    return {
      period, from: range.from, to: range.to,
      farms: rows.map((row) => ({
        farmId: row.id, name: row.name, location: row.location, latitude: row.latitude, longitude: row.longitude,
        metrics: {
          trafficRxBytes: Number(row.rx_bytes ?? 0), trafficTxBytes: Number(row.tx_bytes ?? 0),
          offlineAssets: Number(row.offline), assets: Number(row.assets), openOccurrences: Number(row.open_occurrences),
          collector: row.collector_id ? { captures: Number(row.captures), batches: Number(row.batches), payloadBytes: Number(row.payload_bytes ?? 0),
            lastCaptureAt: iso(row.last_capture_at) } : null,
        },
        synthetic: row.synthetic,
      })),
    };
  });
}
