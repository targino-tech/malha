import { evaluateOrganization } from './alerts';
import { ASSET_FROM, ASSET_STATUS } from './assets';
import { permissionsOf, type Permission } from './authz';
import { principal } from './identity';
import { database, setOrg, type Queryable } from './db';
import { HEARTBEAT_TIMEOUT_SECONDS } from './health';
import { listOccurrences, type DashboardOccurrence } from './occurrences';

const DEMO_ONLINE_COLLECTOR = '00000000-0000-4000-8000-000000000301';

export type DashboardFarm = {
  id: string;
  name: string;
  location: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  collectorStatus: 'online' | 'offline' | 'missing';
  lastHeartbeatAt: string | null;
  lastCaptureAt: string | null;
  assetCount: number;
  unifiCount: number;
  criticalCount: number;
  offlineCount: number;
  offlineCriticalCount: number;
  openOccurrences: number;
};

export type TechnicalLocation = { id: string; farmId: string; name: string };

export type DashboardData = {
  demo: boolean;
  actor: string;
  role: string;
  can: Record<Permission, boolean>;
  generatedAt: string;
  farms: DashboardFarm[];
  locations: TechnicalLocation[];
  occurrences: DashboardOccurrence[];
  counts: { farms: number; collectorsOnline: number; assets: number; offlineCritical: number; openOccurrences: number };
};

// O demo não executa o worker: mantém o coletor simulado em contato e avalia as regras a cada consulta.
async function simulateDemo(tx: Queryable, orgId: string) {
  await tx.query(`UPDATE collector_health SET last_heartbeat_at = now(), last_capture_at = now()
    WHERE org_id = $1 AND collector_id = $2`, [orgId, DEMO_ONLINE_COLLECTOR]);
  await tx.query('UPDATE assets SET last_observed_at = now() WHERE org_id = $1 AND last_collector_id = $2', [orgId, DEMO_ONLINE_COLLECTOR]);
  await evaluateOrganization(tx, orgId);
}

const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;

export async function getDashboard(): Promise<DashboardData> {
  const user = await principal();
  const db = await database();
  return db.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    if (user.demo) await simulateDemo(tx, user.orgId);
    const scope = [user.orgId, user.farmIds];
    const { rows: [{ now }] } = await tx.query<{ now: Date }>('SELECT now() AS now');
    const { rows: farmRows } = await tx.query<{
      id: string; name: string; location: string; timezone: string; latitude: number | null; longitude: number | null; collector_id: string | null; online: boolean | null;
      last_heartbeat_at: Date | null; last_capture_at: Date | null;
    }>(`SELECT f.id, f.name, f.location, f.timezone, f.latitude, f.longitude, h.last_heartbeat_at, h.last_capture_at, k.collector_id,
         h.last_heartbeat_at >= now() - make_interval(secs => ${HEARTBEAT_TIMEOUT_SECONDS}) AS online
       FROM farms f LEFT JOIN collector_keys k ON k.org_id = f.org_id AND k.farm_id = f.id AND k.revoked_at IS NULL
       LEFT JOIN collector_health h ON h.org_id = f.org_id AND h.farm_id = f.id AND h.collector_id = k.collector_id
       WHERE f.org_id = $1 AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[])) ORDER BY f.name`, scope);

    const { rows: totals } = await tx.query<{ farm_id: string; assets: string; unifi: string; critical: string; offline: string; offline_critical: string }>(`
      SELECT farm_id, count(*) AS assets, count(*) FILTER (WHERE source = 'unifi') AS unifi, count(*) FILTER (WHERE critical) AS critical,
        count(*) FILTER (WHERE status = 'offline') AS offline, count(*) FILTER (WHERE status = 'offline' AND critical) AS offline_critical
      FROM (SELECT a.farm_id, a.source, a.critical, ${ASSET_STATUS} AS status FROM ${ASSET_FROM}
        WHERE a.org_id = $1 AND ($2::uuid[] IS NULL OR a.farm_id = ANY($2::uuid[])) AND a.archived_at IS NULL) current
      GROUP BY farm_id`, scope);
    const byFarm = new Map(totals.map((row) => [row.farm_id, row]));

    const occurrences = await listOccurrences(tx, user.orgId, user.farmIds);
    const farms: DashboardFarm[] = farmRows.map((row) => {
      const total = byFarm.get(row.id);
      return {
        id: row.id, name: row.name, location: row.location, timezone: row.timezone,
        latitude: row.latitude === null ? null : Number(row.latitude), longitude: row.longitude === null ? null : Number(row.longitude),
        collectorStatus: !row.collector_id ? 'missing' : row.online ? 'online' : 'offline',
        lastHeartbeatAt: iso(row.last_heartbeat_at), lastCaptureAt: iso(row.last_capture_at),
        assetCount: Number(total?.assets ?? 0), unifiCount: Number(total?.unifi ?? 0), criticalCount: Number(total?.critical ?? 0),
        offlineCount: Number(total?.offline ?? 0), offlineCriticalCount: Number(total?.offline_critical ?? 0),
        openOccurrences: occurrences.filter((occurrence) => occurrence.farmId === row.id && !occurrence.resolvedAt).length,
      };
    });
    const { rows: locations } = await tx.query<{ id: string; farm_id: string; name: string }>(`SELECT id, farm_id, name
      FROM technical_locations WHERE org_id = $1 AND ($2::uuid[] IS NULL OR farm_id = ANY($2::uuid[])) ORDER BY name`, scope);

    return {
      demo: user.demo, actor: user.actor, role: user.role, can: permissionsOf(user), generatedAt: new Date(now).toISOString(), farms,
      locations: locations.map((location) => ({ id: location.id, farmId: location.farm_id, name: location.name })), occurrences,
      counts: {
        farms: farms.length, collectorsOnline: farms.filter((farm) => farm.collectorStatus === 'online').length,
        assets: farms.reduce((sum, farm) => sum + farm.assetCount, 0),
        offlineCritical: farms.reduce((sum, farm) => sum + farm.offlineCriticalCount, 0),
        openOccurrences: occurrences.filter((occurrence) => !occurrence.resolvedAt).length,
      },
    };
  });
}
