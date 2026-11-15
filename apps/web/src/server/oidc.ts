import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import * as oidc from 'openid-client';
import { database, hash, setOrg, type Database } from './db';
import { HttpError, uuidPattern } from './http';
import { publicOrigin } from './identity';

/**
 * Login por um provedor OpenID Connect genérico (Google Workspace, Okta, Keycloak, Auth0...), ao lado do Entra ID.
 * Configuração por ambiente: MALHA_OIDC_ISSUER, MALHA_OIDC_CLIENT_ID, MALHA_OIDC_CLIENT_SECRET,
 * MALHA_OIDC_NAME (rótulo do botão), MALHA_OIDC_ORG_ID (grupo atendido por este provedor) e, opcionalmente,
 * MALHA_OIDC_CLIENT_AUTH=post para enviar o segredo no corpo; o padrão é HTTP Basic, o método padrão do OIDC.
 */

const LOGIN_COOKIE = '__Host-malha_oidc_generic';
const SESSION_COOKIE = '__Host-malha_session';
const baseCookie = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const };

export function oidcProvider() {
  const issuer = process.env.MALHA_OIDC_ISSUER;
  const clientId = process.env.MALHA_OIDC_CLIENT_ID;
  const clientSecret = process.env.MALHA_OIDC_CLIENT_SECRET;
  const orgId = process.env.MALHA_OIDC_ORG_ID?.toLowerCase();
  if (!issuer || !clientId || !clientSecret || !orgId) return null;
  const clientAuth = process.env.MALHA_OIDC_CLIENT_AUTH === 'post' ? 'post' as const : 'basic' as const;
  return { issuer, clientId, clientSecret, orgId, clientAuth, name: process.env.MALHA_OIDC_NAME?.trim() || 'provedor da empresa' };
}

function settings() {
  const provider = oidcProvider();
  const signSecret = process.env.MALHA_AUTH_SECRET;
  if (!provider || !signSecret || Buffer.byteLength(signSecret) < 32) throw new HttpError(503, 'O provedor de login precisa ser configurado.');
  if (!uuidPattern.test(provider.orgId)) throw new HttpError(503, 'MALHA_OIDC_ORG_ID precisa ser o UUID do grupo.');
  const issuer = new URL(provider.issuer);
  if (issuer.protocol !== 'https:') throw new HttpError(503, 'O emissor OIDC precisa usar HTTPS.');
  const origin = publicOrigin();
  return { ...provider, issuer, signSecret, origin, redirect: new URL('/api/auth/oidc/callback', origin).href };
}

/** Dependências externas do fluxo. Em produção vêm do Next e do ambiente; os testes injetam um provedor local. */
export interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: { path: string; secure: boolean; httpOnly: boolean; sameSite: 'lax'; maxAge: number }): void;
}
export interface OidcDeps { cookies?: CookieJar; fetch?: oidc.CustomFetch; database?: Database }
const jar = async (deps?: OidcDeps) => deps?.cookies ?? (await cookies() as unknown as CookieJar);

let discovered: { key: string; value: Promise<oidc.Configuration> } | undefined;
function config(params: ReturnType<typeof settings>, fetcher?: oidc.CustomFetch) {
  const auth = params.clientAuth === 'post' ? oidc.ClientSecretPost(params.clientSecret) : oidc.ClientSecretBasic(params.clientSecret);
  if (fetcher) {
    // Provedor injetado (testes): sem cache e com o mesmo fetch para descoberta, token e chaves.
    return oidc.discovery(params.issuer, params.clientId, params.clientSecret, auth, { [oidc.customFetch]: fetcher })
      .then((configuration) => { configuration[oidc.customFetch] = fetcher; return configuration; });
  }
  const key = `${params.issuer.href}|${params.clientId}|${params.clientAuth}`;
  if (discovered?.key !== key) {
    const value = oidc.discovery(params.issuer, params.clientId, params.clientSecret, auth)
      .catch((error: unknown) => { discovered = undefined; throw error; });
    discovered = { key, value };
  }
  return discovered.value;
}

const sign = (value: string, secret: string) => createHmac('sha256', secret).update(value).digest('base64url');

