import { randomUUID } from 'node:crypto';
import { setOrg, type Database, type Queryable } from './db';
import type { Device } from './collector';

type Job = { id: string; org_id: string; farm_id: string; collector_id: string; capture_id: string; attempts: number };

function status(raw: string | null) {
  const value = raw?.toUpperCase();
  return value === 'ONLINE' ? 'online' : value === 'OFFLINE' ? 'offline' : 'unknown';
}

async function applyCapture(tx: Queryable, job: Job) {
  const prefix = [job.org_id, job.farm_id, job.collector_id];
  const { rows: [active] } = await tx.query(`SELECT 1 FROM collector_keys
    WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 AND revoked_at IS NULL FOR SHARE`, prefix);
  if (!active) return;
  await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2 FOR UPDATE', prefix.slice(0, 2));
  const { rows: [health] } = await tx.query<{ last_sequence: string | number }>(`SELECT last_sequence FROM collector_health
    WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 FOR UPDATE`, prefix);
  const { rows: [capture] } = await tx.query<{ seq: string | number; observed_at: Date; parts: number }>(`SELECT seq, observed_at, parts FROM captures
    WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 AND id = $4`, [...prefix, job.capture_id]);
  if (!capture || !health) throw new Error('Captura ou coletor ausente.');
  if (Number(capture.seq) <= Number(health.last_sequence)) return;
  const { rows: parts } = await tx.query<{ devices: Device[]; part: number }>(`SELECT devices, part FROM capture_batches
    WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 AND capture_id = $4 ORDER BY part`, [...prefix, job.capture_id]);
  if (parts.length !== capture.parts || parts.some((part, i) => part.part !== i + 1)) throw new Error('Captura incompleta.');
  const devices = parts.flatMap((part) => part.devices);
  if (new Set(devices.map((device) => device.id)).size !== devices.length) throw new Error('Há dispositivos duplicados na captura.');
  const macCounts = new Map<string, number>();
  for (const device of devices) if (device.mac) macCounts.set(device.mac, (macCounts.get(device.mac) ?? 0) + 1);
  const observedAt = new Date(capture.observed_at).toISOString();
  const newSequence = Number(capture.seq);
  const consecutive = newSequence === Number(health.last_sequence) + 1;
  const incoming = JSON.stringify(devices.map((device) => ({
    ...device, assetId: randomUUID(), status: status(device.state), linkMac: device.mac && macCounts.get(device.mac) === 1 ? device.mac : null,
  })));

  await tx.query(`WITH incoming AS (
      SELECT id, name, model, mac, ip, firmware, status, "assetId" AS asset_id, "linkMac" AS link_mac
      FROM jsonb_to_recordset($4::jsonb) AS x(id text, name text, model text, mac text, ip text, firmware text, status text, "assetId" uuid, "linkMac" text)
    ), linked AS (
      UPDATE assets a SET external_id = i.id, ip = COALESCE(i.ip, a.ip), mac = COALESCE(i.mac, a.mac),
        model = i.model, firmware = i.firmware, last_observed_at = $5, last_collector_id = $3,
        status = CASE WHEN i.status = 'offline' THEN 'unknown' ELSE i.status END,
        offline_observations = CASE WHEN i.status = 'offline' THEN 1 ELSE 0 END,
        offline_since = CASE WHEN i.status = 'offline' THEN $5::timestamptz END, missing_captures = 0
      FROM incoming i WHERE a.org_id = $1 AND a.farm_id = $2 AND a.mac = i.link_mac AND a.external_id IS NULL
        AND 1 = (SELECT count(*) FROM assets b WHERE b.org_id = $1 AND b.farm_id = $2 AND b.mac = i.link_mac)
        AND NOT EXISTS (SELECT 1 FROM assets b WHERE b.org_id = $1 AND b.farm_id = $2 AND b.external_id = i.id)
      RETURNING a.external_id
    ) INSERT INTO assets (org_id, farm_id, id, name, category, mac, ip, source, external_id, model, firmware, last_observed_at, last_collector_id, status, offline_observations, offline_since)
      SELECT $1, $2, asset_id, COALESCE(name, model, 'Dispositivo UniFi'), COALESCE(model, 'Dispositivo de rede'), mac, ip, 'unifi', id, model, firmware, $5, $3,
        CASE WHEN status = 'offline' THEN 'unknown' ELSE status END, CASE WHEN status = 'offline' THEN 1 ELSE 0 END,
        CASE WHEN status = 'offline' THEN $5::timestamptz END
      FROM incoming WHERE NOT EXISTS (SELECT 1 FROM linked WHERE linked.external_id = incoming.id)
      ON CONFLICT (org_id, farm_id, external_id) DO UPDATE SET
        name = CASE WHEN assets.source = 'unifi' THEN excluded.name ELSE assets.name END,
        ip = COALESCE(excluded.ip, assets.ip), mac = COALESCE(excluded.mac, assets.mac), model = excluded.model,
        firmware = excluded.firmware, last_observed_at = excluded.last_observed_at, last_collector_id = excluded.last_collector_id,
        status = CASE WHEN excluded.offline_observations = 1 AND assets.offline_observations >= 1
          AND $6::boolean AND assets.last_collector_id = $3 AND assets.last_observed_at >= $5::timestamptz - interval '15 minutes'
          THEN 'offline' ELSE excluded.status END,
        offline_observations = CASE WHEN excluded.offline_observations = 1 AND $6::boolean AND assets.last_collector_id = $3
          AND assets.last_observed_at >= $5::timestamptz - interval '15 minutes'
          THEN LEAST(2, assets.offline_observations + 1) ELSE excluded.offline_observations END,
        offline_since = CASE WHEN excluded.offline_since IS NULL THEN NULL
          WHEN assets.offline_observations >= 1 AND $6::boolean AND assets.last_collector_id = $3
            AND assets.last_observed_at >= $5::timestamptz - interval '15 minutes'
          THEN COALESCE(assets.offline_since, excluded.offline_since) ELSE excluded.offline_since END,
        missing_captures = 0`,
  [...prefix, incoming, observedAt, consecutive]);

  // Ativos antes observados que faltam nesta captura completa ficam indeterminados e acumulam ausências.
  await tx.query(`UPDATE assets SET status = 'unknown', offline_observations = 0, offline_since = NULL,
      missing_captures = missing_captures + 1 WHERE org_id = $1 AND farm_id = $2
    AND last_collector_id = $3 AND last_observed_at <> $4 AND external_id IS NOT NULL`, [...prefix, observedAt]);
  await tx.query(`UPDATE collector_health SET last_capture_at = $4, last_sequence = $5
    WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3`, [...prefix, observedAt, newSequence]);
  await tx.query(`UPDATE captures SET applied_at = now() WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 AND id = $4`, [...prefix, job.capture_id]);
}

