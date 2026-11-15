import { randomUUID } from 'node:crypto';
import { issueEnrollmentCode, revokeCollectorKey } from '../../apps/web/src/server/admin';
import { connectPostgres, migrate, setOrg, type Database } from '../../apps/web/src/server/db';
import { uuidPattern } from '../../apps/web/src/server/http';

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

function email(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !/^[^s@]+@[^s@]+.[^s@]+$/.test(normalized)) throw new Error('Forneça um e-mail válido.');
  return normalized;
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
    } else {
      throw new Error('Use migrate, recipient <grupo> <email>, recipient-remove <grupo> <email>, configure <tenant> <oid> [nome], farm <grupo> <nome> <local>, enroll <grupo> <fazenda> ou revoke <grupo> <fazenda>.');
    }
  } finally {
    await db.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no comando');
  process.exitCode = 1;
});
