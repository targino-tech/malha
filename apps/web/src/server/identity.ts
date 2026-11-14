import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import * as oidc from 'openid-client';
import { database, DEMO_ORG, hash, mode } from './db';
import { HttpError, uuidPattern } from './http';

export interface Principal {
  orgId: string;
  actor: string;
  role: 'admin' | 'ti' | 'diretoria';
  demo: boolean;
}

const SESSION_COOKIE = '__Host-malha_session';
const LOGIN_COOKIE = '__Host-malha_oidc';
const baseCookie = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const };

export async function principal(): Promise<Principal> {
  if (mode() === 'demo') return { orgId: DEMO_ORG, actor: 'demo', role: 'admin', demo: true };
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Entre com sua conta corporativa.');
  const db = await database();
  const { rows: [user] } = await db.query<{ org_id: string; entra_oid: string; role: Principal['role'] }>(`
    UPDATE sessions AS s SET last_seen_at = now() FROM memberships AS m
    WHERE s.token_hash = $1 AND s.org_id = m.org_id AND s.entra_oid = m.entra_oid AND m.active
      AND s.expires_at > now() AND s.last_seen_at > now() - interval '30 minutes'
    RETURNING s.org_id, s.entra_oid, m.role`, [hash(token)]);
  if (!user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  return { orgId: user.org_id, actor: user.entra_oid, role: user.role, demo: false };
}

function settings() {
  const tenant = process.env.ENTRA_TENANT_ID?.toLowerCase();
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  const signSecret = process.env.MALHA_AUTH_SECRET;
  const origin = process.env.MALHA_PUBLIC_ORIGIN;
  if (!tenant || !uuidPattern.test(tenant) || !clientId || !uuidPattern.test(clientId)
    || !clientSecret || !signSecret || Buffer.byteLength(signSecret) < 32 || !origin) {
    throw new HttpError(503, 'A conexão ao Microsoft Entra ID precisa ser configurada.');
  }
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) {
    throw new HttpError(503, 'Configure a origem HTTPS exata do aplicativo Malha.');
  }
  return { tenant, clientId, clientSecret, signSecret, origin, redirect: new URL('/api/auth/callback', url).href };
}

let discovered: Promise<oidc.Configuration> | undefined;
function config(params: ReturnType<typeof settings>) {
  discovered ??= oidc.discovery(new URL(`https://login.microsoftonline.com/${params.tenant}/v2.0`), params.clientId,
    params.clientSecret, oidc.ClientSecretPost(params.clientSecret), { execute: [oidc.enableNonRepudiationChecks] })
    .catch((error: unknown) => { discovered = undefined; throw error; });
  return discovered;
}

function signedValue(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export async function startLogin() {
  if (mode() === 'demo') return new Response(null, { status: 303, headers: { Location: '/' } });
  const params = settings();
  const configuration = await config(params);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const payload = Buffer.from(JSON.stringify({ verifier, state, nonce, exp: Date.now() + 300_000 })).toString('base64url');
  (await cookies()).set(LOGIN_COOKIE, `${payload}.${signedValue(payload, params.signSecret)}`, { ...baseCookie, maxAge: 300 });
  const location = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: params.redirect, scope: 'openid profile', code_challenge_method: 'S256',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), state, nonce,
  });
  return Response.redirect(location, 303);
}

export async function finishLogin(request: Request) {
  if (mode() !== 'pilot') throw new HttpError(404, 'Autenticação indisponível neste modo.');
  const params = settings();
  const cookieStore = await cookies();
  const [payload, signature] = cookieStore.get(LOGIN_COOKIE)?.value.split('.') ?? [];
  cookieStore.set(LOGIN_COOKIE, '', { ...baseCookie, maxAge: 0 });
  const expected = payload && signedValue(payload, params.signSecret);
  if (!payload || !signature || signature.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(signature)
      || !expected || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new HttpError(401, 'Tentativa de autenticação inválida.');
  }
  const pending = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
    { verifier: string; state: string; nonce: string; exp: number };
  if (pending.exp < Date.now()) throw new HttpError(401, 'A tentativa de entrada expirou.');
  const callbackUrl = new URL(params.redirect);
  callbackUrl.search = new URL(request.url).search;
  const configuration = await config(params);
  const token = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
    pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true,
  }).catch(() => { throw new HttpError(401, 'O Microsoft Entra ID não confirmou a entrada.'); });
  const claims = token.claims();
  if (claims?.tid !== params.tenant || typeof claims.oid !== 'string' || !uuidPattern.test(claims.oid)) {
    throw new HttpError(403, 'A identidade não pertence ao diretório do piloto.');
  }
  const db = await database();
  const session = randomBytes(32).toString('base64url');
  const inserted = await db.query(`INSERT INTO sessions (token_hash, org_id, entra_oid, expires_at)
    SELECT $3, m.org_id, m.entra_oid, now() + interval '8 hours' FROM organizations o
    JOIN memberships m ON m.org_id = o.id WHERE o.entra_tenant_id = $1 AND m.entra_oid = $2 AND m.active RETURNING org_id`,
  [params.tenant, claims.oid, hash(session)]);
  if (!inserted.rows.length) throw new HttpError(403, 'Sua conta não está habilitada no Malha.');
  cookieStore.set(SESSION_COOKIE, session, { ...baseCookie, maxAge: 8 * 3600 });
  return Response.redirect(params.origin, 303);
}

export function requireSameOrigin(request: Request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'Origem da requisição inválida.');
  if (mode() === 'pilot' && request.headers.get('Origin') !== settings().origin) {
    throw new HttpError(403, 'Origem da requisição inválida.');
  }
}

export async function logout(request: Request) {
  if (mode() !== 'pilot') throw new HttpError(404, 'Autenticação indisponível neste modo.');
  requireSameOrigin(request);
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;
  if (session) await (await database()).query('DELETE FROM sessions WHERE token_hash = $1', [hash(session)]);
  store.set(SESSION_COOKIE, '', { ...baseCookie, maxAge: 0 });
  return Response.redirect(`${settings().origin}/entrar`, 303);
}
