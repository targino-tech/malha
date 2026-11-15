import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { database, hash, mode, setOrg, type Queryable } from './db';
import { HttpError, parseJson, requestBytes, uuidPattern } from './http';
import { normalizedMac } from './network';
import { processInventoryJob } from './projection';

const keySchema = z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) });
const enrollmentSchema = z.object({ code: z.string().min(20).max(120), publicKey: keySchema });
const heartbeatSchema = z.object({ version: z.string().min(1).max(80), queueDepth: z.number().int().min(0).max(1_000_000), healthy: z.boolean() });
const text = (max: number) => z.string().max(max).nullish().transform((value) => value?.trim() || null);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish().transform((value) => value ?? null);
const vlan = z.number().int().min(1).max(4094);
const rate = z.number().int().min(0).max(400e9).nullish().transform((value) => value ?? null);
// Campos de rede da versão 2. Todos opcionais: ausência significa "não lido nesta captura", nunca "zero".
const portSchema = z.object({
  idx: z.number().int().min(0).max(10_000), name: text(80), state: text(40), connector: text(40),
  speedMbps: z.number().int().min(0).max(1_000_000).nullish(), maxSpeedMbps: z.number().int().min(0).max(1_000_000).nullish(),
  poe: z.object({ standard: text(40), type: z.number().int().min(0).max(10).nullish(), enabled: z.boolean().nullish(), state: text(40),
    powerMw: z.number().int().min(0).max(1_000_000).nullish() }).nullish(),
  // Reservados para fontes que exponham VLAN e contadores por porta; o coletor UniFi atual não os envia.
  nativeVlanId: vlan.nullish(), taggedVlanIds: z.array(vlan).max(4094).nullish(),
  rxBytes: counter, txBytes: counter, rxPackets: counter, txPackets: counter,
  rxErrors: counter, txErrors: counter, rxDropped: counter, txDropped: counter,
});
const networkSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().max(120).transform((value) => value.trim()),
  vlanId: vlan.nullish(), enabled: z.boolean().nullish(), management: text(40),
  subnet: z.string().max(50).regex(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/).nullish(),
});
const deviceSchema = z.object({
  id: z.string().min(1).max(200), name: text(200), mac: text(50), ip: text(80), model: text(150), state: text(80), firmware: text(120),
  features: z.array(z.string().min(1).max(40)).max(16).optional(),
  uplinkDeviceId: z.string().min(1).max(200).optional(),
  uplinkTxBps: rate.optional(), uplinkRxBps: rate.optional(),
  ports: z.array(portSchema).max(128).optional()
    .refine((ports) => !ports || new Set(ports.map((port) => port.idx)).size === ports.length),
}).transform((device) => ({ ...device, mac: device.mac ? normalizedMac(device.mac) : null,
  ip: device.ip && isIP(device.ip) ? device.ip : null }));

export type Device = z.infer<typeof deviceSchema>;
export type Port = z.infer<typeof portSchema>;
export type Network = z.infer<typeof networkSchema>;

const batchSchema = z.object({
  // A versão 1 continua aceita; a 2 só acrescenta campos opcionais.
  schemaVersion: z.union([z.literal(1), z.literal(2)]), batchId: z.string().regex(uuidPattern), captureId: z.string().regex(uuidPattern),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  observedAt: z.iso.datetime({ offset: true }), part: z.number().int().min(1).max(100), parts: z.number().int().min(1).max(100),
  devices: z.array(deviceSchema).max(200),
  networks: z.array(networkSchema).max(1000).optional(),
}).refine((batch) => batch.part <= batch.parts)
  .refine((batch) => batch.schemaVersion === 2 || (batch.networks === undefined
    && batch.devices.every((device) => device.ports === undefined && device.uplinkDeviceId === undefined && device.features === undefined)))
  .refine((batch) => !batch.networks || new Set(batch.networks.map((network) => network.id)).size === batch.networks.length)
  .refine((batch) => new Set(batch.devices.map((device) => device.id)).size === batch.devices.length)
  .refine((batch) => Date.parse(batch.observedAt) <= Date.now() + 60_000);

