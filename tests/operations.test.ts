import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { emitMetrics, log } from '../apps/web/src/server/log';
import { databaseReachable, operationalMetrics } from '../apps/web/src/server/operations';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

test('métricas de operação agregam fila, coletores e e-mails sem identificar clientes', async () => {
  const orgId = randomUUID();
  const farmId = randomUUID();
  const collectorId = randomUUID();
  const captureId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo']);
    await setOrg(tx, orgId);
    await tx.query('INSERT INTO farms (org_id, id, name, location) VALUES ($1, $2, $3, $4)', [orgId, farmId, 'Fazenda', 'MT']);
    await tx.query(`INSERT INTO collector_keys (org_id, farm_id, key_id, collector_id, public_key) VALUES ($1, $2, $3, $4, '{}')`, [orgId, farmId, randomUUID(), collectorId]);
    await tx.query(`INSERT INTO collector_health (org_id, farm_id, collector_id, last_heartbeat_at, last_capture_at, clock_skew_seconds)
      VALUES ($1, $2, $3, now() - interval '10 minutes', now() - interval '20 minutes', -42)`, [orgId, farmId, collectorId]);
    await tx.query(`INSERT INTO captures (org_id, farm_id, collector_id, id, seq, observed_at, parts) VALUES ($1, $2, $3, $4, 1, now(), 1)`, [orgId, farmId, collectorId, captureId]);
    await tx.query(`INSERT INTO inventory_outbox (id, org_id, farm_id, collector_id, capture_id, available_at) VALUES ($1, $2, $3, $4, $5, now() - interval '7 minutes')`,
      [randomUUID(), orgId, farmId, collectorId, captureId]);
  });
  const metrics = await operationalMetrics(db);
  assert.equal(metrics.OutboxPending, 1);
  assert.ok(metrics.OutboxOldestSeconds >= 419 && metrics.OutboxOldestSeconds <= 425);
  assert.equal(metrics.CollectorsSilent, 1);
  assert.equal(metrics.CollectorsStale, 1);
  assert.equal(metrics.MaxClockSkewSeconds, 42);
  assert.ok(metrics.MaxCaptureAgeSeconds >= 1199);
  assert.equal(await databaseReachable(db), true);
});

test('logs e métricas saem como JSON de uma linha no formato do CloudWatch', (context) => {
  const lines: string[] = [];
  context.mock.method(console, 'info', (line: string) => { lines.push(line); });
  log.info('Evento', { job: 'x' });
  emitMetrics({ OutboxPending: 3, OutboxOldestSeconds: 12 }, { OutboxOldestSeconds: 'Seconds' });
  const [event, metric] = lines.map((line) => JSON.parse(line));
  assert.equal(event.level, 'info');
  assert.equal(event.message, 'Evento');
  assert.equal(event.job, 'x');
  assert.equal(metric._aws.CloudWatchMetrics[0].Namespace, 'Malha');
  assert.deepEqual(metric._aws.CloudWatchMetrics[0].Metrics, [{ Name: 'OutboxPending', Unit: 'Count' }, { Name: 'OutboxOldestSeconds', Unit: 'Seconds' }]);
  assert.equal(metric.OutboxPending, 3);
});
