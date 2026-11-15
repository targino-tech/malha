import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { requirePermission } from './authz';
import { setOrg, type Database } from './db';
import { HttpError } from './http';
import type { Principal } from './identity';
import { openSecret, sealSecret } from './ldap';
import { grafanaExport, planMonitoring, zabbixExport } from './monitoring';

/**
 * Aplica o monitoramento direto no Zabbix e no Grafana do grupo.
 * O servidor do Malha faz as chamadas, então a URL passa por uma checagem: só HTTPS e nunca endereços
 * de loopback, link-local ou metadados de nuvem. Redes privadas (10/8, 172.16/12, 192.168/16) são
 * permitidas porque Zabbix e Grafana costumam ficar na rede interna da empresa.
 */

export type Kind = 'zabbix' | 'grafana';
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type Resolver = (host: string) => Promise<string[]>;

const PURPOSE = 'monitoring-token';
const TIMEOUT = 15_000;

const defaultFetcher: Fetcher = (url, init) => fetch(url, { ...init, redirect: 'error', cache: 'no-store' });
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);

function blocked(address: string): boolean {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value === '::1' || value === '::' || value.startsWith('fe80:') || value.startsWith('fd00:ec2')) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? blocked(mapped[1]) : false;
  }
  const [a, b] = address.split('.').map(Number);
  return a === 127 || a === 0 || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function safeEndpoint(raw: string, resolve: Resolver = defaultResolver) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'URL inválida.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(400, 'Use uma URL https:// sem usuário e senha.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => { throw new HttpError(400, 'Não foi possível resolver o endereço.'); });
  if (!addresses.length || addresses.some(blocked)) throw new HttpError(400, 'Endereço não permitido para integração.');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

const connectionSchema = z.object({
  kind: z.enum(['zabbix', 'grafana']),
  url: z.string().trim().max(300),
  token: z.string().trim().min(8).max(4096),
});

function secretKey() {
  const secret = process.env.MALHA_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    if (process.env.MALHA_MODE === 'demo') return 'malha-demo-segredo-local-para-tokens-de-teste';
    throw new HttpError(503, 'Configure MALHA_AUTH_SECRET para guardar tokens.');
  }
  return secret;
}

async function audit(database: Database, user: Principal, action: string, scope: object) {
  await database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), user.orgId, user.actor, action, JSON.stringify(scope)]);
  });
}

export async function listConnections(database: Database, user: Principal) {
  requirePermission(user, 'monitoring.apply');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query<{ kind: Kind; url: string; updated_at: Date; last_result: unknown }>(
      'SELECT kind, url, updated_at, last_result FROM monitoring_connections WHERE org_id = $1 ORDER BY kind', [user.orgId]);
    // O token nunca sai do servidor.
    return rows.map((row) => ({ kind: row.kind, url: row.url, updatedAt: new Date(row.updated_at).toISOString(), lastResult: row.last_result }));
  });
}

export async function saveConnection(database: Database, user: Principal, body: unknown, resolve?: Resolver) {
  requirePermission(user, 'monitoring.apply');
  const parsed = connectionSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Informe a URL https:// e o token da integração.');
  const url = await safeEndpoint(parsed.data.url, resolve);
  await database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    await tx.query(`INSERT INTO monitoring_connections (org_id, kind, url, token, updated_by) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (org_id, kind) DO UPDATE SET url = excluded.url, token = excluded.token, updated_by = excluded.updated_by, updated_at = now(), last_result = NULL`,
    [user.orgId, parsed.data.kind, url, sealSecret(parsed.data.token, secretKey(), PURPOSE), user.actor]);
  });
  await audit(database, user, `monitoring.connection.${parsed.data.kind}`, { url });
  return { kind: parsed.data.kind, url };
}

export async function removeConnection(database: Database, user: Principal, kind: Kind) {
  requirePermission(user, 'monitoring.apply');
  await database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    await tx.query('DELETE FROM monitoring_connections WHERE org_id = $1 AND kind = $2', [user.orgId, kind]);
  });
  await audit(database, user, `monitoring.connection.${kind}.remove`, {});
}

async function connection(database: Database, user: Principal, kind: Kind) {
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows: [row] } = await tx.query<{ url: string; token: string }>('SELECT url, token FROM monitoring_connections WHERE org_id = $1 AND kind = $2', [user.orgId, kind]);
    if (!row) throw new HttpError(404, `Cadastre a conexão com o ${kind === 'zabbix' ? 'Zabbix' : 'Grafana'} primeiro.`);
    return { url: row.url, token: openSecret(row.token, secretKey(), PURPOSE) };
  });
}

async function saveResult(database: Database, user: Principal, kind: Kind, result: object) {
  await database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    await tx.query('UPDATE monitoring_connections SET last_result = $3::jsonb WHERE org_id = $1 AND kind = $2',
      [user.orgId, kind, JSON.stringify({ ...result, at: new Date().toISOString() })]);
  });
}

