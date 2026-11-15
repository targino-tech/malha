import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { evaluateAll } from '../apps/web/src/server/alerts';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import { composeEmail, sendPendingNotifications, type AlertEmail } from '../apps/web/src/server/notifications';
import { acknowledgeOccurrence } from '../apps/web/src/server/occurrences';
import { processInventoryJob } from '../apps/web/src/server/projection';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

type Fixture = { orgId: string; farmId: string; collectorId: string };

async function fixture(options: { heartbeatAgo?: string; captureAgo?: string; recipients?: string[] } = {}): Promise<Fixture> {
  const orgId = randomUUID();
  const farmId = randomUUID();
  const collectorId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo teste']);
    await setOrg(tx, orgId);
    await tx.query('INSERT INTO farms (org_id, id, name, location) VALUES ($1, $2, $3, $4)', [orgId, farmId, 'Fazenda Teste', 'MT']);
    await tx.query('INSERT INTO collector_keys (org_id, farm_id, key_id, collector_id, public_key) VALUES ($1, $2, $3, $4, $5)',
      [orgId, farmId, randomUUID(), collectorId, '{}']);
    await tx.query(`INSERT INTO collector_health (org_id, farm_id, collector_id, last_heartbeat_at, last_capture_at)
      VALUES ($1, $2, $3, now() - $4::interval, now() - $5::interval)`,
    [orgId, farmId, collectorId, options.heartbeatAgo ?? '10 seconds', options.captureAgo ?? '1 minute']);
    for (const email of options.recipients ?? []) {
      await tx.query('INSERT INTO alert_recipients (org_id, email) VALUES ($1, $2)', [orgId, email]);
    }
  });
  return { orgId, farmId, collectorId };
}

async function asset(f: Fixture, values: { name: string; critical?: boolean; status?: string; missing?: number; observedAgo?: string }) {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await setOrg(tx, f.orgId);
    await tx.query(`INSERT INTO assets (org_id, farm_id, id, name, category, critical, source, external_id, status,
        last_observed_at, last_collector_id, missing_captures)
      VALUES ($1, $2, $3, $4, 'Switch', $5, 'unifi', $6, $7, now() - $8::interval, $9, $10)`,
    [f.orgId, f.farmId, id, values.name, values.critical ?? false, randomUUID(), values.status ?? 'online',
      values.observedAgo ?? '1 minute', f.collectorId, values.missing ?? 0]);
  });
  return id;
}

async function run(f: Fixture, sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await setOrg(tx, f.orgId);
    return (await tx.query<Record<string, unknown>>(sql, params)).rows;
  });
}

const occurrences = (f: Fixture) => run(f, `SELECT rule, severity, resource_id, resolved_at, resolution, acknowledged_by
  FROM occurrences WHERE org_id = $1 ORDER BY opened_at, rule`, [f.orgId]);

test('coletor sem contato abre uma única ocorrência crítica e encerra ao voltar', async () => {
  const f = await fixture({ heartbeatAgo: '5 minutes', recipients: ['ti@example.com'] });
  await evaluateAll(db);
  await evaluateAll(db);
  let rows = await occurrences(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rule, 'collector_silent');
  assert.equal(rows[0].severity, 'critical');
  assert.equal((await run(f, 'SELECT recipient FROM notifications WHERE org_id = $1', [f.orgId])).length, 1);

  await run(f, 'UPDATE collector_health SET last_heartbeat_at = now() WHERE org_id = $1', [f.orgId]);
  await evaluateAll(db);
  rows = await occurrences(f);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].resolved_at);
  assert.equal(rows[0].resolution, 'auto');
  const events = await run(f, 'SELECT kind FROM occurrence_events WHERE org_id = $1 ORDER BY occurred_at, kind DESC', [f.orgId]);
  assert.deepEqual(events.map((event) => event.kind), ['opened', 'resolved']);
});

