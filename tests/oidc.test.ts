import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { deactivateMember, saveMember } from '../apps/web/src/server/admin';
import { migrate, pgliteDatabase, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import { linkOidcIdentity } from '../apps/web/src/server/oidc';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;
const ISSUER = 'https://accounts.google.com';

async function group(name: string) {
  const orgId = randomUUID();
  const adminOid = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, name]);
  await db.query(`INSERT INTO memberships (org_id, entra_oid, role) VALUES ($1, $2, 'admin')`, [orgId, adminOid]);
  const admin: Principal = { orgId, actor: adminOid, role: 'admin', farmIds: null, demo: false };
  return { orgId, admin };
}

test('convite por e-mail liga a conta do provedor no primeiro login', async () => {
  const { orgId, admin } = await group('Grupo OIDC');
  const other = await group('Outro grupo');
  const oid = randomUUID();
  await saveMember(db, admin, oid, { displayName: 'Ana', inviteEmail: ' Ana@Empresa.com.br ', role: 'ti', farmIds: [] });
  await assert.rejects(saveMember(db, admin, randomUUID(), { inviteEmail: 'ana@empresa.com.br', role: 'diretoria', farmIds: [] }), status(409));
  await saveMember(db, admin, randomUUID(), { displayName: 'Sem convite', inviteEmail: '', role: 'diretoria', farmIds: [] });

  await assert.rejects(linkOidcIdentity(db, orgId, { issuer: ISSUER, subject: '1001', email: 'ana@empresa.com.br', emailVerified: false }), status(403));
  await assert.rejects(linkOidcIdentity(db, orgId, { issuer: ISSUER, subject: '1001', email: 'ana@empresa.com.br' }), status(403));
  await assert.rejects(linkOidcIdentity(db, other.orgId, { issuer: ISSUER, subject: '1001', email: 'ana@empresa.com.br', emailVerified: true }), status(403));

  const first = await linkOidcIdentity(db, orgId, { issuer: ISSUER, subject: '1001', email: 'ANA@empresa.com.br', emailVerified: true });
  assert.deepEqual(first, { oid, linked: true });
  const again = await linkOidcIdentity(db, orgId, { issuer: ISSUER, subject: '1001', email: 'ana.nova@empresa.com.br', emailVerified: false });
  assert.deepEqual(again, { oid, linked: false });
  // O convite já foi usado: outra conta com o mesmo e-mail não pega a associação.
  await assert.rejects(linkOidcIdentity(db, orgId, { issuer: ISSUER, subject: '2002', email: 'ana@empresa.com.br', emailVerified: true }), status(403));

  await deactivateMember(db, admin, oid);
  await assert.rejects(linkOidcIdentity(db, orgId, { issuer: ISSUER, subject: '1001', email: 'ana@empresa.com.br', emailVerified: true }), status(403));
});
