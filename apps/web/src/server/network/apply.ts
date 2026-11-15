import type { Queryable } from '../db';
import type { Device, Network } from '../collector';
import { ratesFromReadings, type CounterReading } from './rates';

/** Intervalo nominal entre capturas do coletor (5 min), usado para estimar volume a partir de taxas. */
export const CAPTURE_INTERVAL_SECONDS = 300;
/** Janela de leituras de contador usada para recalcular taxas quando uma leitura chega fora de ordem. */
const COUNTER_WINDOW = "interval '2 hours'";
/** Leituras lidas para o recálculo: a janela mais a folga do maior intervalo aceito (rates.ts). */
const READ_WINDOW = "interval '3 hours'";

type Prefix = [orgId: string, farmId: string, collectorId: string];

/**
 * Aplica os campos de rede de uma captura completa (schemaVersion 2) dentro da transação da projeção.
 * `latest` indica que a captura é a mais nova já aplicada: só então portas, VLANs e ligações são substituídas.
 * A série de tráfego é registrada também para capturas atrasadas, pois cada amostra tem o seu próprio instante.
 * Tudo é idempotente: reaplicar a mesma captura não duplica nem altera linhas.
 */
export async function applyNetwork(tx: Queryable, prefix: Prefix, observedAt: string, devices: Device[], networks: Network[] | null, latest: boolean) {
  const [orgId, farmId] = prefix;
  await recordUplinkRates(tx, prefix, observedAt, devices);
  await recordCounters(tx, prefix, observedAt, devices);
  if (!latest) return;

  const withFeatures = devices.filter((device) => device.features !== undefined);
  if (withFeatures.length) {
    await tx.query(`UPDATE assets a SET network_features = d.features
      FROM jsonb_to_recordset($3::jsonb) AS d(id text, features text[])
      WHERE a.org_id = $1 AND a.farm_id = $2 AND a.external_id = d.id`,
    [orgId, farmId, JSON.stringify(withFeatures.map((device) => ({ id: device.id, features: device.features })))]);
  }

  // Portas: só dispositivos cujas portas foram lidas nesta captura. Lista vazia remove as portas antigas.
  const read = devices.filter((device) => device.ports !== undefined);
  if (read.length) {
    const ids = read.map((device) => device.id);
    await tx.query(`UPDATE assets SET ports_observed_at = $4 WHERE org_id = $1 AND farm_id = $2 AND external_id = ANY($3::text[])
      AND (ports_observed_at IS NULL OR ports_observed_at <= $4)`, [orgId, farmId, ids, observedAt]);
    await tx.query(`DELETE FROM device_ports p USING assets a
      WHERE p.org_id = $1 AND p.farm_id = $2 AND a.org_id = p.org_id AND a.farm_id = p.farm_id AND a.id = p.asset_id
        AND a.external_id = ANY($3::text[]) AND p.observed_at <= $4`, [orgId, farmId, ids, observedAt]);
    const ports = read.flatMap((device) => (device.ports ?? []).map((port) => ({
      deviceId: device.id, idx: port.idx, name: port.name, state: port.state?.toUpperCase() ?? 'UNKNOWN', connector: port.connector,
      speedMbps: port.speedMbps ?? null, maxSpeedMbps: port.maxSpeedMbps ?? null,
      poeStandard: port.poe?.standard ?? null, poeEnabled: port.poe?.enabled ?? null, poeState: port.poe?.state ?? null,
      poePowerMw: port.poe?.powerMw ?? null, nativeVlanId: port.nativeVlanId ?? null, taggedVlanIds: port.taggedVlanIds ?? null,
      rxBytes: port.rxBytes, txBytes: port.txBytes, rxPackets: port.rxPackets, txPackets: port.txPackets,
      rxErrors: port.rxErrors, txErrors: port.txErrors, rxDropped: port.rxDropped, txDropped: port.txDropped,
    })));
    if (ports.length) {
      await tx.query(`INSERT INTO device_ports (org_id, farm_id, asset_id, idx, name, state, connector, speed_mbps, max_speed_mbps,
          poe_standard, poe_enabled, poe_state, poe_power_mw, native_vlan_id, tagged_vlan_ids,
          rx_bytes, tx_bytes, rx_packets, tx_packets, rx_errors, tx_errors, rx_dropped, tx_dropped, rx_bps, tx_bps, observed_at, collector_id)
        SELECT $1, $2, a.id, p."idx", p.name, p.state, p.connector, p."speedMbps", p."maxSpeedMbps",
          p."poeStandard", p."poeEnabled", p."poeState", p."poePowerMw", p."nativeVlanId", p."taggedVlanIds",
          p."rxBytes", p."txBytes", p."rxPackets", p."txPackets", p."rxErrors", p."txErrors", p."rxDropped", p."txDropped",
          s.rx_bps, s.tx_bps, $4, $3
        FROM jsonb_to_recordset($5::jsonb) AS p("deviceId" text, "idx" int, name text, state text, connector text, "speedMbps" bigint,
          "maxSpeedMbps" bigint, "poeStandard" text, "poeEnabled" boolean, "poeState" text, "poePowerMw" int, "nativeVlanId" int,
          "taggedVlanIds" int[], "rxBytes" bigint, "txBytes" bigint, "rxPackets" bigint, "txPackets" bigint, "rxErrors" bigint,
          "txErrors" bigint, "rxDropped" bigint, "txDropped" bigint)
        JOIN assets a ON a.org_id = $1 AND a.farm_id = $2 AND a.external_id = p."deviceId"
        LEFT JOIN traffic_samples s ON s.org_id = $1 AND s.farm_id = $2 AND s.asset_id = a.id AND s.kind = 'port'
          AND s.port_idx = p."idx" AND s.observed_at = $4
        ON CONFLICT (org_id, farm_id, asset_id, idx) DO NOTHING`, [...prefix, observedAt, JSON.stringify(ports)]);
    }
  }

  // VLANs: a lista do site substitui o catálogo da fazenda. Ausente (console sem o recurso) mantém o anterior.
  if (networks) {
    await tx.query(`DELETE FROM network_vlans WHERE org_id = $1 AND farm_id = $2 AND NOT synthetic AND observed_at <= $3`, [orgId, farmId, observedAt]);
    if (networks.length) {
      await tx.query(`INSERT INTO network_vlans (org_id, farm_id, id, name, vlan_id, subnet, enabled, management, observed_at)
        SELECT $1, $2, n.id, coalesce(nullif(n.name, ''), 'VLAN ' || n."vlanId", 'Rede sem nome'), n."vlanId",
          CASE WHEN n.subnet IS NOT NULL THEN network(n.subnet::inet)::cidr END, n.enabled, n.management, $3
        FROM jsonb_to_recordset($4::jsonb) AS n(id text, name text, "vlanId" int, subnet text, enabled boolean, management text)
        ON CONFLICT (org_id, farm_id, id) DO NOTHING`, [orgId, farmId, observedAt, JSON.stringify(networks)]);
    }
  }

  // Ligações: o uplink do UniFi identifica só o dispositivo a montante, então a ligação é entre dispositivos.
  // Dispositivos com detalhe lido (portas presentes) e sem uplink perdem a ligação anterior.
  const detailed = devices.filter((device) => device.ports !== undefined || device.uplinkDeviceId !== undefined);
  if (detailed.length) {
    await tx.query(`DELETE FROM network_links l USING assets a
      WHERE l.org_id = $1 AND l.farm_id = $2 AND l.evidence = 'unifi_uplink' AND a.org_id = l.org_id AND a.farm_id = l.farm_id
        AND a.id = l.from_asset_id AND a.external_id = ANY($3::text[]) AND l.last_seen_at <= $4`,
    [orgId, farmId, detailed.map((device) => device.id), observedAt]);
    const uplinks = detailed.filter((device) => device.uplinkDeviceId).map((device) => ({ id: device.id, upstream: device.uplinkDeviceId }));
    if (uplinks.length) {
      await tx.query(`INSERT INTO network_links (org_id, farm_id, from_asset_id, to_asset_id, evidence, level, first_seen_at, last_seen_at)
        SELECT $1, $2, child.id, parent.id, 'unifi_uplink', 'device', $3, $3
        FROM jsonb_to_recordset($4::jsonb) AS u(id text, upstream text)
        JOIN assets child ON child.org_id = $1 AND child.farm_id = $2 AND child.external_id = u.id
        JOIN assets parent ON parent.org_id = $1 AND parent.farm_id = $2 AND parent.external_id = u.upstream
        WHERE child.id <> parent.id
        ON CONFLICT (org_id, farm_id, from_asset_id, evidence) DO NOTHING`, [orgId, farmId, observedAt, JSON.stringify(uplinks)]);
    }
  }
}

