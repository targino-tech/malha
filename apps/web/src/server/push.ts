import { randomUUID } from 'node:crypto';
import { setOrg, type Database, type Queryable } from './db';
import { openSecret } from './ldap';
import { errorName, log } from './log';
import type { AlertEmail, MailTransport } from './notifications';

/**
 * Notificações por canal (Telegram e e-mail) com outbox própria.
 * O roteamento cria uma entrega por ocorrência, canal e evento (chave de idempotência); o envio agrupa
 * por canal, fazenda e evento, respeita o limite por minuto do canal, suprime ativos durante perda de
 * contato do coletor e janelas de manutenção e reenvia falhas com backoff exponencial.
 * Nada aqui registra o token do bot, o corpo da mensagem ou destinatários nos logs.
 */

export const RULES = ['collector_silent', 'capture_stale', 'asset_offline', 'asset_missing'] as const;
export type Rule = (typeof RULES)[number];
export type Severity = 'critical' | 'warning';
export type ChannelKind = 'telegram' | 'email';
export type PushEvent = 'opened' | 'resolved' | 'test';

export const ruleLabels: Record<Rule, string> = {
  collector_silent: 'Coletor sem contato',
  capture_stale: 'Coleta UniFi desatualizada',
  asset_offline: 'Ativo offline',
  asset_missing: 'Divergência de inventário',
};
export const severityLabels: Record<Severity, string> = { critical: 'Crítica', warning: 'Aviso' };

export const MAX_ATTEMPTS = 5;
export const TOKEN_PURPOSE = 'notification-token';
const MAX_ITEMS_PER_MESSAGE = 20;
const TIMEOUT = 10_000;

/** Espera antes da próxima tentativa, dado o número de tentativas já feitas: 30 s, 60 s, 120 s… até 15 min. */
export function backoffSeconds(attempts: number) {
  return Math.min(900, 30 * 2 ** Math.max(0, attempts));
}

export function pushSecret() {
  const secret = process.env.MALHA_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    if (process.env.MALHA_MODE === 'demo') return 'malha-demo-segredo-local-para-tokens-de-teste';
    throw new Error('Configure MALHA_AUTH_SECRET para guardar tokens.');
  }
  return secret;
}

/** Escapa texto para o parse_mode HTML do Telegram (e para atributos entre aspas). */
export function escapeTelegramHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

const singleLine = (value: string) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

/** Remove qualquer coisa com formato de token de bot de textos de erro que vão para o banco. */
export function scrubError(text: string, token?: string) {
  let value = singleLine(text);
  if (token) value = value.replaceAll(token, '[token]');
  return value.replace(/\b\d{5,15}:[A-Za-z0-9_-]{20,}\b/g, '[token]').replace(/\/bot[^/\s]+/g, '/bot[token]').slice(0, 300);
}

export function tokenHint(token: string) {
  return `••••${token.slice(-4)}`;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetcher: Fetcher = (url, init) => fetch(url, { ...init, cache: 'no-store' });

export class DeliveryError extends Error {
  constructor(message: string, public retryAfterSeconds?: number, public permanent = false) { super(message); this.name = 'DeliveryError'; }
}

/** Host fixo da Bot API: nenhum dado do cadastro ou do ambiente muda o destino do token. */
export const TELEGRAM_API = 'https://api.telegram.org';

/** Link do painel a partir de MALHA_PUBLIC_ORIGIN; só http(s) sem credenciais, senão a mensagem sai sem link. */
export function dashboardLink(origin?: string) {
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
    return url.origin + '/';
  } catch {
    return undefined;
  }
}

/** Envia pela Bot API (sendMessage). Erros 4xx que não mudam com o tempo não são repetidos. */
export async function sendTelegram(fetcher: Fetcher, token: string, chatId: string, text: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await fetcher(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    });
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError('Sem resposta da API do Telegram.');
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } } | null;
  if (response.ok && payload?.ok !== false) return;
  const detail = scrubError(`Telegram recusou o envio (HTTP ${response.status})${payload?.description ? `: ${payload.description}` : ''}.`, token);
  if (response.status === 429) throw new DeliveryError(detail, Math.min(3600, Math.max(1, Number(payload?.parameters?.retry_after) || 30)));
  throw new DeliveryError(detail, undefined, [400, 401, 403, 404].includes(response.status));
}

export type MessageItem = {
  farm_name: string; timezone: string; rule: Rule; resource_kind: 'collector' | 'asset'; severity: Severity;
  title: string; asset_name: string | null; opened_at: Date; resolved_at: Date | null;
};