const proofSchema = z.object({ aud: z.literal('malha-collector'), iat: z.number().int(), exp: z.number().int(),
  jti: z.string().regex(uuidPattern), method: z.literal('POST'), path: z.string(), body_sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const headerSchema = z.object({ alg: z.literal('Ed25519'), kid: z.string().regex(uuidPattern).optional(), typ: z.string().optional() }).strict();

function readProof(request: Request) {
  const compact = request.headers.get('Authorization')?.match(/^JWS ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];
  if (!compact || compact.length > 4096) throw new HttpError(401, 'Assinatura do coletor obrigatória.');
  const [header, payload, signature] = compact.split('.');
  try {
    const parsedHeader = headerSchema.parse(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')));
    const proof = proofSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return { parsedHeader, proof, message: Buffer.from(`${header}.${payload}`), signature: Buffer.from(signature, 'base64url') };
  } catch {
    throw new HttpError(401, 'Assinatura do coletor inválida.');
  }
}

function verifyProof(token: ReturnType<typeof readProof>, key: z.infer<typeof keySchema>, path: string, digest: string) {
  const now = Math.floor(Date.now() / 1000);
  const { proof } = token;
  if (proof.exp < now || proof.iat > now + 30 || proof.exp <= proof.iat || proof.exp - proof.iat > 300
      || proof.path !== path || proof.body_sha256 !== digest) {
    throw new HttpError(401, 'Assinatura expirada ou divergente da requisição.');
  }
  let valid = false;
  try {
    valid = verify(null, token.message, createPublicKey({ key, format: 'jwk' }), token.signature);
  } catch {
    // Malformed Ed25519 public key.
  }
  if (!valid) throw new HttpError(401, 'Assinatura do coletor inválida.');
}

type Collector = { collector_id: string; key_id: string; org_id: string; farm_id: string; public_key: z.infer<typeof keySchema> };

async function assertQuota(tx: Queryable, scope: string, limit: number) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 60);
  const { rows } = await tx.query(`INSERT INTO collector_request_limits (scope, bucket, requests) VALUES ($1, $2, 1)
    ON CONFLICT (scope) DO UPDATE SET bucket = excluded.bucket,
      requests = CASE WHEN collector_request_limits.bucket < excluded.bucket THEN 1 ELSE collector_request_limits.requests + 1 END
    WHERE collector_request_limits.bucket < excluded.bucket
      OR (collector_request_limits.bucket = excluded.bucket AND collector_request_limits.requests < $3)
    RETURNING scope`, [scope, bucket, limit]);
  if (!rows.length) throw new HttpError(429, 'Limite de requisições do coletor atingido.', { 'Retry-After': String(60 - (now % 60)) });
}

export async function enrollCollector(request: Request) {
  const body = await requestBytes(request, 4096);
  const data = enrollmentSchema.safeParse(parseJson(body));
  if (!data.success) throw new HttpError(400, 'Solicitação de ativação inválida.');
  const proof = readProof(request);
  if (proof.parsedHeader.kid) throw new HttpError(401, 'Use a chave local para o primeiro cadastro.');
  verifyProof(proof, data.data.publicKey, '/v1/collectors/enroll', hash(body));
  const db = await database();
  return db.transaction(async (tx) => {
    const { rows: [code] } = await tx.query<{ org_id: string; farm_id: string; used_key_id: string | null }>(`
      SELECT org_id, farm_id, used_key_id FROM enrollment_codes WHERE code_hash = $1 AND expires_at > now() FOR UPDATE`, [hash(data.data.code)]);
    if (!code) throw new HttpError(401, 'Código de ativação inválido ou expirado.');
    if (code.used_key_id) {
      const { rows: [existing] } = await tx.query<Collector>(`SELECT collector_id, key_id, org_id, farm_id, public_key FROM collector_keys
        WHERE key_id = $1 AND revoked_at IS NULL AND public_key->>'x' = $2`, [code.used_key_id, data.data.publicKey.x]);
      if (!existing) throw new HttpError(409, 'O código já foi utilizado.');
      return { collectorId: existing.collector_id, keyId: existing.key_id, farmId: existing.farm_id };
    }
    await setOrg(tx, code.org_id);
    await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2 FOR UPDATE', [code.org_id, code.farm_id]);
    const collectorId = randomUUID();
    const keyId = randomUUID();
    const result = await tx.query(`INSERT INTO collector_keys (key_id, collector_id, org_id, farm_id, public_key)
      VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING RETURNING key_id`,
    [keyId, collectorId, code.org_id, code.farm_id, JSON.stringify(data.data.publicKey)]);
    if (!result.rows.length) throw new HttpError(409, 'Esta fazenda já tem um coletor ativo.');
    await tx.query('INSERT INTO collector_health (org_id, farm_id, collector_id) VALUES ($1, $2, $3)', [code.org_id, code.farm_id, collectorId]);
    await tx.query('UPDATE enrollment_codes SET used_key_id = $1 WHERE code_hash = $2', [keyId, hash(data.data.code)]);
    await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), code.org_id, collectorId, 'collector.enroll', JSON.stringify({ farmId: code.farm_id })]);
    return { collectorId, keyId, farmId: code.farm_id };
  });
}