/** Taxa de uplink informada pelo UniFi: amostra direta no instante da captura. */
async function recordUplinkRates(tx: Queryable, prefix: Prefix, observedAt: string, devices: Device[]) {
  const rows = devices.filter((device) => device.uplinkRxBps != null && device.uplinkTxBps != null)
    .map((device) => ({ id: device.id, rx: device.uplinkRxBps, tx: device.uplinkTxBps }));
  if (!rows.length) return;
  await tx.query(`INSERT INTO traffic_samples (org_id, farm_id, asset_id, kind, port_idx, observed_at, rx_bps, tx_bps, interval_seconds, source)
    SELECT $1, $2, a.id, 'uplink', 0, $3, r.rx, r.tx, ${CAPTURE_INTERVAL_SECONDS}, 'unifi_rate'
    FROM jsonb_to_recordset($4::jsonb) AS r(id text, rx bigint, tx bigint)
    JOIN assets a ON a.org_id = $1 AND a.farm_id = $2 AND a.external_id = r.id
    ON CONFLICT DO NOTHING`, [prefix[0], prefix[1], observedAt, JSON.stringify(rows)]);
}

/**
 * Contadores por porta: grava a leitura bruta e recalcula as taxas da janela ao redor dela, para que uma leitura
 * atrasada divida corretamente o intervalo entre as vizinhas. Reinício e estouro de contador são tratados em rates.ts.
 */