function formatter(timezone: string) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });
}

const resourceOf = (item: MessageItem) => item.resource_kind === 'asset' ? (item.asset_name ?? 'Ativo') : 'Coletor da fazenda';

function heading(event: Exclude<PushEvent, 'test'>, items: MessageItem[]) {
  const critical = items.some((item) => item.severity === 'critical');
  if (event === 'resolved') return items.length === 1 ? 'Ocorrência encerrada' : `${items.length} ocorrências encerradas`;
  const kind = critical ? 'crítica' : 'de aviso';
  return items.length === 1 ? `Ocorrência ${kind} aberta` : `${items.length} ocorrências abertas`;
}

/** Mensagem do Telegram em HTML, com fazenda, ativo, severidade, horário no fuso da fazenda e link para o painel. */
export function composeTelegram(event: Exclude<PushEvent, 'test'>, items: MessageItem[], origin?: string) {
  const time = formatter(items[0].timezone);
  const e = (value: string) => escapeTelegramHtml(singleLine(value));
  const lines = [`<b>Malha · ${e(heading(event, items))}</b>`, `Fazenda: <b>${e(items[0].farm_name)}</b>`, ''];
  for (const item of items) {
    const when = event === 'resolved' && item.resolved_at ? `encerrada em ${time.format(new Date(item.resolved_at))}` : `aberta em ${time.format(new Date(item.opened_at))}`;
    lines.push(`• <b>${e(severityLabels[item.severity])}</b> · ${e(resourceOf(item))}`, `  ${e(item.title)} (${when})`);
  }
  if (origin) lines.push('', `<a href="${escapeTelegramHtml(origin)}">Abrir no painel do Malha</a>`);
  return lines.join('\n').slice(0, 4000);
}

export function composeChannelEmail(event: Exclude<PushEvent, 'test'>, recipients: string[], items: MessageItem[], origin?: string): AlertEmail {
  const farm = singleLine(items[0].farm_name);
  const time = formatter(items[0].timezone);
  const subject = items.length === 1
    ? `[Malha] ${farm}: ${event === 'resolved' ? 'encerrada: ' : ''}${singleLine(items[0].title)}`
    : `[Malha] ${farm}: ${heading(event, items).toLowerCase()}`;
  const lines = items.map((item) => {
    const when = event === 'resolved' && item.resolved_at ? `encerrada em ${time.format(new Date(item.resolved_at))}` : `aberta em ${time.format(new Date(item.opened_at))}`;
    return `- [${severityLabels[item.severity]}] ${singleLine(resourceOf(item))}: ${singleLine(item.title)} (${when})`;
  });
  return {
    to: recipients.join(', '),
    subject: subject.slice(0, 200),
    text: [`${heading(event, items)} na ${farm}:`, '', ...lines, '',
      origin ? `Acompanhe e reconheça no painel: ${origin}` : 'Acompanhe e reconheça no painel do Malha.',
      '', 'Mensagem automática do Malha. O histórico completo fica no aplicativo.'].join('\n'),
  };
}

export function composeTest(kind: ChannelKind, name: string, origin?: string) {
  const text = `Teste do Malha: o canal "${singleLine(name)}" está configurado. Os alertas do grupo chegam aqui.`;
  if (kind === 'telegram') {
    return `<b>Malha · Mensagem de teste</b>\n${escapeTelegramHtml(text)}${origin ? `\n\n<a href="${escapeTelegramHtml(origin)}">Abrir no painel do Malha</a>` : ''}`;
  }
  return text + (origin ? `\n\nPainel: ${origin}` : '');
}

export type Deps = { transport: MailTransport; fetcher?: Fetcher; origin?: string };

/** Entrega já resolvida: abre o token e envia pelo canal. Usado pelo worker e pelo botão de teste. */
export async function deliver(channel: { kind: ChannelKind; telegram_chat_id: string | null; telegram_token: string | null; recipients: string[] | null },
  message: { telegram: string; email: AlertEmail }, deps: Deps) {
  if (channel.kind === 'telegram') {
    let token: string;
    try {
      token = openSecret(channel.telegram_token ?? '', pushSecret(), TOKEN_PURPOSE);
    } catch {
      throw new DeliveryError('Token do bot ilegível: cadastre o token de novo.', undefined, true);
    }
    await sendTelegram(deps.fetcher ?? defaultFetcher, token, channel.telegram_chat_id ?? '', message.telegram);
    return;
  }
  try {
    await deps.transport.send({ ...message.email, to: (channel.recipients ?? []).join(', ') });
  } catch (error) {
    throw new DeliveryError(`Falha no envio de e-mail (${errorName(error)}).`);
  }
}