test('ativo offline usa a criticidade e é suprimido enquanto o coletor está sem contato', async () => {
  const live = await fixture();
  const switchId = await asset(live, { name: 'Switch do armazém', critical: true, status: 'offline' });
  await asset(live, { name: 'AP do pátio', status: 'offline' });
  await evaluateAll(db);
  const rows = await occurrences(live);
  assert.deepEqual(rows.map((row) => [row.rule, row.severity]).sort(), [['asset_offline', 'critical'], ['asset_offline', 'warning']]);

  await run(live, `UPDATE assets SET status = 'online', last_observed_at = now() WHERE org_id = $1 AND id = $2`, [live.orgId, switchId]);
  await evaluateAll(db);
  const resolved = (await occurrences(live)).filter((row) => row.resolved_at);
  assert.deepEqual(resolved.map((row) => row.resource_id), [switchId]);

  const silent = await fixture({ heartbeatAgo: '5 minutes' });
  await asset(silent, { name: 'Switch sem contato', critical: true, status: 'offline' });
  await evaluateAll(db);
  assert.deepEqual((await occurrences(silent)).map((row) => row.rule), ['collector_silent']);
});

test('coleta desatualizada e divergência de inventário abrem avisos', async () => {
  const f = await fixture({ captureAgo: '20 minutes' });
  const missing = await asset(f, { name: 'AP removido', missing: 3, status: 'unknown', observedAgo: '20 minutes' });
  await asset(f, { name: 'AP com uma ausência', missing: 1, status: 'unknown' });
  await evaluateAll(db);
  assert.deepEqual((await occurrences(f)).map((row) => [row.rule, row.severity]).sort(),
    [['asset_missing', 'warning'], ['capture_stale', 'warning']]);

  await run(f, 'UPDATE assets SET missing_captures = 0 WHERE org_id = $1 AND id = $2', [f.orgId, missing]);
  await run(f, 'UPDATE collector_health SET last_capture_at = now() WHERE org_id = $1', [f.orgId]);
  await evaluateAll(db);
  assert.ok((await occurrences(f)).every((row) => row.resolved_at));
});

test('reconhecimento registra o operador, audita e respeita o escopo da organização', async () => {
  const f = await fixture({ heartbeatAgo: '5 minutes' });
  const other = await fixture();
  await evaluateAll(db);
  const [{ id }] = await run(f, 'SELECT id FROM occurrences WHERE org_id = $1', [f.orgId]) as Array<{ id: string }>;

  const outsider = { orgId: other.orgId, actor: 'oid-externo', role: 'ti' as const, farmIds: null, demo: false };
  await assert.rejects(acknowledgeOccurrence(db, outsider, id), (error: unknown) => error instanceof HttpError && error.status === 404);
  const board = { orgId: f.orgId, actor: 'oid-diretoria', role: 'diretoria' as const, farmIds: null, demo: false };
  await assert.rejects(acknowledgeOccurrence(db, board, id), (error: unknown) => error instanceof HttpError && error.status === 403);

  const operator = { orgId: f.orgId, actor: 'oid-ti', role: 'ti' as const, farmIds: null, demo: false };
  const first = await acknowledgeOccurrence(db, operator, id);
  const second = await acknowledgeOccurrence(db, { ...operator, actor: 'oid-outro' }, id);
  assert.equal(first.acknowledgedAt, second.acknowledgedAt);
  assert.equal((await occurrences(f))[0].acknowledged_by, 'oid-ti');
  assert.equal((await run(f, `SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'occurrence.acknowledge'`, [f.orgId])).length, 1);
});