async function recordCounters(tx: Queryable, prefix: Prefix, observedAt: string, devices: Device[]) {
  const [orgId, farmId] = prefix;
  const rows = devices.flatMap((device) => (device.ports ?? [])
    .filter((port) => port.rxBytes != null && port.txBytes != null)
    .map((port) => ({ id: device.id, idx: port.idx, rx: port.rxBytes, tx: port.txBytes })));
  if (!rows.length) return;
  const { rows: inserted } = await tx.query<{ asset_id: string; port_idx: number }>(`
    INSERT INTO port_counter_readings (org_id, farm_id, asset_id, port_idx, observed_at, rx_bytes, tx_bytes)
    SELECT $1, $2, a.id, r.idx, $3, r.rx, r.tx
    FROM jsonb_to_recordset($4::jsonb) AS r(id text, idx int, rx bigint, tx bigint)
    JOIN assets a ON a.org_id = $1 AND a.farm_id = $2 AND a.external_id = r.id
    ON CONFLICT DO NOTHING RETURNING asset_id, port_idx`, [orgId, farmId, observedAt, JSON.stringify(rows)]);
  if (!inserted.length) return;
  const keys = JSON.stringify(inserted);
  const { rows: window } = await tx.query<{ asset_id: string; port_idx: number; observed_at: Date; rx_bytes: string | null; tx_bytes: string | null }>(`
    SELECT c.asset_id, c.port_idx, c.observed_at, c.rx_bytes, c.tx_bytes
    FROM port_counter_readings c JOIN jsonb_to_recordset($4::jsonb) AS k(asset_id uuid, port_idx int)
      ON k.asset_id = c.asset_id AND k.port_idx = c.port_idx
    WHERE c.org_id = $1 AND c.farm_id = $2 AND c.observed_at BETWEEN $3::timestamptz - ${READ_WINDOW} AND $3::timestamptz + ${COUNTER_WINDOW}
    ORDER BY c.asset_id, c.port_idx, c.observed_at`, [orgId, farmId, observedAt, keys]);
  const series = new Map<string, { assetId: string; portIdx: number; readings: CounterReading[] }>();
  for (const row of window) {
    const key = `${row.asset_id}:${row.port_idx}`;
    const entry = series.get(key) ?? { assetId: row.asset_id, portIdx: row.port_idx, readings: [] };
    entry.readings.push({ observedAt: row.observed_at, rxBytes: row.rx_bytes === null ? null : Number(row.rx_bytes), txBytes: row.tx_bytes === null ? null : Number(row.tx_bytes) });
    series.set(key, entry);
  }
  const center = new Date(observedAt).getTime();
  const span = 2 * 3600_000;
  const samples = [...series.values()].flatMap((entry) => ratesFromReadings(entry.readings)
    .filter((sample) => Math.abs(new Date(sample.observedAt).getTime() - center) <= span && new Date(sample.observedAt).getTime() !== center - span)
    .map((sample) => ({ assetId: entry.assetId, portIdx: entry.portIdx, ...sample })));
  // Remove as amostras derivadas da janela e grava o recálculo; amostras de fora da janela não mudam.
  await tx.query(`DELETE FROM traffic_samples s USING jsonb_to_recordset($4::jsonb) AS k(asset_id uuid, port_idx int)
    WHERE s.org_id = $1 AND s.farm_id = $2 AND s.kind = 'port' AND s.source = 'counter_delta'
      AND s.asset_id = k.asset_id AND s.port_idx = k.port_idx
      AND s.observed_at > $3::timestamptz - ${COUNTER_WINDOW} AND s.observed_at <= $3::timestamptz + ${COUNTER_WINDOW}`,
  [orgId, farmId, observedAt, keys]);
  if (samples.length) {
    await tx.query(`INSERT INTO traffic_samples (org_id, farm_id, asset_id, kind, port_idx, observed_at, rx_bps, tx_bps, interval_seconds, source)
    SELECT $1, $2, s."assetId", 'port', s."portIdx", s."observedAt", s."rxBps", s."txBps", least(3600, greatest(1, s."intervalSeconds")), 'counter_delta'
    FROM jsonb_to_recordset($3::jsonb) AS s("assetId" uuid, "portIdx" int, "observedAt" timestamptz, "rxBps" bigint, "txBps" bigint, "intervalSeconds" int)
    ON CONFLICT DO NOTHING`, [orgId, farmId, JSON.stringify(samples)]);
  }
  // A taxa exibida na porta acompanha o recálculo da amostra do mesmo instante do estado atual.
  await tx.query(`UPDATE device_ports p SET rx_bps = s.rx_bps, tx_bps = s.tx_bps
    FROM jsonb_to_recordset($3::jsonb) AS k(asset_id uuid, port_idx int), traffic_samples s
    WHERE p.org_id = $1 AND p.farm_id = $2 AND p.asset_id = k.asset_id AND p.idx = k.port_idx
      AND s.org_id = p.org_id AND s.farm_id = p.farm_id AND s.asset_id = p.asset_id AND s.kind = 'port' AND s.port_idx = p.idx
      AND s.observed_at = p.observed_at`, [orgId, farmId, keys]);
}