/** Cria as entregas que faltam para aberturas e encerramentos recentes. Requer `setOrg` na transação. */
export async function routeOrganization(tx: Queryable, orgId: string) {
  // Aberturas: canais ativos cujo filtro de fazenda, regra e severidade inclui a ocorrência.
  const { rows: opened } = await tx.query(`INSERT INTO notification_deliveries (org_id, id, channel_id, occurrence_id, farm_id, event, idempotency_key)
    SELECT $1, gen_random_uuid(), c.id, o.id, o.farm_id, 'opened', o.id || ':' || c.id || ':opened'
    FROM occurrence_events e
    JOIN occurrences o ON o.org_id = e.org_id AND o.id = e.occurrence_id
    JOIN notification_channels c ON c.org_id = o.org_id AND c.enabled
    WHERE e.org_id = $1 AND e.kind = 'opened' AND e.occurred_at > now() - interval '24 hours' AND e.occurred_at >= c.active_since
      AND (c.farm_ids IS NULL OR o.farm_id = ANY(c.farm_ids))
      AND (c.rules IS NULL OR o.rule = ANY(c.rules))
      AND (c.min_severity = 'warning' OR o.severity = 'critical')
    ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id`, [orgId]);
  // Encerramentos: só para quem recebeu a abertura, para não anunciar o fim do que nunca foi avisado.
  const { rows: resolved } = await tx.query(`INSERT INTO notification_deliveries (org_id, id, channel_id, occurrence_id, farm_id, event, idempotency_key)
    SELECT $1, gen_random_uuid(), c.id, o.id, o.farm_id, 'resolved', o.id || ':' || c.id || ':resolved'
    FROM occurrence_events e
    JOIN occurrences o ON o.org_id = e.org_id AND o.id = e.occurrence_id
    JOIN notification_deliveries d ON d.org_id = o.org_id AND d.occurrence_id = o.id AND d.event = 'opened' AND d.status = 'sent'
    JOIN notification_channels c ON c.org_id = d.org_id AND c.id = d.channel_id AND c.enabled AND c.notify_resolved
    WHERE e.org_id = $1 AND e.kind = 'resolved' AND e.occurred_at > now() - interval '24 hours'
      AND (c.farm_ids IS NULL OR o.farm_id = ANY(c.farm_ids))
    ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id`, [orgId]);
  return opened.length + resolved.length;
}

type Pending = MessageItem & {
  id: string; channel_id: string; farm_id: string; event: 'opened' | 'resolved'; attempts: number;
  kind: ChannelKind; enabled: boolean; telegram_chat_id: string | null; telegram_token: string | null; recipients: string[] | null;
  rate_limit_per_minute: number; sent_last_minute: number; suppressed: boolean; out_of_scope: boolean;
};

export type DispatchResult = { routed: number; sent: number; failed: number; suppressed: number; skipped: number; deferred: number };

