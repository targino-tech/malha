import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { CustomFetch } from 'openid-client';
import { saveMember } from '../apps/web/src/server/admin';
import { hash, migrate, pgliteDatabase, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import { finishOidcLogin, startOidcLogin, type CookieJar } from '../apps/web/src/server/oidc';

/**
 * Fluxo OpenID Connect de ponta a ponta contra um provedor local que segue a especificação:
 * descoberta, código de autorização com PKCE (S256), state, nonce, ID token assinado (ES256) e JWKS.
 * O provedor confere o code_verifier e o redirect_uri como Google, Okta e Keycloak fazem.
 */

const ISSUER = 'https://idp.exemplo';
const ORIGIN = 'https://malha.exemplo';
const CLIENT_ID = 'malha-web';
const CLIENT_SECRET = 'segredo-do-cliente-oidc';

let db: Database;
let orgId = '';
let privateKey: CryptoKey;
let jwk: JWK;
const codes = new Map<string, { challenge: string; nonce: string; redirect: string; claims: Record<string, unknown> }>();
// Claims da conta que "entra" no provedor; cada teste ajusta o que precisa.
let account: Record<string, unknown> = {};
let tamperNonce = false;
let clientAuth: 'basic' | 'post' = 'basic';

before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
  orgId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo OIDC']);
  const adminOid = randomUUID();
  await db.query(`INSERT INTO memberships (org_id, entra_oid, role) VALUES ($1, $2, 'admin')`, [orgId, adminOid]);
  const admin: Principal = { orgId, actor: adminOid, role: 'admin', farmIds: null, demo: false };
  await saveMember(db, admin, randomUUID(), { displayName: 'Bia', inviteEmail: 'bia@empresa.com.br', role: 'ti', farmIds: [] });
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey as CryptoKey;
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  Object.assign(process.env, {
    MALHA_OIDC_ISSUER: ISSUER, MALHA_OIDC_CLIENT_ID: CLIENT_ID, MALHA_OIDC_CLIENT_SECRET: CLIENT_SECRET, MALHA_OIDC_ORG_ID: orgId,
    MALHA_OIDC_NAME: 'Provedor de teste', MALHA_PUBLIC_ORIGIN: ORIGIN, MALHA_AUTH_SECRET: 'segredo-de-sessao-com-mais-de-32-bytes!!',
  });
});
after(() => db.close());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// O "servidor" do provedor: só responde ao emissor configurado.
const provider: CustomFetch = async (input, init) => {
  const url = new URL(input);
  if (url.origin !== ISSUER) throw new Error(`Chamada fora do provedor: ${url}`);
  if (url.pathname === '/.well-known/openid-configuration') {
    return json({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
  }
  if (url.pathname === '/jwks') return json({ keys: [jwk] });
  if (url.pathname === '/token') {
    const form = new URLSearchParams(String(init.body ?? ''));
    const grant = codes.get(form.get('code') ?? '');
    // Aceita só o método configurado, como o Okta: Basic por padrão, ou o segredo no corpo.
    const basic = new Headers(init.headers).get('authorization');
    // RFC 6749 §2.3.1: id e segredo vão codificados como formulário antes do Base64.
    const [user, pass] = basic?.startsWith('Basic ') ? Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':').map((part) => decodeURIComponent(part.replace(/\+/g, ' '))) : [];
    const authenticated = clientAuth === 'basic'
      ? user === CLIENT_ID && pass === CLIENT_SECRET && !form.has('client_secret')
      : form.get('client_secret') === CLIENT_SECRET && !basic;
    if (!grant || !authenticated) return json({ error: 'invalid_client' }, 401);
    const verifier = form.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge || form.get('redirect_uri') !== grant.redirect) return json({ error: 'invalid_grant' }, 400);
    codes.delete(form.get('code')!);
    const idToken = await new SignJWT({ ...grant.claims, nonce: tamperNonce ? 'outro-nonce' : grant.nonce })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISSUER).setAudience(CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return json({ access_token: randomUUID(), token_type: 'Bearer', expires_in: 300, id_token: idToken });
  }
  return json({ error: 'not_found' }, 404);
};

function cookieJar(): CookieJar & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: (name) => (values.has(name) ? { value: values.get(name)! } : undefined), set: (name, value, options) => { if (options.maxAge === 0) values.delete(name); else values.set(name, value); } };
}