async function authenticated<T>(request: Request, path: string, maxBytes: number,
  operation: (tx: Queryable, collector: Collector, body: unknown, digest: string, clockSkew: number, size: number) => Promise<T>) {
  if (request.headers.get('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity') {
    throw new HttpError(415, 'Use JSON sem compressão.');
  }
  const proof = readProof(request);
  const keyId = proof.parsedHeader.kid;
  if (!keyId) throw new HttpError(401, 'Identificador da chave de coleta obrigatório.');
  const bytes = await requestBytes(request, maxBytes);
  const digest = hash(bytes);
  const db = await database();
  return db.transaction(async (tx) => {
    const { rows: [collector] } = await tx.query<Collector>(`SELECT collector_id, key_id, org_id, farm_id, public_key FROM collector_keys
      WHERE key_id = $1 AND revoked_at IS NULL FOR SHARE`, [keyId]);
    if (!collector) throw new HttpError(401, 'Chave de coleta inválida ou revogada.');
    verifyProof(proof, collector.public_key, path, digest);
    await setOrg(tx, collector.org_id);
    await assertQuota(tx, collector.org_id, 300);
    await assertQuota(tx, collector.collector_id, 30);
    await tx.query('DELETE FROM collector_nonces WHERE expires_at < now()');
    const accepted = await tx.query(`INSERT INTO collector_nonces (key_id, nonce, expires_at)
      VALUES ($1, $2, to_timestamp($3) + interval '1 minute') ON CONFLICT DO NOTHING RETURNING nonce`, [keyId, proof.proof.jti, proof.proof.exp]);
    if (!accepted.rows.length) throw new HttpError(409, 'A assinatura já foi utilizada. Gere um nonce novo.');
    return operation(tx, collector, parseJson(bytes), digest, proof.proof.iat - Math.floor(Date.now() / 1000), bytes.length);
  });
}

export function acceptHeartbeat(request: Request) {
  return authenticated(request, '/v1/collectors/heartbeat', 4096, async (tx, collector, body, _digest, clockSkew) => {
    const parsed = heartbeatSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'Sinal do coletor inválido.');
    await tx.query(`UPDATE collector_health SET last_heartbeat_at = now(), version = $4, queue_depth = $5, healthy = $6, clock_skew_seconds = $7
      WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3`,
    [collector.org_id, collector.farm_id, collector.collector_id, parsed.data.version, parsed.data.queueDepth, parsed.data.healthy, clockSkew]);
    return { accepted: true };
  });
}

export async function acceptBatch(request: Request) {
  const receipt = await authenticated(request, '/v1/collectors/batches', 1024 * 1024, async (tx, collector, body, digest, _clockSkew, size) => {
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'Lote de coleta inválido.');
    const batch = parsed.data;
    const prefix = [collector.org_id, collector.farm_id, collector.collector_id];
    await tx.query(`SELECT 1 FROM collector_health WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 FOR UPDATE`, prefix);
    const existing = await tx.query<{ content_hash: string }>(`
      SELECT content_hash FROM capture_batches WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 AND id = $4`, [...prefix, batch.batchId]);
    if (existing.rows.length) {
      if (existing.rows[0].content_hash !== digest) throw new HttpError(409, 'O mesmo lote foi enviado com outro conteúdo.');
      return { batchId: batch.batchId };
    }
    const observedAt = new Date(batch.observedAt).toISOString();
    await tx.query(`INSERT INTO captures (org_id, farm_id, collector_id, id, seq, observed_at, parts)
      VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`, [...prefix, batch.captureId, batch.sequence, observedAt, batch.parts]);
    const { rows: [capture] } = await tx.query<{ seq: string | number; observed_at: Date; parts: number }>(`
      SELECT seq, observed_at, parts FROM captures WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 AND id = $4`, [...prefix, batch.captureId]);
    if (!capture || Number(capture.seq) !== batch.sequence || new Date(capture.observed_at).toISOString() !== observedAt || capture.parts !== batch.parts) {
      throw new HttpError(409, 'A captura já foi registrada com outra sequência ou metadados.');
    }
    const inserted = await tx.query(`INSERT INTO capture_batches (org_id, farm_id, collector_id, capture_id, id, part, content_hash, devices, networks, payload_bytes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10) ON CONFLICT DO NOTHING RETURNING id`,
    [...prefix, batch.captureId, batch.batchId, batch.part, digest, JSON.stringify(batch.devices),
      batch.networks ? JSON.stringify(batch.networks) : null, size]);
    if (!inserted.rows.length) throw new HttpError(409, 'A parte deste lote já foi recebida.');
    const { rows: [{ count }] } = await tx.query<{ count: string | number }>(`SELECT count(*) FROM capture_batches
      WHERE org_id = $1 AND farm_id = $2 AND collector_id = $3 AND capture_id = $4`, [...prefix, batch.captureId]);
    if (Number(count) === batch.parts) {
      await tx.query(`INSERT INTO inventory_outbox (id, org_id, farm_id, collector_id, capture_id)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [randomUUID(), ...prefix, batch.captureId]);
    }
    return { batchId: batch.batchId };
  });

  // The demo has one process. Pilot requests only persist the job and return the receipt.
  if (mode() === 'demo') await processInventoryJob(await database());
  return receipt;
}