async function deliverOrganization(tx: Queryable, orgId: string, deps: Deps, result: DispatchResult) {
  // Mesmas regras de supressão do e-mail legado: ativo em manutenção ou fazenda com coletor sem contato aberto.
  const { rows } = await tx.query<Pending>(`SELECT d.id, d.channel_id, d.farm_id, d.event, d.attempts,
      c.kind, c.enabled, c.telegram_chat_id, c.telegram_token, c.recipients, c.rate_limit_per_minute,
      (c.farm_ids IS NOT NULL AND NOT (d.farm_id = ANY(c.farm_ids))) AS out_of_scope,
      (SELECT count(DISTINCT s.batch_id)::int FROM notification_deliveries s WHERE s.org_id = d.org_id AND s.channel_id = d.channel_id
        AND s.sent_at > now() - interval '1 minute') AS sent_last_minute,
      f.name AS farm_name, f.timezone, o.rule, o.resource_kind, o.severity, o.title, o.opened_at, o.resolved_at, a.name AS asset_name,
      (d.event = 'opened' AND o.resource_kind = 'asset' AND (EXISTS (SELECT 1 FROM occurrences s WHERE s.org_id = o.org_id AND s.farm_id = o.farm_id
          AND s.rule = 'collector_silent' AND s.resolved_at IS NULL)
        OR COALESCE(a.maintenance_until > now(), false))) AS suppressed
    FROM notification_deliveries d
    JOIN notification_channels c ON c.org_id = d.org_id AND c.id = d.channel_id
    JOIN occurrences o ON o.org_id = d.org_id AND o.id = d.occurrence_id
    JOIN farms f ON f.org_id = o.org_id AND f.id = o.farm_id
    LEFT JOIN assets a ON o.resource_kind = 'asset' AND a.org_id = o.org_id AND a.farm_id = o.farm_id AND a.id = o.resource_id
    WHERE d.org_id = $1 AND d.status = 'pending' AND d.available_at <= now() AND d.event <> 'test'
    ORDER BY d.channel_id, d.farm_id, d.event, o.opened_at
    LIMIT 200 FOR UPDATE OF d SKIP LOCKED`, [orgId]);

  const setStatus = (ids: string[], status: string) => tx.query(`UPDATE notification_deliveries SET status = $3 WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, ids, status]);
  // O filtro de fazendas é relido no envio: um canal estreitado (e talvez com outro chat) não recebe o que saiu do filtro.
  const skipped = rows.filter((row) => !row.enabled || row.out_of_scope || (row.event === 'opened' && row.resolved_at));
  const suppressed = rows.filter((row) => !skipped.includes(row) && row.suppressed);
  if (skipped.length) await setStatus(skipped.map((row) => row.id), 'skipped');
  if (suppressed.length) await setStatus(suppressed.map((row) => row.id), 'suppressed');
  result.skipped += skipped.length;
  result.suppressed += suppressed.length;

  const groups = new Map<string, Pending[]>();
  for (const row of rows) {
    if (skipped.includes(row) || suppressed.includes(row)) continue;
    const key = `${row.channel_id}\n${row.farm_id}\n${row.event}`;
    const group = groups.get(key) ?? [];
    if (group.length >= MAX_ITEMS_PER_MESSAGE) groups.set(`${key}\n${row.id}`, [row]);
    else groups.set(key, [...group, row]);
  }

  const sentInWindow = new Map<string, number>();
  for (const items of groups.values()) {
    const head = items[0];
    const ids = items.map((item) => item.id);
    const used = sentInWindow.get(head.channel_id) ?? head.sent_last_minute;
    if (used >= head.rate_limit_per_minute) {
      // Limite do canal: adia sem contar tentativa.
      await tx.query(`UPDATE notification_deliveries SET available_at = now() + interval '60 seconds' WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, ids]);
      result.deferred += ids.length;
      continue;
    }
    sentInWindow.set(head.channel_id, used + 1);
    try {
      await deliver(head, {
        telegram: composeTelegram(head.event, items, deps.origin),
        email: composeChannelEmail(head.event, head.recipients ?? [], items, deps.origin),
      }, deps);
      await tx.query(`UPDATE notification_deliveries SET status = 'sent', sent_at = now(), batch_id = $3, attempts = attempts + 1, last_error = NULL
        WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, ids, randomUUID()]);
      result.sent += ids.length;
    } catch (error) {
      const failure = error instanceof DeliveryError ? error : new DeliveryError(`Falha no envio (${errorName(error)}).`);
      const attempts = head.attempts + 1;
      const final = failure.permanent || attempts >= MAX_ATTEMPTS;
      const wait = failure.retryAfterSeconds ?? backoffSeconds(head.attempts);
      await tx.query(`UPDATE notification_deliveries SET attempts = attempts + 1, last_error = $3,
          status = CASE WHEN $4 THEN 'failed' ELSE 'pending' END,
          available_at = now() + make_interval(secs => $5)
        WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, ids, scrubError(failure.message), final, wait]);
      if (final) result.failed += ids.length;
      log.error('Falha ao enviar notificação de canal', { error: errorName(error), kind: head.kind, final });
    }
  }
}

/** Roteia e envia as notificações de canais de todas as organizações. */
export async function dispatchChannelNotifications(database: Database, deps: Deps): Promise<DispatchResult> {
  const result: DispatchResult = { routed: 0, sent: 0, failed: 0, suppressed: 0, skipped: 0, deferred: 0 };
  const origin = dashboardLink(deps.origin ?? process.env.MALHA_PUBLIC_ORIGIN);
  const { rows: organizations } = await database.query<{ id: string }>('SELECT id FROM organizations ORDER BY id');
  for (const { id } of organizations) {
    result.routed += await database.transaction(async (tx) => {
      await setOrg(tx, id);
      return routeOrganization(tx, id);
    });
    await database.transaction(async (tx) => {
      await setOrg(tx, id);
      await deliverOrganization(tx, id, { ...deps, origin }, result);
    });
  }
  return result;
}