/** Faz o caminho do navegador: inicia no Malha, "autoriza" no provedor e volta pelo callback. */
async function login(claims: Record<string, unknown>, mutate?: (callback: URL) => void) {
  account = claims;
  const cookies = cookieJar();
  const start = await startOidcLogin({ cookies, fetch: provider });
  assert.equal(start.status, 303);
  const authorize = new URL(start.headers.get('Location')!);
  assert.equal(authorize.origin + authorize.pathname, `${ISSUER}/authorize`);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/oidc/callback`);
  assert.match(authorize.searchParams.get('scope')!, /openid/);
  const code = randomUUID();
  codes.set(code, { challenge: authorize.searchParams.get('code_challenge')!, nonce: authorize.searchParams.get('nonce')!, redirect: authorize.searchParams.get('redirect_uri')!, claims: account });
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', authorize.searchParams.get('state')!);
  mutate?.(callback);
  const response = await finishOidcLogin(new Request(callback), { cookies, fetch: provider, database: db });
  return { response, cookies };
}

const failsWith = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;

test('primeiro login liga o convite, o segundo entra pelo sub e abre sessão', async () => {
  const first = await login({ sub: 'google-oauth2|1001', email: 'Bia@empresa.com.br', email_verified: true });
  assert.equal(first.response.status, 303);
  assert.equal(first.response.headers.get('Location'), `${ORIGIN}/`);
  const session = first.cookies.values.get('__Host-malha_session');
  assert.ok(session);
  const { rows } = await db.query('SELECT 1 FROM sessions WHERE token_hash = $1 AND org_id = $2', [hash(session), orgId]);
  assert.equal(rows.length, 1);
  assert.equal(first.cookies.values.has('__Host-malha_oidc_generic'), false);

  // Okta e Keycloak podem mudar o e-mail; a ligação fica pelo sub, mesmo sem e-mail verificado agora.
  const second = await login({ sub: 'google-oauth2|1001', email: 'bia.nova@empresa.com.br', email_verified: false });
  assert.equal(second.response.status, 303);
});

test('provedor sem e-mail verificado não liga convite (Keycloak com e-mail não confirmado)', async () => {
  await assert.rejects(login({ sub: 'keycloak|2002', email: 'outra@empresa.com.br', email_verified: false }), failsWith(403));
  await assert.rejects(login({ sub: 'keycloak|2003', email: 'bia@empresa.com.br' }), failsWith(403));
});

test('state adulterado, nonce trocado e código repetido são recusados', async () => {
  await assert.rejects(login({ sub: 'x|1', email: 'bia@empresa.com.br', email_verified: true }, (callback) => callback.searchParams.set('state', 'forjado')), failsWith(401));
  tamperNonce = true;
  try {
    await assert.rejects(login({ sub: 'x|2', email: 'bia@empresa.com.br', email_verified: true }), failsWith(401));
  } finally {
    tamperNonce = false;
  }
  const cookies = cookieJar();
  await assert.rejects(finishOidcLogin(new Request(`${ORIGIN}/api/auth/oidc/callback?code=x&state=y`), { cookies, fetch: provider, database: db }), failsWith(401));
});

test('segredo do cliente vai por HTTP Basic por padrão e no corpo com MALHA_OIDC_CLIENT_AUTH=post', async () => {
  const ok = await login({ sub: 'google-oauth2|1001', email: 'bia@empresa.com.br', email_verified: true });
  assert.equal(ok.response.status, 303);
  process.env.MALHA_OIDC_CLIENT_AUTH = 'post';
  clientAuth = 'post';
  try {
    assert.equal((await login({ sub: 'google-oauth2|1001', email: 'bia@empresa.com.br', email_verified: true })).response.status, 303);
    // Provedor que exige Basic recusa o segredo no corpo, e o Malha responde 401 em vez de abrir sessão.
    clientAuth = 'basic';
    await assert.rejects(login({ sub: 'google-oauth2|1001', email: 'bia@empresa.com.br', email_verified: true }), failsWith(401));
  } finally {
    delete process.env.MALHA_OIDC_CLIENT_AUTH;
    clientAuth = 'basic';
  }
});