test('e-mails são agrupados por fazenda, deduplicados e suprimidos durante perda de contato', async () => {
  const f = await fixture({ recipients: ['ti@example.com', 'gerente@example.com'] });
  await asset(f, { name: 'Gateway', critical: true, status: 'offline' });
  await asset(f, { name: 'Switch', critical: true, status: 'offline' });
  await evaluateAll(db);
  const sent: AlertEmail[] = [];
  const transport = { async send(message: AlertEmail) { sent.push(message); } };
  await sendPendingNotifications(db, transport, 'https://app.example');
  const mine = sent.filter((message) => message.text.includes('Fazenda Teste'));
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((message) => message.to).sort(), ['gerente@example.com', 'ti@example.com']);
  assert.match(mine[0].subject, /2 ocorrências críticas/);
  assert.match(mine[0].text, /Gateway/);

  sent.length = 0;
  await sendPendingNotifications(db, transport);
  assert.equal(sent.length, 0);

  const silent = await fixture({ recipients: ['ti@example.com'] });
  await asset(silent, { name: 'Câmera da portaria', critical: true, status: 'offline' });
  await evaluateAll(db);
  await run(silent, 'UPDATE collector_health SET last_heartbeat_at = now() - interval \'10 minutes\' WHERE org_id = $1', [silent.orgId]);
  await evaluateAll(db);
  await sendPendingNotifications(db, transport);
  const statuses = await run(silent, `SELECT o.rule, n.status FROM notifications n JOIN occurrences o ON o.org_id = n.org_id AND o.id = n.occurrence_id
    WHERE n.org_id = $1 ORDER BY o.rule`, [silent.orgId]);
  assert.deepEqual(statuses.map((row) => [row.rule, row.status]), [['asset_offline', 'suppressed'], ['collector_silent', 'sent']]);
});

test('o assunto do e-mail não aceita quebras de linha vindas do cadastro', () => {
  const message = composeEmail('ti@example.com', [{
    occurrence_id: randomUUID(), recipient: 'ti@example.com', farm_id: randomUUID(), farm_name: 'Fazenda\r\nBcc: x@example.com',
    timezone: 'America/Cuiaba', rule: 'asset_offline', resource_kind: 'asset', title: 'Ativo offline: AP', opened_at: new Date(),
    resolved_at: null, suppressed: false,
  }]);
  assert.doesNotMatch(message.subject, /[\r\n]/);
});

test('a projeção conta ausências consecutivas e guarda o início do episódio offline', async () => {
  const f = await fixture();
  async function capture(sequence: number, devices: Array<{ id: string; state: string }>, minutesAgo: number) {
    const captureId = randomUUID();
    await db.transaction(async (tx) => {
      await setOrg(tx, f.orgId);
      await tx.query(`INSERT INTO captures (org_id, farm_id, collector_id, id, seq, observed_at, parts)
        VALUES ($1, $2, $3, $4, $5, now() - make_interval(mins => $6), 1)`, [f.orgId, f.farmId, f.collectorId, captureId, sequence, minutesAgo]);
      await tx.query(`INSERT INTO capture_batches (org_id, farm_id, collector_id, capture_id, id, part, content_hash, devices)
        VALUES ($1, $2, $3, $4, $5, 1, 'fixture', $6)`, [f.orgId, f.farmId, f.collectorId, captureId, randomUUID(), JSON.stringify(devices)]);
      await tx.query('INSERT INTO inventory_outbox (id, org_id, farm_id, collector_id, capture_id) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), f.orgId, f.farmId, f.collectorId, captureId]);
    });
    while (await processInventoryJob(db)) { /* drena a fila */ }
  }
  const state = () => run(f, 'SELECT external_id, status, offline_since, missing_captures FROM assets WHERE org_id = $1 ORDER BY external_id', [f.orgId]);

  await capture(1, [{ id: 'ap', state: 'ONLINE' }, { id: 'sw', state: 'OFFLINE' }], 10);
  await capture(2, [{ id: 'ap', state: 'ONLINE' }, { id: 'sw', state: 'OFFLINE' }], 5);
  let [ap, sw] = await state();
  assert.equal(sw.status, 'offline');
  assert.ok(sw.offline_since);
  const since = new Date(sw.offline_since as Date).getTime();
  assert.ok(Date.now() - since > 9 * 60_000, 'o episódio começa na primeira captura offline');

  for (const sequence of [3, 4, 5]) await capture(sequence, [{ id: 'sw', state: 'ONLINE' }], 5 - sequence);
  [ap, sw] = await state();
  assert.equal(ap.missing_captures, 3);
  assert.equal(ap.status, 'unknown');
  assert.equal(sw.offline_since, null);
  assert.equal(sw.missing_captures, 0);
});
