import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireFarm, requirePermission } from './authz';
import { classify, FAMILIES, familyLabel, OTHER_FAMILY, type FamilyId, type VendorId } from './catalog';
import { setOrg, type Database } from './db';
import { HttpError, uuidPattern } from './http';
import type { Principal } from './identity';

/**
 * Monta o monitoramento externo a partir do inventário do Malha.
 * Zabbix: um host por ativo com IP, agrupado por fazenda e por família, com templates oficiais do Zabbix 7.0 LTS.
 * Grafana: um painel por família lendo esse Zabbix pelo plugin oficial (alexanderzobnin-zabbix-datasource).
 * Nada é enviado a lugar nenhum: o resultado são arquivos para importar, gerados no escopo do usuário.
 */

export const MODELS = ['malha', 'base'] as const;
export type Model = (typeof MODELS)[number];

const ICMP = 'ICMP Ping';
const GENERIC_SNMP = 'Network Generic Device by SNMP';

type Interface = 'snmp' | 'agent' | 'none';
type Recipe = { templates: string[]; iface: Interface };

// Templates que acompanham o Zabbix 7.0 LTS. O "Modelo base" usa só ICMP Ping, presente em qualquer instalação.
const VENDOR_SNMP: Partial<Record<VendorId, string>> = {
  cisco: 'Cisco IOS by SNMP',
  huawei: 'Huawei VRP by SNMP',
};

function recipe(family: FamilyId, vendor: VendorId | null, model: Model): Recipe {
  if (model === 'base') return { templates: [ICMP], iface: 'none' };
  switch (family) {
    case 'core':
    case 'wifi':
      return { templates: [ICMP, (vendor && VENDOR_SNMP[vendor]) ?? GENERIC_SNMP], iface: 'snmp' };
    case 'radio':
      return { templates: [ICMP, vendor === 'ubiquiti' ? 'Ubiquiti AirOS by SNMP' : GENERIC_SNMP], iface: 'snmp' };
    case 'servers':
    case 'identity':
      if (vendor === 'linux') return { templates: [ICMP, 'Linux by Zabbix agent'], iface: 'agent' };
      if (vendor === 'windows' || family === 'identity') return { templates: [ICMP, 'Windows by Zabbix agent'], iface: 'agent' };
      return { templates: [ICMP], iface: 'none' };
    case 'endpoints':
      return vendor === 'windows' ? { templates: [ICMP, 'Windows by Zabbix agent'], iface: 'agent' } : { templates: [ICMP], iface: 'none' };
    default:
      return { templates: [ICMP], iface: 'none' };
  }
}

// Catálogo exibido na interface: o que cada família recebe em cada modelo.
export function catalogEntries() {
  return [...FAMILIES, OTHER_FAMILY].map((family) => ({
    family: family.id as FamilyId,
    label: family.label,
    base: recipe(family.id as FamilyId, null, 'base').templates,
    malha: [...new Set([
      ...recipe(family.id as FamilyId, null, 'malha').templates,
      ...(['cisco', 'huawei', 'ubiquiti', 'windows', 'linux'] as VendorId[]).flatMap((vendor) => recipe(family.id as FamilyId, vendor, 'malha').templates),
    ])],
    panels: panelsFor(family.id as FamilyId, 'malha').map((panel) => panel.title),
  }));
}

/** UUID v4 determinístico: o mesmo grupo ou painel mantém o mesmo id entre exportações, e a reimportação atualiza. */
function stableUuid(...parts: string[]) {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return hex.join('');
}

const slug = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const paramsSchema = z.object({
  model: z.enum(MODELS).default('malha'),
  farmId: z.string().regex(uuidPattern).optional(),
  families: z.string().optional(),
});

type PlannedHost = {
  assetId: string; host: string; name: string; farm: string; family: FamilyId; vendor: VendorId | null;
  ip: string; mac: string | null; category: string; model: string | null; templates: string[]; iface: Interface;
};

export type MonitoringPlan = {
  model: Model;
  hosts: PlannedHost[];
  skipped: Array<{ assetId: string; name: string; farm: string; reason: string }>;
  families: Array<{ family: FamilyId; label: string; hosts: number }>;
  templates: string[];
};

