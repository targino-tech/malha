import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireFarm, requirePermission } from './authz';
import { setOrg, type Database, type Queryable } from './db';
import { HttpError, uuidPattern } from './http';
import type { Principal } from './identity';
import { sealSecret } from './ldap';
import { transportFromEnv, type MailTransport } from './notifications';
import {
  composeTest, dashboardLink, deliver, DeliveryError, pushSecret, RULES, scrubError, tokenHint, TOKEN_PURPOSE,
  type ChannelKind, type Fetcher, type PushEvent, type Rule, type Severity,
} from './push';

/**
 * Administração dos canais de notificação (perfis admin e TI).
 * O token do bot nunca volta ao cliente: só a dica mascarada. Um perfil restrito a algumas fazendas só vê
 * e altera canais cujo filtro cabe no seu escopo; os demais respondem como inexistentes.
 */

export type Channel = {
  id: string; kind: ChannelKind; name: string; enabled: boolean; farmIds: string[] | null; rules: Rule[] | null;
  minSeverity: Severity; notifyResolved: boolean; rateLimitPerMinute: number;
  chatId: string | null; tokenHint: string | null; recipients: string[] | null; updatedAt: string;
};

export type Delivery = {
  id: string; channelId: string; channelName: string; kind: ChannelKind; event: PushEvent;
  status: 'pending' | 'sent' | 'suppressed' | 'skipped' | 'failed'; attempts: number;
  farmId: string | null; farmName: string | null; title: string | null; severity: Severity | null;
  createdAt: string; sentAt: string | null; nextAttemptAt: string | null; lastError: string | null;
};

const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const TEST_LIMIT = 5;
/** Limite de canais por grupo (inclui os desativados, que continuam com histórico). */
export const MAX_CHANNELS = 50;

function email(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(normalized)) throw new Error('e-mail inválido');
  return normalized;
}

const uuid = z.string().regex(uuidPattern).transform((value) => value.toLowerCase());
const routing = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  farmIds: z.array(uuid).min(1).max(500).nullable().optional(),
  rules: z.array(z.enum(RULES)).min(1).nullable().optional(),
  minSeverity: z.enum(['critical', 'warning']).optional(),
  notifyResolved: z.boolean().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(120).optional(),
};
const recipients = z.array(z.string().max(254)).min(1).max(50);
const createSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('telegram'), ...routing, botToken: z.string().trim().regex(BOT_TOKEN), chatId: z.string().trim().regex(CHAT_ID) }),
  z.object({ kind: z.literal('email'), ...routing, recipients }),
]);
const updateSchema = z.object({
  ...routing, name: routing.name.optional(),
  botToken: z.string().trim().regex(BOT_TOKEN).optional(), chatId: z.string().trim().regex(CHAT_ID).optional(), recipients: recipients.optional(),
});

type Row = {
  id: string; kind: ChannelKind; name: string; enabled: boolean; farm_ids: string[] | null; rules: Rule[] | null;
  min_severity: Severity; notify_resolved: boolean; rate_limit_per_minute: number; telegram_chat_id: string | null;
  telegram_token: string | null; token_hint: string | null; recipients: string[] | null; updated_at: Date;
};
const columns = `id, kind, name, enabled, farm_ids, rules, min_severity, notify_resolved, rate_limit_per_minute,
  telegram_chat_id, telegram_token, token_hint, recipients, updated_at`;