async function call(fetcher: Fetcher, url: string, token: string, method: string, body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetcher(url, {
      method, signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  } catch {
    throw new HttpError(502, 'Sem resposta do servidor de monitoramento. Confira a URL e se o Malha alcança essa rede.');
  } finally {
    clearTimeout(timer);
  }
}

async function zabbixRpc(fetcher: Fetcher, base: string, token: string, method: string, params: unknown) {
  const { ok, payload } = await call(fetcher, `${base}/api_jsonrpc.php`, token, 'POST', { jsonrpc: '2.0', method, params, id: 1 });
  const data = payload as { result?: unknown; error?: { message?: string; data?: string } } | null;
  if (!ok || !data || data.error) throw new HttpError(502, `Zabbix recusou ${method}: ${data?.error?.data ?? data?.error?.message ?? 'resposta inválida'}.`);
  return data.result;
}

export async function applyZabbix(database: Database, user: Principal, params: URLSearchParams, fetcher: Fetcher = defaultFetcher, resolve?: Resolver) {
  requirePermission(user, 'monitoring.apply');
  const { url, token } = await connection(database, user, 'zabbix');
  await safeEndpoint(url, resolve);
  const plan = await planMonitoring(database, user, params);
  if (!plan.hosts.length) throw new HttpError(400, 'Nenhum ativo com IP para enviar.');
  // Templates ausentes fariam o import inteiro falhar: os hosts afetados caem para ICMP Ping, que vem em toda instalação.
  const found = await zabbixRpc(fetcher, url, token, 'template.get', { output: ['host', 'name'], filter: { host: plan.templates } }) as Array<{ host: string }>;
  const available = new Set(found.map((template) => template.host));
  const missing = plan.templates.filter((name) => !available.has(name));
  const adjusted = { ...plan, hosts: plan.hosts.map((host) => ({ ...host, templates: host.templates.filter((name) => available.has(name)) })) };
  const source = JSON.stringify(zabbixExport(user.orgId, adjusted));
  await zabbixRpc(fetcher, url, token, 'configuration.import', {
    format: 'json', source,
    rules: {
      host_groups: { createMissing: true, updateExisting: true },
      hosts: { createMissing: true, updateExisting: true },
      templateLinkage: { createMissing: true },
    },
  });
  const result = { hosts: adjusted.hosts.length, model: plan.model, missingTemplates: missing };
  await saveResult(database, user, 'zabbix', result);
  await audit(database, user, 'monitoring.apply.zabbix', result);
  return result;
}

export async function applyGrafana(database: Database, user: Principal, params: URLSearchParams, fetcher: Fetcher = defaultFetcher, resolve?: Resolver) {
  requirePermission(user, 'monitoring.apply');
  const { url, token } = await connection(database, user, 'grafana');
  await safeEndpoint(url, resolve);
  const plan = await planMonitoring(database, user, params);
  if (!plan.families.length) throw new HttpError(400, 'Nenhum ativo com IP para montar painéis.');
  const sources = await call(fetcher, `${url}/api/datasources`, token, 'GET');
  if (!sources.ok) throw new HttpError(502, `Grafana recusou o token (HTTP ${sources.status}).`);
  const zabbix = (sources.payload as Array<{ uid: string; type: string; name: string }> | null)?.find((item) => item.type === 'alexanderzobnin-zabbix-datasource');
  if (!zabbix) throw new HttpError(400, 'Instale o plugin Zabbix no Grafana e crie a fonte de dados antes de aplicar.');
  const folder = await call(fetcher, `${url}/api/folders/malha`, token, 'GET');
  if (folder.status === 404) {
    const created = await call(fetcher, `${url}/api/folders`, token, 'POST', { uid: 'malha', title: 'Malha' });
    if (!created.ok) throw new HttpError(502, `Grafana não criou a pasta Malha (HTTP ${created.status}).`);
  }
  const published: string[] = [];
  for (const file of grafanaExport(user.orgId, plan)) {
    // A API recebe o painel já ligado à fonte de dados real, sem os campos de importação manual.
    const dashboard: Record<string, unknown> = JSON.parse(JSON.stringify(file.dashboard).replaceAll('${DS_ZABBIX}', zabbix.uid));
    delete dashboard.__inputs;
    delete dashboard.__requires;
    const body = dashboard;
    const saved = await call(fetcher, `${url}/api/dashboards/db`, token, 'POST', { dashboard: body, folderUid: 'malha', overwrite: true, message: 'Atualizado pelo Malha' });
    if (!saved.ok) throw new HttpError(502, `Grafana recusou o painel ${String(dashboard.title)} (HTTP ${saved.status}).`);
    published.push(String(dashboard.title));
  }
  const result = { dashboards: published.length, model: plan.model, datasource: zabbix.name };
  await saveResult(database, user, 'grafana', result);
  await audit(database, user, 'monitoring.apply.grafana', result);
  return result;
}
