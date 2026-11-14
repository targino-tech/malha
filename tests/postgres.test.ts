import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connectPostgres, migrate, setOrg } from '../apps/web/src/server/db';
import { processInventoryJob } from '../apps/web/src/server/projection';

const databaseUrl = process.env.MALHA_TEST_DATABASE_URL;

test('PostgreSQL aplica migrações, impõe RLS e processa a outbox', { skip: !databaseUrl }, async () => {
  const db = connectPostgres(databaseUrl);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const farmId = randomUUID();
  const collectorId = randomUUID();
  const captureId = randomUUID();
  const outboxId = randomUUID();
  const role = `malha_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await migrate(db);
    await migrate(db);
    await db.transaction(async tx => {
      await tx.query('INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)', [orgId, 'Grupo A', otherOrgId, 'Grupo B']);
      await setOrg(tx, orgId);
      await tx.query('INSERT INTO farms (org_id, id, name, location) VALUES ($1, $2, $3, $4)', [orgId, farmId, 'Fazenda A', 'MT']);
      await tx.query('INSERT INTO collector_keys (org_id, farm_id, key_id, collector_id, public_key) VALUES ($1, $2, $3, $4, $5)',
        [orgId, farmId, randomUUID(), collectorId, '{}']);
      await tx.query('INSERT INTO collector_health (org_id, farm_id, collector_id, last_heartbeat_at) VALUES ($1, $2, $3, now())',
        [orgId, farmId, collectorId]);
      await tx.query('INSERT INTO captures (org_id, farm_id, collector_id, id, seq, observed_at, parts) VALUES ($1, $2, $3, $4, 1, now(), 1)',
        [orgId, farmId, collectorId, captureId]);
      await tx.query('INSERT INTO capture_batches (org_id, farm_id, collector_id, capture_id, id, part, content_hash, devices) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)',
        [orgId, farmId, collectorId, captureId, randomUUID(), 'fixture', JSON.stringify([{ id: 'ap-1', name: 'AP laboratório', state: 'ONLINE' }])]);
      await tx.query('INSERT INTO inventory_outbox (id, org_id, farm_id, collector_id, capture_id) VALUES ($1, $2, $3, $4, $5)',
        [outboxId, orgId, farmId, collectorId, captureId]);
    });

    assert.equal(await processInventoryJob(db), true);
    const { rows: [job] } = await db.query('SELECT finished_at, attempts FROM inventory_outbox WHERE id = $1', [outboxId]);
    assert.ok(job.finished_at);
    assert.equal(job.attempts, 0);

    await db.transaction(async tx => {
      await tx.exec(`CREATE ROLE ${role} NOLOGIN; GRANT SELECT ON assets TO ${role}; SET LOCAL ROLE ${role}`);
      assert.deepEqual((await tx.query('SELECT name FROM assets')).rows, []);
      await setOrg(tx, otherOrgId);
      assert.deepEqual((await tx.query('SELECT name FROM assets')).rows, []);
      await setOrg(tx, orgId);
      assert.deepEqual((await tx.query('SELECT name, status FROM assets')).rows, [{ name: 'AP laboratório', status: 'online' }]);
      await tx.exec(`RESET ROLE; REVOKE SELECT ON assets FROM ${role}; DROP ROLE ${role}`);
    });
  } finally {
    await db.transaction(async tx => {
      await setOrg(tx, orgId);
      for (const table of ['inventory_outbox', 'capture_batches', 'captures', 'assets', 'collector_health', 'collector_keys', 'farms']) {
        await tx.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
      }
      await tx.query('DELETE FROM organizations WHERE id = $1 OR id = $2', [orgId, otherOrgId]);
    }).finally(() => db.close());
  }
});