export async function startOidcLogin(deps?: OidcDeps) {
  const params = settings();
  const configuration = await config(params, deps?.fetch);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const payload = Buffer.from(JSON.stringify({ verifier, state, nonce, exp: Date.now() + 300_000 })).toString('base64url');
  (await jar(deps)).set(LOGIN_COOKIE, `${payload}.${sign(payload, params.signSecret)}`, { ...baseCookie, maxAge: 300 });
  const location = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: params.redirect, scope: 'openid email profile', code_challenge_method: 'S256',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), state, nonce,
  });
  return Response.redirect(location, 303);
}

/**
 * Resolve a identidade do provedor em uma associação ativa do grupo. Ordem: identidade já ligada;
 * senão, convite por e-mail, aceito só com e-mail verificado pelo provedor, e então ligado para sempre.
 */
export async function linkOidcIdentity(db: Database, orgId: string, identity: { issuer: string; subject: string; email?: unknown; emailVerified?: unknown }) {
  return db.transaction(async (tx) => {
    const { rows: [linked] } = await tx.query<{ entra_oid: string; active: boolean }>(`SELECT i.entra_oid, m.active FROM oidc_identities i
      JOIN memberships m ON m.org_id = i.org_id AND m.entra_oid = i.entra_oid
      WHERE i.issuer = $1 AND i.subject = $2 AND i.org_id = $3`, [identity.issuer, identity.subject, orgId]);
    if (linked) {
      if (!linked.active) throw new HttpError(403, 'Sua conta não está habilitada no Malha.');
      return { oid: linked.entra_oid, linked: false };
    }
    const email = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';
    if (!email || identity.emailVerified !== true) throw new HttpError(403, 'O provedor não confirmou um e-mail verificado para esta conta.');
    const { rows: [invited] } = await tx.query<{ entra_oid: string }>(`SELECT m.entra_oid FROM memberships m
      WHERE m.org_id = $1 AND m.invite_email = $2 AND m.active
        AND NOT EXISTS (SELECT 1 FROM oidc_identities i WHERE i.org_id = m.org_id AND i.entra_oid = m.entra_oid)
      FOR UPDATE`, [orgId, email]);
    if (!invited) throw new HttpError(403, 'Sua conta não está habilitada no Malha.');
    await tx.query('INSERT INTO oidc_identities (issuer, subject, org_id, entra_oid) VALUES ($1, $2, $3, $4)', [identity.issuer, identity.subject, orgId, invited.entra_oid]);
    await setOrg(tx, orgId);
    await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), orgId, invited.entra_oid, 'auth.oidc.link', JSON.stringify({ issuer: identity.issuer })]);
    return { oid: invited.entra_oid, linked: true };
  });
}

export async function finishOidcLogin(request: Request, deps?: OidcDeps) {
  const params = settings();
  const store = await jar(deps);
  const [payload, signature] = store.get(LOGIN_COOKIE)?.value.split('.') ?? [];
  store.set(LOGIN_COOKIE, '', { ...baseCookie, maxAge: 0 });
  const expected = payload && sign(payload, params.signSecret);
  if (!payload || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !expected || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new HttpError(401, 'Tentativa de autenticação inválida.');
  }
  const pending = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { verifier: string; state: string; nonce: string; exp: number };
  if (pending.exp < Date.now()) throw new HttpError(401, 'A tentativa de entrada expirou.');
  const callbackUrl = new URL(params.redirect);
  callbackUrl.search = new URL(request.url).search;
  const configuration = await config(params, deps?.fetch);
  const token = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
    pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true,
  }).catch(() => { throw new HttpError(401, 'O provedor não confirmou a entrada.'); });
  const claims = token.claims();
  if (!claims || typeof claims.sub !== 'string' || typeof claims.iss !== 'string') throw new HttpError(401, 'Resposta do provedor sem identidade.');
  const db = deps?.database ?? await database();
  const { oid } = await linkOidcIdentity(db, params.orgId, { issuer: claims.iss, subject: claims.sub, email: claims.email, emailVerified: claims.email_verified });
  const session = randomBytes(32).toString('base64url');
  const inserted = await db.query(`INSERT INTO sessions (token_hash, org_id, entra_oid, expires_at)
    SELECT $3, m.org_id, m.entra_oid, now() + interval '8 hours' FROM memberships m WHERE m.org_id = $1 AND m.entra_oid = $2 AND m.active RETURNING org_id`,
  [params.orgId, oid, hash(session)]);
  if (!inserted.rows.length) throw new HttpError(403, 'Sua conta não está habilitada no Malha.');
  store.set(SESSION_COOKIE, session, { ...baseCookie, maxAge: 8 * 3600 });
  return Response.redirect(params.origin, 303);
}
