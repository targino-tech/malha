import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import { authenticateLdap, directoryUuid, escapeFilter, openSecret, sealSecret, type Connect } from '../apps/web/src/server/ldap';

const SECRET = 'segredo-de-teste-com-mais-de-32-bytes-aqui';
let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;

// objectGUID de exemplo: 01020304-0506-0708-090a-0b0c0d0e0f10 em bytes do AD.
const GUID_BYTES = Buffer.from([4, 3, 2, 1, 6, 5, 8, 7, 9, 10, 11, 12, 13, 14, 15, 16]);
const GUID = '01020304-0506-0708-090a-0b0c0d0e0f10';

function fakeDirectory(calls: string[]): Connect {
  return () => ({
    async startTLS() { calls.push('starttls'); },
    async bind(dn, password) {
      calls.push(`bind:${dn}`);
      if (dn === 'CN=svc,DC=grupo,DC=local' && password === 'senha-servico') return;
      if (dn === 'CN=Maria,DC=grupo,DC=local' && password === 'correta') return;
      throw new Error('invalidCredentials');
    },
    async search(_base, options) {
      calls.push(`search:${options.filter}`);
      return { searchEntries: options.filter.includes('sAMAccountName=maria') ? [{ dn: 'CN=Maria,DC=grupo,DC=local', objectGUID: GUID_BYTES }] : [] };
    },
    async unbind() { calls.push('unbind'); },
  });
}

test('utilitários do diretório', () => {
  assert.equal(directoryUuid(GUID_BYTES), GUID);
  assert.equal(directoryUuid(['A1B2C3D4-0000-4000-8000-000000000001']), 'a1b2c3d4-0000-4000-8000-000000000001');
  assert.equal(directoryUuid('nada'), null);
  assert.equal(escapeFilter('maria*)(uid=*'), 'maria\\2a\\29\\28uid=\\2a');
  assert.equal(escapeFilter('joão'), 'jo\\c3\\a3o');
  const sealed = sealSecret('senha-servico', SECRET);
  assert.notEqual(sealed, 'senha-servico');
  assert.equal(openSecret(sealed, SECRET), 'senha-servico');
  assert.throws(() => openSecret(sealed, `${SECRET}-outra`));
});

test('login por LDAP abre sessão só para membro ativo com senha válida', async () => {
  const orgId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo LDAP']);
  await db.query(`INSERT INTO ldap_directories (org_id, domain, url, start_tls, base_dn, bind_dn, bind_secret)
    VALUES ($1, 'grupo.local', 'ldap://dc.grupo.local:389', true, 'DC=grupo,DC=local', 'CN=svc,DC=grupo,DC=local', $2)`, [orgId, sealSecret('senha-servico', SECRET)]);

  const calls: string[] = [];
  const directory = fakeDirectory(calls);
  // Ainda sem associação no Malha: a senha confere, mas o acesso é negado.
  await assert.rejects(authenticateLdap(db, { domain: 'grupo.local', username: 'maria', password: 'correta' }, '10.0.0.1', SECRET, directory), status(403));
  assert.deepEqual(calls.slice(0, 2), ['starttls', 'bind:CN=svc,DC=grupo,DC=local']);
  assert.ok(calls.includes('bind:CN=Maria,DC=grupo,DC=local'));

  await db.query(`INSERT INTO memberships (org_id, entra_oid, role) VALUES ($1, $2, 'ti')`, [orgId, GUID]);
  const session = await authenticateLdap(db, { domain: 'GRUPO.local', username: 'GRUPO\\maria', password: 'correta' }, '10.0.0.2', SECRET, directory);
  assert.equal(session.orgId, orgId);
  assert.equal(session.subject, GUID);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  const audit = await db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    return (await tx.query("SELECT action FROM audit_log WHERE org_id = $1 AND action = 'auth.ldap.login'", [orgId])).rows;
  });
  assert.equal(audit.length, 1);

  await assert.rejects(authenticateLdap(db, { domain: 'grupo.local', username: 'maria', password: 'errada' }, '10.0.0.3', SECRET, directory), status(401));
  await assert.rejects(authenticateLdap(db, { domain: 'grupo.local', username: 'maria', password: '' }, '10.0.0.3', SECRET, directory), status(400));
  await assert.rejects(authenticateLdap(db, { domain: 'grupo.local', username: 'ninguem*)(cn=*', password: 'x' }, '10.0.0.3', SECRET, directory), status(401));
  assert.ok(calls.some((call) => call.includes('sAMAccountName=ninguem\\2a\\29\\28cn=\\2a')));
  await assert.rejects(authenticateLdap(db, { domain: 'outro.local', username: 'maria', password: 'correta' }, '10.0.0.3', SECRET, directory), status(401));

  // Limite: 5 tentativas por usuário em 15 minutos.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await authenticateLdap(db, { domain: 'grupo.local', username: 'ze', password: 'x' }, `10.1.0.${attempt}`, SECRET, directory).catch(() => undefined);
  }
  await assert.rejects(authenticateLdap(db, { domain: 'grupo.local', username: 'ze', password: 'x' }, '10.1.0.99', SECRET, directory), status(429));
});

test('diretório sem TLS é recusado pelo banco', async () => {
  const orgId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Sem TLS']);
  await assert.rejects(db.query(`INSERT INTO ldap_directories (org_id, domain, url, start_tls, base_dn, bind_dn, bind_secret)
    VALUES ($1, 'semtls.local', 'ldap://dc:389', false, 'DC=x', 'CN=svc', 'v1.a.b.c')`, [orgId]));
});