export async function planMonitoring(database: Database, user: Principal, params: URLSearchParams): Promise<MonitoringPlan> {
  requirePermission(user, 'monitoring.export');
  const parsed = paramsSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new HttpError(400, 'Parâmetros de monitoramento inválidos.');
  const { model, farmId } = parsed.data;
  if (farmId) requireFarm(user, farmId);
  const wanted = parsed.data.families ? new Set(parsed.data.families.split(',')) : null;
  const farmIds = farmId ? [farmId] : user.farmIds;
  const rows = await database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    if (farmId) {
      const { rows: found } = await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2', [user.orgId, farmId]);
      if (!found.length) throw new HttpError(404, 'Fazenda indisponível.');
    }
    const { rows: assets } = await tx.query<{ id: string; name: string; category: string; model: string | null; ip: string | null; mac: string | null; tag: string | null; farm: string }>(`
      SELECT a.id, a.name, a.category, a.model, a.ip, a.mac, a.tag, f.name AS farm
      FROM assets a JOIN farms f ON f.org_id = a.org_id AND f.id = a.farm_id
      WHERE a.org_id = $1 AND ($2::uuid[] IS NULL OR a.farm_id = ANY($2::uuid[])) AND a.archived_at IS NULL
      ORDER BY f.name, a.name, a.id`, [user.orgId, farmIds]);
    return assets;
  });

  const hosts: PlannedHost[] = [];
  const skipped: MonitoringPlan['skipped'] = [];
  for (const row of rows) {
    const { family, vendor } = classify(row);
    if (wanted && !wanted.has(family)) continue;
    if (!row.ip) {
      skipped.push({ assetId: row.id, name: row.name, farm: row.farm, reason: 'Sem IP no cadastro' });
      continue;
    }
    const { templates, iface } = recipe(family, vendor, model);
    hosts.push({
      assetId: row.id, host: `malha-${slug(row.tag || row.name) || 'ativo'}-${row.id.slice(0, 8)}`, name: `${row.name} · ${row.farm}`,
      farm: row.farm, family, vendor, ip: row.ip, mac: row.mac, category: row.category, model: row.model, templates, iface,
    });
  }
  const families = [...FAMILIES, OTHER_FAMILY].map((item) => ({ family: item.id as FamilyId, label: item.label, hosts: hosts.filter((host) => host.family === item.id).length }))
    .filter((item) => item.hosts > 0);
  return { model, hosts, skipped, families, templates: [...new Set(hosts.flatMap((host) => host.templates))].sort() };
}

const groupName = (label: string) => `Malha/${label}`;

export function zabbixExport(orgId: string, plan: MonitoringPlan) {
  const groups = [...new Set([...plan.hosts.map((host) => `Fazenda: ${host.farm}`), ...plan.hosts.map((host) => familyLabel(host.family))])]
    .map((label) => ({ uuid: stableUuid(orgId, 'group', label), name: groupName(label) }));
  return {
    zabbix_export: {
      version: '7.0',
      host_groups: groups,
      hosts: plan.hosts.map((host) => ({
        host: host.host,
        name: host.name,
        templates: host.templates.map((name) => ({ name })),
        groups: [{ name: groupName(`Fazenda: ${host.farm}`) }, { name: groupName(familyLabel(host.family)) }],
        interfaces: [host.iface === 'snmp'
          ? { type: 'SNMP', ip: host.ip, port: '161', default: 'YES', interface_ref: 'if1', details: { version: 'SNMPV2', community: '{$SNMP_COMMUNITY}' } }
          : { type: 'AGENT', ip: host.ip, port: '10050', default: 'YES', interface_ref: 'if1' }],
        tags: [
          { tag: 'malha.asset', value: host.assetId },
          { tag: 'malha.farm', value: host.farm },
          { tag: 'malha.family', value: host.family },
          ...(host.vendor ? [{ tag: 'malha.vendor', value: host.vendor }] : []),
        ],
        inventory_mode: 'MANUAL',
        inventory: {
          type: host.category.slice(0, 64),
          ...(host.model ? { model: host.model.slice(0, 64) } : {}),
          ...(host.mac ? { macaddress_a: host.mac } : {}),
          location: host.farm.slice(0, 255),
        },
      })),
    },
  };
}

