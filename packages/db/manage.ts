import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { issueEnrollmentCode, revokeCollectorKey } from '../../apps/web/src/server/admin';
import { connectPostgres, migrate, setOrg, type Database } from '../../apps/web/src/server/db';
import { uuidPattern } from '../../apps/web/src/server/http';
import { sealSecret } from '../../apps/web/src/server/ldap';
import { email } from './email';

function uuid(value: string | undefined, label: string) {
  if (!value || !uuidPattern.test(value)) throw new Error(`Forneça um UUID válido para ${label}.`);
  return value.toLowerCase();
}

async function configure(db: Database, tenant: string, oid: string, name: string) {
  return db.transaction(async (tx) => {
    const { rows: [org] } = await tx.query<{ id: string }>(`
      INSERT INTO organizations (id, name, entra_tenant_id) VALUES ($1, $2, $3)
      ON CONFLICT (entra_tenant_id) DO UPDATE SET name = excluded.name RETURNING id`, [randomUUID(), name, tenant]);
    await tx.query(`INSERT INTO memberships (org_id, entra_oid, role) VALUES ($1, $2, 'admin')
      ON CONFLICT (org_id, entra_oid) DO UPDATE SET role = 'admin', active = true`, [org.id, oid]);
    return org.id;
  });
}

async function farm(db: Database, orgId: string, name: string, location: string) {
  const farmId = randomUUID();
  await db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    await tx.query('INSERT INTO farms (org_id, id, name, location) VALUES ($1, $2, $3, $4)', [orgId, farmId, name, location]);
  });
  return farmId;
}

async function enroll(db: Database, orgId: string, farmId: string) {
  return db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    return (await issueEnrollmentCode(tx, orgId, farmId, 'cli')).code;
  });
}

async function revoke(db: Database, orgId: string, farmId: string) {
  return db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    return (await revokeCollectorKey(tx, orgId, farmId, 'cli')).collectorId;
  });
}

async function recipient(db: Database, orgId: string, address: string, active: boolean) {
  await db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    await tx.query(`INSERT INTO alert_recipients (org_id, email, active) VALUES ($1, $2, $3)
      ON CONFLICT (org_id, email) DO UPDATE SET active = excluded.active`, [orgId, address, active]);
    await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), orgId, 'cli', active ? 'alerts.recipient.add' : 'alerts.recipient.remove', '{}']);
  });
}

async function requests(db: Database) {
  const { rows } = await db.query<{ created_at: Date; plan: string; company: string; name: string; email: string; farms: number; status: string }>(
    'SELECT created_at, plan, company, name, email, farms, status FROM site_requests ORDER BY created_at DESC LIMIT 50');
  for (const row of rows) {
    console.log([row.created_at.toISOString(), row.status, row.plan, row.farms, row.company, row.name, row.email].join('\t'));
  }
  if (!rows.length) console.log('Nenhuma solicitação recebida pelo site.');
}

async function ldapDirectory(db: Database, orgId: string, domain: string, url: string, baseDn: string, bindDn: string) {
  const secret = process.env.MALHA_AUTH_SECRET;
  const file = process.env.MALHA_LDAP_BIND_PASSWORD_FILE;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Defina MALHA_AUTH_SECRET (32+ bytes), a mesma do serviço web.');
  if (!file) throw new Error('Informe a senha da conta de serviço em MALHA_LDAP_BIND_PASSWORD_FILE.');
  const password = readFileSync(file, 'utf8').trim();
  if (!password) throw new Error('A senha da conta de serviço está vazia.');
  const startTls = url.startsWith('ldap://');
  const caFile = process.env.MALHA_LDAP_CA_FILE;
  const idAttribute = process.env.MALHA_LDAP_ID_ATTRIBUTE === 'entryUUID' ? 'entryUUID' : 'objectGUID';
  const userAttribute = process.env.MALHA_LDAP_USER_ATTRIBUTE ?? (idAttribute === 'objectGUID' ? 'sAMAccountName' : 'uid');
  await db.query(`INSERT INTO ldap_directories (org_id, domain, url, start_tls, base_dn, bind_dn, bind_secret, user_attribute, id_attribute, ca_pem)
    VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (org_id) DO UPDATE SET domain = excluded.domain, url = excluded.url, start_tls = excluded.start_tls, base_dn = excluded.base_dn,
      bind_dn = excluded.bind_dn, bind_secret = excluded.bind_secret, user_attribute = excluded.user_attribute, id_attribute = excluded.id_attribute,
      ca_pem = excluded.ca_pem, enabled = true`,
  [orgId, domain, url, startTls, baseDn, bindDn, sealSecret(password, secret), userAttribute, idAttribute, caFile ? readFileSync(caFile, 'utf8') : null]);
}

async function main() {
  const [command, one, two, three] = process.argv.slice(2);
  const db = connectPostgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
  try {
    if (command === 'migrate') {
      await migrate(db);
      console.log('Migrações aplicadas.');
    } else if (command === 'configure') {
      console.log(await configure(db, uuid(one, 'o diretório Entra'), uuid(two, 'o usuário administrador'), three ?? 'Grupo piloto'));
    } else if (command === 'farm') {
      if (!two?.trim() || !three?.trim()) throw new Error('Informe o nome e a localização da fazenda.');
      console.log(await farm(db, uuid(one, 'o grupo'), two, three));
    } else if (command === 'enroll') {
      console.log(await enroll(db, uuid(one, 'o grupo'), uuid(two, 'a fazenda')));
    } else if (command === 'revoke') {
      console.log(await revoke(db, uuid(one, 'o grupo'), uuid(two, 'a fazenda')));
    } else if (command === 'recipient' || command === 'recipient-remove') {
      await recipient(db, uuid(one, 'o grupo'), email(two), command === 'recipient');
      console.log(command === 'recipient' ? 'Destinatário de alertas ativo.' : 'Destinatário de alertas desativado.');
    } else if (command === 'ldap') {
      const [, , domain, url, baseDn, bindDn] = process.argv.slice(2);
      if (!domain || !url || !baseDn || !bindDn) throw new Error('Use ldap <grupo> <dominio> <ldaps://host:636> <base-dn> <bind-dn>.');
      await ldapDirectory(db, uuid(one, 'o grupo'), domain, url, baseDn, bindDn);
      console.log('Diretório LDAP configurado. Cadastre os membros pelo objectGUID (ou entryUUID) em Administração.');
    } else if (command === 'requests') {
      await requests(db);
    } else {
      throw new Error('Use migrate, requests, ldap <grupo> <dominio> <url> <base-dn> <bind-dn>, recipient <grupo> <email>, recipient-remove <grupo> <email>, configure <tenant> <oid> [nome], farm <grupo> <nome> <local>, enroll <grupo> <fazenda> ou revoke <grupo> <fazenda>.');
    }
  } finally {
    await db.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no comando');
  process.exitCode = 1;
});