export async function processInventoryJob(database: Database) {
  return database.transaction(async (tx) => {
    const { rows: [job] } = await tx.query<Job>(`SELECT id, org_id, farm_id, collector_id, capture_id, attempts FROM inventory_outbox
      WHERE finished_at IS NULL AND failed_at IS NULL AND available_at <= now()
      ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!job) return false;
    await setOrg(tx, job.org_id);
    await tx.exec('SAVEPOINT inventory_projection');
    try {
      await applyCapture(tx, job);
      await tx.query('UPDATE inventory_outbox SET finished_at = now() WHERE id = $1', [job.id]);
    } catch (error) {
      await tx.exec('ROLLBACK TO SAVEPOINT inventory_projection');
      const attempts = job.attempts + 1;
      const waitSeconds = Math.min(300, 2 ** attempts) + Math.floor(Math.random() * 3);
      await tx.query(`UPDATE inventory_outbox SET attempts = $2,
        available_at = now() + make_interval(secs => $3),
        failed_at = CASE WHEN $2 >= 8 THEN now() ELSE NULL END WHERE id = $1`, [job.id, attempts, waitSeconds]);
      console.error('Falha ao aplicar captura', job.id, error instanceof Error ? error.name : 'indefinida');
    }
    await tx.exec('RELEASE SAVEPOINT inventory_projection');
    return true;
  });
}