/** Só campos seguros: o token cifrado fica no servidor. */
function present(row: Row): Channel {
  return {
    id: row.id, kind: row.kind, name: row.name, enabled: row.enabled, farmIds: row.farm_ids, rules: row.rules,
    minSeverity: row.min_severity, notifyResolved: row.notify_resolved, rateLimitPerMinute: row.rate_limit_per_minute,
    chatId: row.telegram_chat_id, tokenHint: row.token_hint, recipients: row.recipients, updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** O canal cabe no escopo quando o usuário vê o grupo todo ou o filtro do canal só tem fazendas dele. */
function inScope(user: Principal, farmIds: string[] | null) {
  return user.farmIds === null || (farmIds !== null && farmIds.every((id) => user.farmIds!.includes(id)));
}

async function audit(tx: Queryable, user: Principal, action: string, scope: object) {
  await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [randomUUID(), user.orgId, user.actor, action, JSON.stringify(scope)]);
}

async function checkFarms(tx: Queryable, user: Principal, farmIds: string[] | null) {
  if (farmIds === null) {
    if (user.farmIds !== null) throw new HttpError(400, 'Escolha as fazendas do canal: o seu perfil não cobre todas as fazendas do grupo.');
    return null;
  }
  const unique = [...new Set(farmIds)];
  for (const id of unique) requireFarm(user, id);
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM farms WHERE org_id = $1 AND id = ANY($2::uuid[])', [user.orgId, unique]);
  if (rows.length !== unique.length) throw new HttpError(404, 'Fazenda indisponível.');
  return unique;
}

function normalizeRecipients(values: string[]) {
  try {
    return [...new Set(values.map((value) => email(value)))];
  } catch {
    throw new HttpError(400, 'Revise os e-mails dos destinatários.');
  }
}

async function loadChannel(tx: Queryable, user: Principal, id: string, lock = false) {
  if (!uuidPattern.test(id)) throw new HttpError(404, 'Canal indisponível.');
  const { rows: [row] } = await tx.query<Row>(`SELECT ${columns} FROM notification_channels WHERE org_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [user.orgId, id.toLowerCase()]);
  if (!row || !inScope(user, row.farm_ids)) throw new HttpError(404, 'Canal indisponível.');
  return row;
}

export async function listChannels(database: Database, user: Principal): Promise<Channel[]> {
  requirePermission(user, 'alerts.manage');
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query<Row>(`SELECT ${columns} FROM notification_channels WHERE org_id = $1 ORDER BY name, id`, [user.orgId]);
    return rows.filter((row) => inScope(user, row.farm_ids)).map(present);
  });
}

export async function createChannel(database: Database, user: Principal, body: unknown): Promise<Channel> {
  requirePermission(user, 'alerts.manage');
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Revise os dados do canal: nome, fazendas, severidade e credenciais.');
  const input = parsed.data;
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    // Trava por grupo para que criações paralelas não passem do limite de canais.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`malha:notification_channels:${user.orgId}`]);
    const { rows: [existing] } = await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM notification_channels WHERE org_id = $1', [user.orgId]);
    if (existing.count >= MAX_CHANNELS) throw new HttpError(409, `O grupo já tem ${MAX_CHANNELS} canais. Desative ou reaproveite um canal existente.`);
    const farmIds = await checkFarms(tx, user, input.farmIds ?? null);
    const id = randomUUID();
    const telegram = input.kind === 'telegram'
      ? { chat: input.chatId, token: sealSecret(input.botToken, pushSecret(), TOKEN_PURPOSE), hint: tokenHint(input.botToken) }
      : { chat: null, token: null, hint: null };
    const list = input.kind === 'email' ? normalizeRecipients(input.recipients) : null;
    const { rows: [row] } = await tx.query<Row>(`INSERT INTO notification_channels (org_id, id, kind, name, enabled, farm_ids, rules, min_severity,
        notify_resolved, rate_limit_per_minute, telegram_chat_id, telegram_token, token_hint, recipients, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) RETURNING ${columns}`,
    [user.orgId, id, input.kind, input.name, input.enabled ?? true, farmIds, input.rules ?? null, input.minSeverity ?? 'critical',
      input.notifyResolved ?? true, input.rateLimitPerMinute ?? 20, telegram.chat, telegram.token, telegram.hint, list, user.actor]);
    await audit(tx, user, 'alerts.channel.create', { channelId: id, kind: input.kind, farmIds, recipients: list?.length ?? null });
    return present(row);
  });
}

export async function updateChannel(database: Database, user: Principal, id: string, body: unknown): Promise<Channel> {
  requirePermission(user, 'alerts.manage');
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Revise os dados do canal: nome, fazendas, severidade e credenciais.');
  const input = parsed.data;
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const current = await loadChannel(tx, user, id, true);
    if (current.kind === 'telegram' && input.recipients) throw new HttpError(400, 'Canal do Telegram não tem lista de e-mails.');
    if (current.kind === 'email' && (input.botToken || input.chatId)) throw new HttpError(400, 'Canal de e-mail não tem bot do Telegram.');
    const farmIds = input.farmIds === undefined ? current.farm_ids : await checkFarms(tx, user, input.farmIds);
    const next = {
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      rules: input.rules === undefined ? current.rules : input.rules,
      minSeverity: input.minSeverity ?? current.min_severity,
      notifyResolved: input.notifyResolved ?? current.notify_resolved,
      rate: input.rateLimitPerMinute ?? current.rate_limit_per_minute,
      chat: input.chatId ?? current.telegram_chat_id,
      token: input.botToken ? sealSecret(input.botToken, pushSecret(), TOKEN_PURPOSE) : current.telegram_token,
      hint: input.botToken ? tokenHint(input.botToken) : current.token_hint,
      recipients: input.recipients ? normalizeRecipients(input.recipients) : current.recipients,
    };
    // Reativar ou ampliar o filtro não deve reenviar ocorrências antigas.
    const reroute = (next.enabled && !current.enabled) || input.farmIds !== undefined || input.rules !== undefined || input.minSeverity !== undefined;
    const { rows: [row] } = await tx.query<Row>(`UPDATE notification_channels SET name = $3, enabled = $4, farm_ids = $5, rules = $6,
        min_severity = $7, notify_resolved = $8, rate_limit_per_minute = $9, telegram_chat_id = $10, telegram_token = $11, token_hint = $12,
        recipients = $13, updated_by = $14, updated_at = now(), active_since = CASE WHEN $15 THEN now() ELSE active_since END
      WHERE org_id = $1 AND id = $2 RETURNING ${columns}`,
    [user.orgId, current.id, next.name, next.enabled, farmIds, next.rules, next.minSeverity, next.notifyResolved, next.rate,
      next.chat, next.token, next.hint, next.recipients, user.actor, reroute]);
    const action = next.enabled !== current.enabled ? (next.enabled ? 'alerts.channel.enable' : 'alerts.channel.disable') : 'alerts.channel.update';
    await audit(tx, user, action, { channelId: current.id, kind: current.kind, farmIds, tokenChanged: Boolean(input.botToken), recipients: next.recipients?.length ?? null });
    return present(row);
  });
}

export type TestDeps = { fetcher?: Fetcher; transport?: MailTransport };

function emailTransport(deps: TestDeps) {
  if (deps.transport) return deps.transport;
  if (!process.env.MALHA_SMTP_URL || !process.env.MALHA_ALERT_FROM) throw new HttpError(503, 'Configure MALHA_SMTP_URL e MALHA_ALERT_FROM para enviar e-mails.');
  return transportFromEnv();
}

/** Envia uma mensagem de teste na hora e registra o resultado no histórico de entregas. */
export async function sendTest(database: Database, user: Principal, id: string, deps: TestDeps = {}) {
  requirePermission(user, 'alerts.manage');
  // A vaga do teste é reservada (linha 'pending') na mesma transação que conta, com o canal travado:
  // chamadas paralelas esperam a anterior e não passam do limite. O worker ignora entregas de teste.
  const deliveryId = randomUUID();
  const channel = await database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const row = await loadChannel(tx, user, id, true);
    const { rows: [recent] } = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM notification_deliveries
      WHERE org_id = $1 AND channel_id = $2 AND event = 'test' AND created_at > now() - interval '10 minutes'`, [user.orgId, row.id]);
    if (recent.count >= TEST_LIMIT) throw new HttpError(429, 'Muitos testes seguidos neste canal. Aguarde alguns minutos.');
    await tx.query(`INSERT INTO notification_deliveries (org_id, id, channel_id, event, idempotency_key, status, attempts, batch_id)
      VALUES ($1, $2, $3, 'test', $4, 'pending', 0, $5)`, [user.orgId, deliveryId, row.id, `test:${row.id}:${deliveryId}`, randomUUID()]);
    return row;
  });
  const transport = channel.kind === 'email' ? emailTransport(deps) : { async send() { /* não usado no Telegram */ } };
  const origin = dashboardLink(process.env.MALHA_PUBLIC_ORIGIN);
  const text = composeTest(channel.kind, channel.name, origin);
  let failure: string | null = null;
  try {
    await deliver(channel, { telegram: text, email: { to: '', subject: '[Malha] Mensagem de teste', text } }, { transport, fetcher: deps.fetcher });
  } catch (error) {
    failure = scrubError(error instanceof DeliveryError ? error.message : 'Falha no envio.');
  }
  await database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    await tx.query(`UPDATE notification_deliveries SET status = $3, attempts = 1, sent_at = CASE WHEN $3 = 'sent' THEN now() END, last_error = $4
      WHERE org_id = $1 AND id = $2`, [user.orgId, deliveryId, failure ? 'failed' : 'sent', failure]);
    await audit(tx, user, 'alerts.channel.test', { channelId: channel.id, kind: channel.kind, result: failure ? 'failed' : 'sent' });
  });
  if (failure) throw new HttpError(502, failure);
  return { status: 'sent' as const };
}

