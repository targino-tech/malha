import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createFarm } from '../apps/web/src/server/admin';
import { createAsset } from '../apps/web/src/server/assets';
import { charts } from '../apps/web/src/server/charts';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

async function group(name: string) {
  const orgId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, name]);
  const admin: Principal = { orgId, actor: randomUUID(), role: 'admin', farmIds: null, demo: false };
  const farmA = (await createFarm(db, admin, { name: `${name} A`, location: 'Sorriso · MT' })).id;
  const farmB = (await createFarm(db, admin, { name: `${name} B`, location: 'Sinop · MT' })).id;
  return { orgId, admin, farmA, farmB };
}

async function silentEpisode(orgId: string, farmId: string, collectorId: string, hoursAgo: number, minutes: number) {
  await db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    await tx.query(`INSERT INTO occurrences (org_id, farm_id, id, rule, resource_kind, resource_id, severity, title, first_observed_at, opened_at, resolved_at, resolution)
      VALUES ($1, $2, $3, 'collector_silent', 'collector', $4, 'critical', 'Coletor sem contato',
        now() - make_interval(hours => $5) - make_interval(mins => $6), now() - make_interval(hours => $5) - make_interval(mins => $6 - 3),
        now() - make_interval(hours => $5), 'auto')`, [orgId, farmId, randomUUID(), collectorId, hoursAgo, minutes]);
  });
}

async function collector(orgId: string, farmId: string) {
  const collectorId = randomUUID();
  await db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    await tx.query('INSERT INTO collector_keys (key_id, collector_id, org_id, farm_id, public_key) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), collectorId, orgId, farmId, '{}']);
  });
  return collectorId;
}

test('gráficos respeitam o grupo e as fazendas do usuário', async () => {
  const mine = await group('Grupo A');
  const other = await group('Grupo B');
  await createAsset(db, mine.admin, { farmId: mine.farmA, name: 'Balança', category: 'Balança', critical: false });
  await createAsset(db, mine.admin, { farmId: mine.farmB, name: 'Rádio', category: 'Rádio', critical: false });
  await createAsset(db, other.admin, { farmId: other.farmA, name: 'Switch alheio', category: 'Switch', critical: false });
  const collectorA = await collector(mine.orgId, mine.farmA);
  const collectorOther = await collector(other.orgId, other.farmA);
  await silentEpisode(mine.orgId, mine.farmA, collectorA, 5, 120);
  await silentEpisode(other.orgId, other.farmA, collectorOther, 5, 600);

  const all = await charts(db, mine.admin, new URLSearchParams({ days: '7' }));
  assert.deepEqual(all.assetStates.map((row) => row.name).sort(), ['Grupo A A', 'Grupo A B']);
  assert.deepEqual(all.categories.map((row) => row.category).sort(), ['Balança', 'Rádio']);
  assert.equal(all.availability.length, 1);
  assert.equal(all.availability[0].silentMinutes, 120);
  assert.ok(Math.abs(all.availability[0].ratio - (1 - 120 / (7 * 1440))) < 1e-9);
  assert.equal(all.occurrencesByDay.length, 7);
  assert.equal(all.occurrencesByDay.reduce((sum, day) => sum + day.critical, 0), 1);
  assert.equal(all.assetStates.find((row) => row.farmId === mine.farmA)?.manual, 1);

  const scoped: Principal = { ...mine.admin, role: 'tecnico', farmIds: [mine.farmB] };
  const onlyB = await charts(db, scoped, new URLSearchParams({ days: '30' }));
  assert.deepEqual(onlyB.assetStates.map((row) => row.farmId), [mine.farmB]);
  assert.deepEqual(onlyB.categories.map((row) => row.category), ['Rádio']);
  assert.equal(onlyB.availability.length, 0);
  assert.equal(onlyB.occurrencesByDay.reduce((sum, day) => sum + day.critical, 0), 0);

  await assert.rejects(charts(db, scoped, new URLSearchParams({ farmId: mine.farmA })), (error) => error instanceof HttpError && [403, 404].includes(error.status));
  await assert.rejects(charts(db, mine.admin, new URLSearchParams({ farmId: other.farmA })), (error) => error instanceof HttpError && [403, 404].includes(error.status));
  await assert.rejects(charts(db, mine.admin, new URLSearchParams({ days: '12' })), (error) => error instanceof HttpError && error.status === 400);
});
