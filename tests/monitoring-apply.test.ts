import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createFarm } from '../apps/web/src/server/admin';
import { createAsset } from '../apps/web/src/server/assets';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import { applyGrafana, applyZabbix, listConnections, safeEndpoint, saveConnection, type Fetcher, type Resolver } from '../apps/web/src/server/monitoring-apply';

process.env.MALHA_AUTH_SECRET = 'segredo-de-teste-com-mais-de-32-bytes-aqui';
let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;
const resolve: Resolver = async (host) => (host === 'interno.exemplo' ? ['127.0.0.1'] : ['10.20.0.5']);

test('URL de integração só aceita HTTPS e endereços que não são locais', async () => {
  assert.equal(await safeEndpoint('https://zabbix.grupo.local/', resolve), 'https://zabbix.grupo.local');
  await assert.rejects(safeEndpoint('http://zabbix.grupo.local', resolve), status(400));
  await assert.rejects(safeEndpoint('https://127.0.0.1', resolve), status(400));
  await assert.rejects(safeEndpoint('https://169.254.169.254/latest', resolve), status(400));
  await assert.rejects(safeEndpoint('https://[::1]', resolve), status(400));
  await assert.rejects(safeEndpoint('https://interno.exemplo', resolve), status(400));
  await assert.rejects(safeEndpoint('https://user:pass@zabbix.grupo.local', resolve), status(400));
});

test('aplica no Zabbix e no Grafana com o token guardado cifrado', async () => {
  const orgId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo API']);
  const admin: Principal = { orgId, actor: randomUUID(), role: 'admin', farmIds: null, demo: false };
  const farm = (await createFarm(db, admin, { name: 'Fazenda A', location: 'Sorriso · MT' })).id;
  await createAsset(db, admin, { farmId: farm, name: 'Core', category: 'Switch', ip: '10.0.0.1', critical: true });
  await db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    await tx.query("UPDATE assets SET model = 'Cisco Catalyst 9200' WHERE org_id = $1", [orgId]);
  });

  await assert.rejects(saveConnection(db, { ...admin, role: 'ti' }, { kind: 'zabbix', url: 'https://zabbix.grupo.local', token: 'token-zabbix-123' }, resolve), status(403));
  await saveConnection(db, admin, { kind: 'zabbix', url: 'https://zabbix.grupo.local', token: 'token-zabbix-123' }, resolve);
  await saveConnection(db, admin, { kind: 'grafana', url: 'https://grafana.grupo.local', token: 'token-grafana-456' }, resolve);
  const listed = await listConnections(db, admin);
  assert.equal(listed.length, 2);
  assert.ok(!JSON.stringify(listed).includes('token-'));
  const stored = await db.transaction(async (tx) => { await setOrg(tx, orgId); return (await tx.query('SELECT token FROM monitoring_connections WHERE org_id = $1', [orgId])).rows; });
  assert.ok(stored.every((row) => !String(row.token).includes('token-')));

  type Body = { method?: string; params?: { source: string }; uid?: string; folderUid?: string; overwrite?: boolean; dashboard?: Record<string, unknown> };
  const calls: Array<{ url: string; body: Body; auth: string }> = [];
  const fetcher: Fetcher = async (url, init) => {
    const body = (init.body ? JSON.parse(init.body) : {}) as Body;
    calls.push({ url, body, auth: init.headers.Authorization });
    const reply = (status: number, payload: unknown) => ({ ok: status < 400, status, json: async () => payload });
    if (url.endsWith('/api_jsonrpc.php') && body.method === 'template.get') return reply(200, { result: [{ host: 'ICMP Ping' }] });
    if (url.endsWith('/api_jsonrpc.php') && body.method === 'configuration.import') return reply(200, { result: true });
    if (url.endsWith('/api/datasources')) return reply(200, [{ uid: 'zbx-uid', type: 'alexanderzobnin-zabbix-datasource', name: 'Zabbix' }]);
    if (url.endsWith('/api/folders/malha')) return reply(404, { message: 'not found' });
    if (url.endsWith('/api/folders')) return reply(200, { uid: 'malha' });
    if (url.endsWith('/api/dashboards/db')) return reply(200, { status: 'success' });
    return reply(500, null);
  };

  const zabbix = await applyZabbix(db, admin, new URLSearchParams({ model: 'malha' }), fetcher, resolve);
  assert.equal(zabbix.hosts, 1);
  assert.deepEqual(zabbix.missingTemplates, ['Cisco IOS by SNMP']);
  const imported = JSON.parse(calls.find((call) => call.body.method === 'configuration.import')!.body.params!.source);
  assert.deepEqual(imported.zabbix_export.hosts[0].templates, [{ name: 'ICMP Ping' }]);
  assert.equal(calls[0].auth, 'Bearer token-zabbix-123');

  const grafana = await applyGrafana(db, admin, new URLSearchParams({ model: 'malha' }), fetcher, resolve);
  assert.equal(grafana.dashboards, 1);
  const posted = calls.find((call) => call.url.endsWith('/api/dashboards/db'))!.body;
  assert.equal(posted.folderUid, 'malha');
  assert.equal(posted.overwrite, true);
  assert.ok(!JSON.stringify(posted).includes('DS_ZABBIX'));
  assert.ok(JSON.stringify(posted).includes('zbx-uid'));
  assert.equal(posted.dashboard?.__inputs, undefined);
  assert.ok(calls.some((call) => call.url.endsWith('/api/folders') && call.body.uid === 'malha'));

  await assert.rejects(applyZabbix(db, { ...admin, role: 'ti' }, new URLSearchParams(), fetcher, resolve), status(403));
  const otherOrg = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [otherOrg, 'Outro']);
  await assert.rejects(applyZabbix(db, { ...admin, orgId: otherOrg }, new URLSearchParams(), fetcher, resolve), status(404));
});