const deliverySchema = z.object({ farmId: uuid.optional(), channelId: uuid.optional(), status: z.enum(['pending', 'sent', 'suppressed', 'skipped', 'failed']).optional() });

/** Histórico das últimas entregas no escopo do usuário (fazendas e canais visíveis). */
export async function listDeliveries(database: Database, user: Principal, params: URLSearchParams): Promise<Delivery[]> {
  requirePermission(user, 'alerts.manage');
  const parsed = deliverySchema.safeParse(Object.fromEntries([...params].filter(([key]) => ['farmId', 'channelId', 'status'].includes(key))));
  if (!parsed.success) throw new HttpError(400, 'Filtro inválido.');
  const { farmId, channelId, status } = parsed.data;
  if (farmId) requireFarm(user, farmId);
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query<{
      id: string; channel_id: string; channel_name: string; kind: ChannelKind; event: PushEvent; status: Delivery['status']; attempts: number;
      farm_id: string | null; farm_name: string | null; title: string | null; severity: Severity | null; created_at: Date; sent_at: Date | null;
      available_at: Date; last_error: string | null;
    }>(`SELECT d.id, d.channel_id, c.name AS channel_name, c.kind, d.event, d.status, d.attempts, d.farm_id, f.name AS farm_name,
        o.title, o.severity, d.created_at, d.sent_at, d.available_at, d.last_error
      FROM notification_deliveries d
      JOIN notification_channels c ON c.org_id = d.org_id AND c.id = d.channel_id
      LEFT JOIN farms f ON f.org_id = d.org_id AND f.id = d.farm_id
      LEFT JOIN occurrences o ON o.org_id = d.org_id AND o.id = d.occurrence_id
      WHERE d.org_id = $1
        AND ($2::uuid[] IS NULL OR (c.farm_ids IS NOT NULL AND c.farm_ids <@ $2::uuid[] AND (d.farm_id IS NULL OR d.farm_id = ANY($2::uuid[]))))
        AND ($3::uuid IS NULL OR d.farm_id = $3) AND ($4::uuid IS NULL OR d.channel_id = $4) AND ($5::text IS NULL OR d.status = $5)
      ORDER BY d.created_at DESC, d.id LIMIT 100`, [user.orgId, user.farmIds, farmId ?? null, channelId ?? null, status ?? null]);
    const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;
    return rows.map((row) => ({
      id: row.id, channelId: row.channel_id, channelName: row.channel_name, kind: row.kind, event: row.event, status: row.status, attempts: row.attempts,
      farmId: row.farm_id, farmName: row.farm_name, title: row.title, severity: row.severity, createdAt: iso(row.created_at)!,
      sentAt: iso(row.sent_at), nextAttemptAt: row.status === 'pending' ? iso(row.available_at) : null, lastError: row.last_error,
    }));
  });
}
