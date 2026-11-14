import { expect, test } from '@playwright/test';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

test('ingestão assinada exige prova nova e projeta uma captura completa sem duplicar ativos', async ({ request }) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  function proof(path: string, body: string, kid?: string) {
    const iat = Math.floor(Date.now() / 1000);
    const token = `${encode({ alg: 'Ed25519', kid })}.${encode({
      aud: 'malha-collector', method: 'POST', path, iat, exp: iat + 60, jti: randomUUID(),
      body_sha256: createHash('sha256').update(body).digest('hex'),
    })}`;
    return `JWS ${token}.${sign(null, Buffer.from(token), privateKey).toString('base64url')}`;
  }

  function send(path: string, data: string, authorization?: string) {
    const header = authorization ?? proof(path, data, enrolled?.keyId);
    return request.post(path, { data, headers: { 'Content-Type': 'application/json', Authorization: header } });
  }

  let enrolled: { keyId: string; farmId: string } | undefined = undefined;
  const enrollment = await send('/v1/collectors/enroll', JSON.stringify({
    code: 'malha-demo-entrada-000000000000000000000000', publicKey: publicKey.export({ format: 'jwk' }),
  }));
  expect(enrollment.status(), await enrollment.text()).toBe(201);
  enrolled = await enrollment.json() as { keyId: string; farmId: string };

  const heartbeatPath = '/v1/collectors/heartbeat';
  const heartbeat = JSON.stringify({ version: 'e2e', queueDepth: 0, healthy: true });
  const signed = proof(heartbeatPath, heartbeat, enrolled.keyId);
  const tampered = await send(heartbeatPath, heartbeat.replace('true', 'false'), signed);
  expect(tampered.status()).toBe(401);
  const accepted = await send(heartbeatPath, heartbeat, signed);
  expect(accepted.ok(), await accepted.text()).toBe(true);
  expect((await send(heartbeatPath, heartbeat, signed)).status()).toBe(409);

  const batchPath = '/v1/collectors/batches';
  const shared = { schemaVersion: 1, captureId: randomUUID(), sequence: 1, observedAt: new Date().toISOString(), parts: 2 };
  const device = { id: 'captura-e2e', name: 'Switch da coleta assinada', state: 'ONLINE', model: 'SWITCH' };
  const first = JSON.stringify({ ...shared, batchId: randomUUID(), part: 1, devices: [device] });
  const second = JSON.stringify({ ...shared, batchId: randomUUID(), part: 2, devices: [] });

  async function collected() {
    const dashboard = await request.get('/api/dashboard');
    expect(dashboard.ok()).toBe(true);
    const { assets } = await dashboard.json() as { assets: Array<{ name: string; farmId: string; status: string }> };
    return assets.filter(asset => asset.name === device.name);
  }

  const partial = await send(batchPath, first);
  expect(partial.status(), await partial.text()).toBe(202);
  expect(await collected()).toEqual([]);
  const complete = await send(batchPath, second);
  expect(complete.status(), await complete.text()).toBe(202);
  expect((await send(batchPath, first)).status()).toBe(202);
  expect((await send(batchPath, first.replace('SWITCH', 'CHANGED'))).status()).toBe(409);
  expect(await collected()).toEqual([expect.objectContaining({ farmId: enrolled.farmId, status: 'online' })]);
});
