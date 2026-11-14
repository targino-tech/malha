import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { compactVerify, importJWK } from 'jose';

test('Node e JOSE verificam o algoritmo Ed25519 utilizado pelo coletor', async () => {
  const keys = generateKeyPairSync('ed25519');
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const kid = randomUUID();
  const body = '{"schemaVersion":1}';
  const header = Buffer.from(JSON.stringify({ alg: 'Ed25519', kid })).toString('base64url');
  const claims = { body_sha256: createHash('sha256').update(body).digest('hex') };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(token), keys.privateKey).toString('base64url');
  const key = await importJWK(jwk, 'Ed25519');
  const verified = await compactVerify(`${token}.${signature}`, key, { algorithms: ['Ed25519'] });

  assert.deepEqual(JSON.parse(Buffer.from(verified.payload).toString()), claims);
  await assert.rejects(compactVerify(`${header}.${Buffer.from('invalid').toString('base64url')}.${signature}`, key));
});
