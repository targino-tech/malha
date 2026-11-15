import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createFarm } from '../apps/web/src/server/admin';
import { createAsset } from '../apps/web/src/server/assets';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import { catalogEntries, grafanaExport, planMonitoring, zabbixExport } from '../apps/web/src/server/monitoring';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

const denied = (error: unknown) => error instanceof HttpError && error.status === 403;

test('monitoramento gera Zabbix e Grafana no escopo do usuário', async () => {
  const orgId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo']);
  const admin: Principal = { orgId, actor: randomUUID(), role: 'admin', farmIds: null, demo: false };
  const farmA = (await createFarm(db, admin, { name: 'Fazenda A', location: 'Sorriso · MT' })).id;
  const farmB = (await createFarm(db, admin, { name: 'Fazenda B', location: 'Sinop · MT' })).id;
  await createAsset(db, admin, { farmId: farmA, name: 'Core', category: 'Switch', ip: '10.0.0.1', critical: true });
  await createAsset(db, admin, { farmId: farmA, name: 'DC01', category: 'Controlador de domínio', ip: '10.0.0.10', critical: true });
  await createAsset(db, admin, { farmId: farmA, name: 'Balança', category: 'Balança', critical: false });
  await createAsset(db, admin, { farmId: farmB, name: 'Enlace', category: 'Rádio', ip: '10.1.0.2', critical: false });
  // O modelo vem da coleta UniFi; aqui é gravado direto, como a projeção faria.
  await db.transaction(async (tx) => {
    await setOrg(tx, orgId);
    await tx.query(`UPDATE assets SET model = CASE name WHEN 'Core' THEN 'Cisco Catalyst 9200' WHEN 'Enlace' THEN 'LiteBeam 5AC' END
      WHERE org_id = $1 AND name IN ('Core', 'Enlace')`, [orgId]);
  });

  const plan = await planMonitoring(db, admin, new URLSearchParams({ model: 'malha' }));
  assert.equal(plan.hosts.length, 3);
  assert.deepEqual(plan.skipped.map((item) => item.name), ['Balança']);
  const core = plan.hosts.find((host) => host.name.startsWith('Core'))!;
  assert.deepEqual(core.templates, ['ICMP Ping', 'Cisco IOS by SNMP']);
  assert.equal(plan.hosts.find((host) => host.name.startsWith('Enlace'))!.templates[1], 'Ubiquiti AirOS by SNMP');
  assert.equal(plan.hosts.find((host) => host.name.startsWith('DC01'))!.iface, 'agent');

  const exported = zabbixExport(orgId, plan).zabbix_export;
  assert.equal(exported.version, '7.0');
  assert.ok(exported.host_groups.some((group) => group.name === 'Malha/Fazenda: Fazenda A'));
  assert.ok(exported.host_groups.every((group) => /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(group.uuid)));
  const coreHost = exported.hosts.find((host) => host.name.startsWith('Core'))!;
  assert.equal(coreHost.interfaces[0].type, 'SNMP');
  assert.ok(coreHost.tags.some((tag) => tag.tag === 'malha.family' && tag.value === 'core'));
  assert.deepEqual(zabbixExport(orgId, plan).zabbix_export.host_groups, exported.host_groups);

  const base = await planMonitoring(db, admin, new URLSearchParams({ model: 'base' }));
  assert.ok(base.hosts.every((host) => host.templates.length === 1 && host.templates[0] === 'ICMP Ping'));

  const dashboards = grafanaExport(orgId, plan);
  assert.equal(dashboards.length, plan.families.length);
  assert.equal(dashboards[0].dashboard.__inputs[0].pluginId, 'alexanderzobnin-zabbix-datasource');
  assert.equal(grafanaExport(orgId, plan)[0].dashboard.uid, dashboards[0].dashboard.uid);

  const scoped: Principal = { ...admin, role: 'ti', farmIds: [farmB] };
  const onlyB = await planMonitoring(db, scoped, new URLSearchParams());
  assert.deepEqual(onlyB.hosts.map((host) => host.farm), ['Fazenda B']);
  await assert.rejects(planMonitoring(db, scoped, new URLSearchParams({ farmId: farmA })), (error) => error instanceof HttpError && [403, 404].includes(error.status));
  await assert.rejects(planMonitoring(db, { ...admin, role: 'tecnico', farmIds: [farmA] }, new URLSearchParams()), denied);
  await assert.rejects(planMonitoring(db, { ...admin, role: 'auditor' }, new URLSearchParams()), denied);

  const otherOrg = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [otherOrg, 'Outro']);
  const outsider: Principal = { orgId: otherOrg, actor: randomUUID(), role: 'admin', farmIds: null, demo: false };
  assert.equal((await planMonitoring(db, outsider, new URLSearchParams())).hosts.length, 0);
  await assert.rejects(planMonitoring(db, outsider, new URLSearchParams({ farmId: farmA })), (error) => error instanceof HttpError && error.status === 404);
});

// Nomes técnicos conferidos no repositório oficial do Zabbix (zabbix/zabbix, release/7.0, templates/).
const ZABBIX_70_TEMPLATES = new Set([
  'ICMP Ping', 'Network Generic Device by SNMP', 'Cisco IOS by SNMP', 'Huawei VRP by SNMP', 'Ubiquiti AirOS by SNMP',
  'FortiGate by SNMP', 'Mikrotik by SNMP', 'TP-LINK by SNMP', 'Aruba CX 8300s by SNMP', 'Windows by Zabbix agent', 'Linux by Zabbix agent',
]);

test('fabricantes recebem o template oficial do Zabbix 7.0 e o catálogo só usa nomes existentes', async () => {
  const orgId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo fabricantes']);
  const admin: Principal = { orgId, actor: randomUUID(), role: 'admin', farmIds: null, demo: false };
  const farmId = (await createFarm(db, admin, { name: 'Fazenda C', location: 'Juara · MT' })).id;
  const assets: Array<[string, string, string]> = [
    ['FortiGate 60F', 'Firewall', '10.2.0.1'],
    ['Switch TP-Link Omada', 'Switch', '10.2.0.2'],
    ['MikroTik hEX', 'Roteador', '10.2.0.3'],
    ['Core Aruba CX 8300', 'Switch', '10.2.0.4'],
    ['AP Aruba 515', 'Ponto de acesso', '10.2.0.5'],
    ['Switch Intelbras SG 2404', 'Switch', '10.2.0.6'],
  ];
  for (const [name, category, ip] of assets) await createAsset(db, admin, { farmId, name, category, ip, critical: false });
  const plan = await planMonitoring(db, admin, new URLSearchParams({ model: 'malha' }));
  const templateOf = (name: string) => plan.hosts.find((host) => host.name.startsWith(name))!.templates[1];
  assert.equal(templateOf('FortiGate'), 'FortiGate by SNMP');
  assert.equal(templateOf('Switch TP-Link'), 'TP-LINK by SNMP');
  assert.equal(templateOf('MikroTik'), 'Mikrotik by SNMP');
  assert.equal(templateOf('Core Aruba CX 8300'), 'Aruba CX 8300s by SNMP');
  assert.equal(templateOf('AP Aruba'), 'Network Generic Device by SNMP');
  assert.equal(templateOf('Switch Intelbras'), 'Network Generic Device by SNMP');
  for (const template of plan.templates) assert.ok(ZABBIX_70_TEMPLATES.has(template), template);
  for (const entry of catalogEntries()) for (const template of [...entry.base, ...entry.malha]) assert.ok(ZABBIX_70_TEMPLATES.has(template), template);
});
