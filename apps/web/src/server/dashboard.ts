import { evaluateOrganization } from './alerts';
import { principal } from './identity';
import { database, setOrg, type Queryable } from './db';
import { CAPTURE_STALE_SECONDS, HEARTBEAT_TIMEOUT_SECONDS } from './health';
import { listOccurrences, type DashboardOccurrence } from './occurrences';

const DEMO_ONLINE_COLLECTOR = '00000000-0000-4000-8000-000000000301';

export type DashboardFarm = {
  id: string;
  name: string;
  location: string;
  collectorStatus: 'online' | 'offline' | 'missing';
  lastHeartbeatAt: string | null;
  lastCaptureAt: string | null;
  assetCount: number;
  criticalCount: number;
  offlineCount: number;
  openOccurrences: number;
};

export type DashboardAsset = {
  id: string;
  farmId: string;
  name: string;
  category: string;
  tag: string | null;
  ip: string | null;
  mac: string | null;
  critical: boolean;
  source: 'csv' | 'unifi';
  status: 'online' | 'offline' | 'unknown';
  lastObservedAt: string | null;
};

export type DashboardData = {
  demo: boolean;
  canImport: boolean;
  canAcknowledge: boolean;
  generatedAt: string;
  farms: DashboardFarm[];
  assets: DashboardAsset[];
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

export async function getDashboard(): Promise<DashboardData> {
  const user = await principal();
  const db = await database();
  const timestamp = new Date();
  return db.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    if (user.demo) await simulateDemo(tx, user.orgId);
    const { rows: farmRows } = await tx.query<{
      id: string; name: string; location: string; collector_id: string | null;
      last_heartbeat_at: Date | null; last_capture_at: Date | null;
    }>(`SELECT f.id, f.name, f.location, h.last_heartbeat_at, h.last_capture_at, k.collector_id
       FROM farms f LEFT JOIN collector_keys k ON k.org_id = f.org_id AND k.farm_id = f.id AND k.revoked_at IS NULL
       LEFT JOIN collector_health h ON h.org_id = f.org_id AND h.farm_id = f.id AND h.collector_id = k.collector_id
       WHERE f.org_id = $1 ORDER BY f.name`, [user.orgId]);

    const farms = new Map(farmRows.map((row) => {
      const heartbeat = row.last_heartbeat_at && new Date(row.last_heartbeat_at);
      const capture = row.last_capture_at && new Date(row.last_capture_at);
      // The two synthetic collectors keep their demonstration states across visits.
      const simulatedOnline = user.demo && row.collector_id?.endsWith('000301');
      const collectorStatus = !row.collector_id ? 'missing' : simulatedOnline
        || (heartbeat && timestamp.getTime() - heartbeat.getTime() < HEARTBEAT_TIMEOUT_SECONDS * 1000) ? 'online' : 'offline';
      const farm: DashboardFarm = {
        id: row.id, name: row.name, location: row.location, collectorStatus,
        lastHeartbeatAt: simulatedOnline ? timestamp.toISOString() : heartbeat?.toISOString() ?? null,
        lastCaptureAt: simulatedOnline ? timestamp.toISOString() : capture?.toISOString() ?? null,
        assetCount: 0, criticalCount: 0, offlineCount: 0, openOccurrences: 0,
      };
      return [row.id, { farm, collectorId: row.collector_id, simulatedOnline }];
    }));

    const { rows } = await tx.query<{
      id: string; farm_id: string; name: string; category: string; tag: string | null; ip: string | null;
      mac: string | null; critical: boolean; source: DashboardAsset['source']; status: DashboardAsset['status'];
      last_observed_at: Date | null; last_collector_id: string | null;
    }>(`SELECT id, farm_id, name, category, tag, ip, mac, critical, source, status, last_observed_at, last_collector_id
       FROM assets WHERE org_id = $1 ORDER BY name, id`, [user.orgId]);

    let offlineCritical = 0;
    const assets: DashboardAsset[] = rows.map((row) => {
      const details = farms.get(row.farm_id)!;
      const { farm } = details;
      const lastObservedAt = details.simulatedOnline && row.last_observed_at
        ? timestamp.toISOString() : row.last_observed_at ? new Date(row.last_observed_at).toISOString() : null;
      const expiresAt = (lastObservedAt ? Date.parse(lastObservedAt) : 0) + CAPTURE_STALE_SECONDS * 1000;
      const status = lastObservedAt && timestamp.getTime() <= expiresAt && farm.collectorStatus === 'online'
        && row.last_collector_id === details.collectorId ? row.status : 'unknown';
      farm.assetCount++;
      if (row.critical) farm.criticalCount++;
      if (status === 'offline') {
        farm.offlineCount++;
        if (row.critical) offlineCritical++;
      }
      return {
        id: row.id, farmId: row.farm_id, name: row.name, category: row.category, tag: row.tag, ip: row.ip,
        mac: row.mac, critical: row.critical, source: row.source, status, lastObservedAt,
      };
    });

    const occurrences = await listOccurrences(tx, user.orgId);
    for (const occurrence of occurrences) {
      const details = farms.get(occurrence.farmId);
      if (details && !occurrence.resolvedAt) details.farm.openOccurrences++;
    }
    const farmList = [...farms.values()].map(({ farm }) => farm);
    const canOperate = user.role !== 'diretoria';
    return { demo: user.demo, canImport: canOperate, canAcknowledge: canOperate, generatedAt: timestamp.toISOString(), farms: farmList, assets,
      occurrences, counts: { farms: farmList.length, collectorsOnline: farmList.filter((farm) => farm.collectorStatus === 'online').length,
        assets: assets.length, offlineCritical, openOccurrences: occurrences.filter((occurrence) => !occurrence.resolvedAt).length } };
  });
}
