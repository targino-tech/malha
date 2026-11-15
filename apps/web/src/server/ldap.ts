import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'ldapts';
import { z } from 'zod';
import { hash, setOrg, type Database } from './db';
import { HttpError } from './http';

/**
 * Login por diretório (Active Directory ou outro LDAP).
 * 1. Acha o diretório do grupo pelo domínio informado.
 * 2. Com a conta de serviço, procura exatamente um usuário pelo atributo de login (filtro com escape RFC 4515).
 * 3. Valida a senha com um bind como o próprio usuário. Senha vazia é recusada antes: em LDAP ela vira bind anônimo.
 * 4. Converte o identificador estável (objectGUID ou entryUUID) em UUID e abre a sessão se houver associação ativa.
 */

const PER_CLIENT = 10;
const PER_SUBJECT = 5;
const WINDOW = '15 minutes';
const GENERIC = 'Usuário ou senha inválidos.';

export interface DirectoryConnection {
  startTLS(options: { ca?: string; minVersion: 'TLSv1.2'; servername?: string }): Promise<void>;
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: { scope: 'sub'; filter: string; attributes: string[]; sizeLimit: number; explicitBufferAttributes: string[] }): Promise<{ searchEntries: Array<Record<string, unknown> & { dn: string }> }>;
  unbind(): Promise<void>;
}

export type Connect = (url: string, ca: string | null) => DirectoryConnection;

export const connectLdap: Connect = (url, ca) => new Client({
  url, timeout: 8000, connectTimeout: 5000,
  tlsOptions: { minVersion: 'TLSv1.2', ...(ca ? { ca } : {}) },
}) as unknown as DirectoryConnection;

/** Escape de valores em filtros LDAP (RFC 4515): impede que o usuário digitado altere o filtro. */
export function escapeFilter(value: string) {
  return value.replace(/[\\*()\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/[^\x20-\x7e]/g, (char) => [...Buffer.from(char, 'utf8')].map((byte) => `\\${byte.toString(16).padStart(2, '0')}`).join(''));
}

/** objectGUID chega em 16 bytes com as três primeiras partes em little-endian; entryUUID já vem como texto. */
export function directoryUuid(value: unknown): string | null {
  if (Buffer.isBuffer(value) && value.length === 16) {
    const b = value;
    const hex = (bytes: number[]) => bytes.map((index) => b[index].toString(16).padStart(2, '0')).join('');
    return `${hex([3, 2, 1, 0])}-${hex([5, 4])}-${hex([7, 6])}-${hex([8, 9])}-${hex([10, 11, 12, 13, 14, 15])}`;
  }
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return text.toLowerCase();
  return null;
}

// Senha da conta de serviço guardada cifrada (AES-256-GCM) com chave derivada de MALHA_AUTH_SECRET.
// Cada finalidade deriva a própria chave: um token de monitoramento não abre com a chave do LDAP.
function key(secret: string, purpose: string) {
  return Buffer.from(hkdfSync('sha256', secret, 'malha', purpose, 32));
}

export function sealSecret(plain: string, secret: string, purpose = 'ldap-bind-secret') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, purpose), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function openSecret(sealed: string, secret: string, purpose = 'ldap-bind-secret') {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Segredo do diretório em formato desconhecido.');
  const decipher = createDecipheriv('aes-256-gcm', key(secret, purpose), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

const loginSchema = z.object({
  domain: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$/),
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(512),
});

type Directory = {
  org_id: string; url: string; start_tls: boolean; base_dn: string; bind_dn: string; bind_secret: string;
  user_attribute: string; id_attribute: 'objectGUID' | 'entryUUID'; ca_pem: string | null;
};

export async function authenticateLdap(database: Database, input: unknown, client: string, secret: string, connect: Connect = connectLdap) {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'Informe domínio, usuário e senha.');
  const { domain, username, password } = parsed.data;
  // O usuário pode digitar DOMINIO\usuario ou usuario@dominio; o atributo de login recebe só o nome.
  const account = username.includes('\\') ? username.split('\\').pop()! : username.includes('@') ? username.split('@')[0] : username;
  const clientHash = createHmac('sha256', secret).update(`login:${client}`).digest('hex');
  const subjectHash = createHmac('sha256', secret).update(`login:${domain}:${account.toLowerCase()}`).digest('hex');

  await database.query(`DELETE FROM login_attempts WHERE attempted_at < now() - interval '1 day'`);
  const { rows: [counts] } = await database.query<{ client: number; subject: number }>(`
    SELECT count(*) FILTER (WHERE client_hash = $1)::int AS client, count(*) FILTER (WHERE subject_hash = $2)::int AS subject
    FROM login_attempts WHERE attempted_at > now() - interval '${WINDOW}'`, [clientHash, subjectHash]);
  if (counts.client >= PER_CLIENT || counts.subject >= PER_SUBJECT) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.', { 'Retry-After': '900' });
  }
  await database.query('INSERT INTO login_attempts (client_hash, subject_hash) VALUES ($1, $2)', [clientHash, subjectHash]);

  const { rows: [directory] } = await database.query<Directory>(`SELECT org_id, url, start_tls, base_dn, bind_dn, bind_secret, user_attribute, id_attribute, ca_pem
    FROM ldap_directories WHERE domain = $1 AND enabled`, [domain]);
  if (!directory) throw new HttpError(401, GENERIC);

  const connection = connect(directory.url, directory.ca_pem);
  let subject: string | null = null;
  try {
    if (directory.start_tls) await connection.startTLS({ minVersion: 'TLSv1.2', ...(directory.ca_pem ? { ca: directory.ca_pem } : {}) });
    await connection.bind(directory.bind_dn, openSecret(directory.bind_secret, secret));
    const { searchEntries } = await connection.search(directory.base_dn, {
      scope: 'sub', sizeLimit: 2, attributes: [directory.id_attribute],
      // No AD, contas desativadas (bit 2 de userAccountControl) ficam de fora; outros diretórios não têm esse atributo.
      filter: directory.id_attribute === 'objectGUID'
        ? `(&(${directory.user_attribute}=${escapeFilter(account)})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))`
        : `(${directory.user_attribute}=${escapeFilter(account)})`,
      explicitBufferAttributes: directory.id_attribute === 'objectGUID' ? ['objectGUID'] : [],
    });
    if (searchEntries.length !== 1) throw new HttpError(401, GENERIC);
    const [entry] = searchEntries;
    subject = directoryUuid(entry[directory.id_attribute]);
    if (!subject) throw new HttpError(401, GENERIC);
    await connection.bind(entry.dn, password);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, GENERIC);
  } finally {
    await connection.unbind().catch(() => undefined);
  }

  const token = randomBytes(32).toString('base64url');
  const { rows } = await database.query(`INSERT INTO sessions (token_hash, org_id, entra_oid, expires_at)
    SELECT $3, m.org_id, m.entra_oid, now() + interval '8 hours' FROM memberships m
    WHERE m.org_id = $1 AND m.entra_oid = $2 AND m.active RETURNING org_id`, [directory.org_id, subject, hash(token)]);
  if (!rows.length) throw new HttpError(403, 'Sua conta não está habilitada no Malha.');
  await database.query('DELETE FROM login_attempts WHERE subject_hash = $1', [subjectHash]);
  await database.transaction(async (tx) => {
    await setOrg(tx, directory.org_id);
    await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), directory.org_id, subject, 'auth.ldap.login', JSON.stringify({ domain })]);
  });
  return { token, orgId: directory.org_id, subject };
}
