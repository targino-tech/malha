import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../apps/web/src/server/http';
import { publicOrigin, requireSameOrigin } from '../apps/web/src/server/identity';

const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;
const request = (headers: Record<string, string>) => new Request('https://malha.example/api/x', { method: 'POST', headers });

test('origem pública funciona sem Microsoft Entra ID (grupo só com AD/LDAP)', () => {
  const saved = { ...process.env };
  try {
    for (const name of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET']) delete process.env[name];
    process.env.MALHA_MODE = 'pilot';
    process.env.MALHA_PUBLIC_ORIGIN = 'https://malha.example';
    assert.equal(publicOrigin(), 'https://malha.example');
    assert.doesNotThrow(() => requireSameOrigin(request({ Origin: 'https://malha.example' })));
    assert.throws(() => requireSameOrigin(request({ Origin: 'https://atacante.example' })), status(403));
    assert.throws(() => requireSameOrigin(request({ Origin: 'https://malha.example', 'Sec-Fetch-Site': 'cross-site' })), status(403));
    assert.throws(() => requireSameOrigin(request({})), status(403));

    process.env.MALHA_PUBLIC_ORIGIN = 'http://malha.example';
    assert.throws(() => publicOrigin(), status(503));
    process.env.MALHA_PUBLIC_ORIGIN = 'https://malha.example/painel';
    assert.throws(() => publicOrigin(), status(503));
    delete process.env.MALHA_PUBLIC_ORIGIN;
    assert.throws(() => publicOrigin(), status(503));
  } finally {
    process.env = saved;
  }
});