type Panel = { title: string; type: 'stat' | 'timeseries'; item: string; unit?: string };

function panelsFor(family: FamilyId, model: Model): Panel[] {
  const icmp: Panel[] = [
    { title: 'Disponibilidade (ICMP)', type: 'stat', item: 'ICMP: ICMP ping', unit: 'bool_on_off' },
    { title: 'Latência', type: 'timeseries', item: 'ICMP: ICMP response time', unit: 's' },
    { title: 'Perda de pacotes', type: 'timeseries', item: 'ICMP: ICMP loss', unit: 'percent' },
  ];
  if (model === 'base') return icmp;
  if (family === 'core' || family === 'wifi' || family === 'radio') {
    return [...icmp, { title: 'Tráfego por interface', type: 'timeseries', item: '/Interface .*: Bits (received|sent)/', unit: 'bps' },
      { title: 'Erros por interface', type: 'timeseries', item: '/Interface .*: Inbound packets with errors/', unit: 'short' }];
  }
  if (family === 'servers' || family === 'identity' || family === 'endpoints') {
    return [...icmp, { title: 'CPU', type: 'timeseries', item: '/CPU utilization/', unit: 'percent' },
      { title: 'Memória', type: 'timeseries', item: '/Memory utilization/', unit: 'percent' }];
  }
  return icmp;
}

export function grafanaExport(orgId: string, plan: MonitoringPlan) {
  const datasource = { type: 'alexanderzobnin-zabbix-datasource', uid: '${DS_ZABBIX}' };
  return plan.families.map((family) => {
    const panels = panelsFor(family.family, plan.model).map((panel, index) => ({
      id: index + 1,
      type: panel.type,
      title: panel.title,
      datasource,
      gridPos: panel.type === 'stat' ? { x: 0, y: 0, w: 24, h: 5 } : { x: ((index - 1) % 2) * 12, y: 5 + Math.floor((index - 1) / 2) * 8, w: 12, h: 8 },
      fieldConfig: { defaults: { unit: panel.unit ?? 'short' }, overrides: [] },
      options: panel.type === 'stat' ? { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'background' } : { legend: { displayMode: 'table', placement: 'bottom' } },
      targets: [{
        refId: 'A', queryType: '0',
        group: { filter: '$grupo' }, host: { filter: '$host' }, itemTag: { filter: '' }, item: { filter: panel.item },
        functions: [], options: { showDisabledItems: false },
      }],
    }));
    return {
      filename: `malha-grafana-${family.family}.json`,
      dashboard: {
        __inputs: [{ name: 'DS_ZABBIX', label: 'Zabbix', type: 'datasource', pluginId: 'alexanderzobnin-zabbix-datasource', pluginName: 'Zabbix' }],
        __requires: [{ type: 'datasource', id: 'alexanderzobnin-zabbix-datasource', name: 'Zabbix', version: '4.0.0' }],
        uid: stableUuid(orgId, 'grafana', family.family, plan.model).slice(0, 24),
        title: `Malha · ${family.label}${plan.model === 'base' ? ' (modelo base)' : ''}`,
        tags: ['malha', family.family, plan.model],
        timezone: 'browser',
        schemaVersion: 39,
        time: { from: 'now-24h', to: 'now' },
        templating: { list: [
          { name: 'grupo', type: 'constant', query: groupName(family.label), hide: 2 },
          { name: 'host', type: 'query', datasource, query: { queryType: 'host', group: { filter: '$grupo' }, host: { filter: '/.*/' } }, includeAll: true, multi: true,
            current: { text: 'All', value: '$__all' }, refresh: 1, label: 'Ativo' },
        ] },
        panels,
      },
    };
  });
}

export async function recordMonitoringExport(database: Database, user: Principal, target: 'zabbix' | 'grafana', plan: MonitoringPlan) {
  await database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), user.orgId, user.actor, `export.${target}`, JSON.stringify({ model: plan.model, hosts: plan.hosts.length, families: plan.families.map((item) => item.family) })]);
  });
}
