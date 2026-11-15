import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createChannel, listChannels, listDeliveries, sendTest, updateChannel } from '../apps/web/src/server/alert-channels';
import { evaluateAll } from '../apps/web/src/server/alerts';
import { can } from '../apps/web/src/server/authz';
import { migrate, pgliteDatabase, setOrg, type Database } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import type { AlertEmail } from '../apps/web/src/server/notifications';
import {
  backoffSeconds, composeTelegram, dashboardLink, dispatchChannelNotifications, escapeTelegramHtml, MAX_ATTEMPTS, scrubError, TELEGRAM_API,
  type Fetcher, type MessageItem,
} from '../apps/web/src/server/push';

process.env.MALHA_AUTH_SECRET = 'segredo-de-teste-com-mais-de-32-bytes-aqui';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const ORIGIN = 'https://app.example';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;

type Call = { url: string; chatId: string; text: string };
/** Simula a Bot API do Telegram: grava as chamadas e responde conforme `reply`. */
function telegram(reply: (call: Call) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, result: {} } })) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const body = JSON.parse(init.body) as { chat_id: string; text: string; parse_mode: string };
    assert.equal(body.parse_mode, 'HTML');
    assert.equal(init.redirect, 'error');
    const call = { url, chatId: body.chat_id, text: body.text };
    calls.push(call);
    const answer = reply(call);
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  return { calls, fetcher };
}

function mailbox() {
  const sent: AlertEmail[] = [];
  return { sent, transport: { async send(message: AlertEmail) { sent.push(message); } } };
}

type Fixture = { orgId: string; farmId: string; otherFarmId: string; collectorId: string; admin: Principal };

async function fixture(options: { heartbeatAgo?: string; farmName?: string } = {}): Promise<Fixture> {
  const orgId = randomUUID();
  const farmId = randomUUID();
  const otherFarmId = randomUUID();
  const collectorId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo push']);
    await setOrg(tx, orgId);
    await tx.query(`INSERT INTO farms (org_id, id, name, location) VALUES ($1, $2, $3, 'MT'), ($1, $4, 'Fazenda Vizinha', 'MT')`,
      [orgId, farmId, options.farmName ?? 'Fazenda Boa Vista', otherFarmId]);
    await tx.query('INSERT INTO collector_keys (org_id, farm_id, key_id, collector_id, public_key) VALUES ($1, $2, $3, $4, $5)',
      [orgId, farmId, randomUUID(), collectorId, '{}']);
    await tx.query(`INSERT INTO collector_health (org_id, farm_id, collector_id, last_heartbeat_at, last_capture_at)
      VALUES ($1, $2, $3, now() - $4::interval, now() - interval '1 minute')`, [orgId, farmId, collectorId, options.heartbeatAgo ?? '10 seconds']);
  });
  return { orgId, farmId, otherFarmId, collectorId, admin: { orgId, actor: `admin-${orgId}`, role: 'admin', farmIds: null, demo: false } };
}

async function asset(f: Fixture, values: { name: string; critical?: boolean; status?: string; maintenance?: boolean }) {
  const id = randomUUID();
  await run(f, `INSERT INTO assets (org_id, farm_id, id, name, category, critical, source, external_id, status,
      last_observed_at, last_collector_id, missing_captures, maintenance_until)
    VALUES ($1, $2, $3, $4, 'Switch', $5, 'unifi', $6, $7, now() - interval '1 minute', $8, 0, CASE WHEN $9 THEN now() + interval '2 hours' END)`,
  [f.orgId, f.farmId, id, values.name, values.critical ?? false, randomUUID(), values.status ?? 'online', f.collectorId, values.maintenance ?? false]);
  return id;
}

async function run(f: { orgId: string }, sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await setOrg(tx, f.orgId);
    return (await tx.query<Record<string, unknown>>(sql, params)).rows;
  });
}

const deliveries = (f: Fixture) => run(f, `SELECT d.event, d.status, d.attempts, d.last_error, o.rule, o.severity,
    extract(epoch FROM d.available_at - now())::int AS wait
  FROM notification_deliveries d LEFT JOIN occurrences o ON o.org_id = d.org_id AND o.id = d.occurrence_id
  WHERE d.org_id = $1 ORDER BY d.created_at, o.rule`, [f.orgId]);

/** Libera as entregas pendentes para a próxima rodada, como se o backoff tivesse passado. */
const releasePending = (f: Fixture) => run(f, `UPDATE notification_deliveries SET available_at = now() WHERE org_id = $1 AND status = 'pending'`, [f.orgId]);

test('escapa HTML do Telegram, valida o link do painel e calcula o backoff', () => {
  assert.equal(escapeTelegramHtml('<b>Core & "AP"</b>'), '&lt;b&gt;Core &amp; &quot;AP&quot;&lt;/b&gt;');
  assert.equal(dashboardLink('https://app.example/qualquer?x=1'), 'https://app.example/');
  assert.equal(dashboardLink('javascript:alert(1)'), undefined);
  assert.equal(dashboardLink('https://user:senha@app.example'), undefined);
  assert.equal(dashboardLink('não é url'), undefined);
  assert.deepEqual([0, 1, 2, 3, 10].map(backoffSeconds), [30, 60, 120, 240, 900]);
  assert.equal(scrubError(`falha em https://api.telegram.org/bot${TOKEN}/sendMessage`).includes(TOKEN), false);
  assert.equal(scrubError(`token ${TOKEN} recusado`), 'token [token] recusado');

  const item: MessageItem = {
    farm_name: 'Fazenda <Alta>', timezone: 'America/Cuiaba', rule: 'asset_offline', resource_kind: 'asset', severity: 'critical',
    title: 'Ativo offline: Core & "Rack"', asset_name: 'Core <script>', opened_at: new Date('2026-11-15T12:00:00Z'), resolved_at: null,
  };
  const text = composeTelegram('opened', [item], 'https://app.example/');
  assert.match(text, /Fazenda: <b>Fazenda &lt;Alta&gt;<\/b>/);
  assert.match(text, /Core &lt;script&gt;/);
  assert.match(text, /Core &amp; &quot;Rack&quot;/);
  assert.match(text, /15\/11\/2026, 08:00/);
  assert.match(text, /<a href="https:\/\/app.example\/">Abrir no painel do Malha<\/a>/);
  assert.ok(!text.includes('<script>'));
});

test('só admin e TI gerenciam canais', async () => {
  const f = await fixture();
  for (const role of ['tecnico', 'diretoria', 'auditor'] as const) {
    const user: Principal = { ...f.admin, role };
    assert.equal(can(user, 'alerts.manage'), false);
    await assert.rejects(listChannels(db, user), status(403));
    await assert.rejects(createChannel(db, user, { kind: 'email', name: 'X', recipients: ['a@example.com'] }), status(403));
    await assert.rejects(listDeliveries(db, user, new URLSearchParams()), status(403));
  }
  const ti: Principal = { ...f.admin, role: 'ti', actor: 'oid-ti' };
  const channel = await createChannel(db, ti, { kind: 'email', name: 'TI', recipients: ['TI@Example.com', 'ti@example.com'] });
  assert.deepEqual(channel.recipients, ['ti@example.com']);
  await assert.rejects(updateChannel(db, { ...ti, role: 'tecnico' }, channel.id, { enabled: false }), status(403));
  await assert.rejects(sendTest(db, { ...ti, role: 'diretoria' }, channel.id), status(403));
  await assert.rejects(createChannel(db, ti, { kind: 'email', name: 'X', recipients: ['sem-arroba'] }), status(400));
  await assert.rejects(createChannel(db, ti, { kind: 'telegram', name: 'X', botToken: 'curto', chatId: '-100' }), status(400));
});

test('o token do bot fica cifrado e nunca volta na API, na auditoria ou nos erros', async () => {
  const f = await fixture();
  const created = await createChannel(db, f.admin, { kind: 'telegram', name: 'Plantão TI', botToken: TOKEN, chatId: '-1001234567890' });
  assert.equal(created.tokenHint, '••••sawQ');
  const listed = await listChannels(db, f.admin);
  assert.ok(!JSON.stringify([created, listed]).includes(TOKEN));
  assert.ok(!JSON.stringify([created, listed]).includes('AAHdq'));
  const [stored] = await run(f, 'SELECT telegram_token FROM notification_channels WHERE org_id = $1', [f.orgId]);
  assert.ok(!String(stored.telegram_token).includes(TOKEN));
  assert.ok(String(stored.telegram_token).length > 20);

  const newToken = '987654321:ZZHdqTcvCH1vGWJxfSeofSAs0K5PALDzzzz';
  const updated = await updateChannel(db, f.admin, created.id, { botToken: newToken, name: 'Plantão' });
  assert.equal(updated.tokenHint, '••••zzzz');
  const audits = await run(f, `SELECT action, scope::text AS scope FROM audit_log WHERE org_id = $1 AND action LIKE 'alerts.%' ORDER BY occurred_at`, [f.orgId]);
  assert.deepEqual(audits.map((row) => row.action), ['alerts.channel.create', 'alerts.channel.update']);
  assert.ok(audits.every((row) => !String(row.scope).includes(TOKEN) && !String(row.scope).includes(newToken)));

  // A Bot API devolve um erro que ecoa o token: ele não chega ao banco nem à resposta.
  const { calls, fetcher } = telegram((call) => ({ status: 401, body: { ok: false, description: `Unauthorized ${call.url}` } }));
  const failure = await sendTest(db, f.admin, created.id, { fetcher }).catch((error: unknown) => error);
  assert.ok(failure instanceof HttpError && failure.status === 502);
  assert.ok(!failure.message.includes(newToken));
  assert.equal(calls[0].url, `${TELEGRAM_API}/bot${newToken}/sendMessage`);
  const [logged] = await run(f, `SELECT last_error FROM notification_deliveries WHERE org_id = $1 AND event = 'test'`, [f.orgId]);
  assert.ok(!String(logged.last_error).includes(newToken));
  assert.match(String(logged.last_error), /HTTP 401/);
});

test('roteia por fazenda, regra e severidade, deduplica e avisa o encerramento', async () => {
  const f = await fixture({ farmName: 'Fazenda <Boa> & Vista' });
  const { calls, fetcher } = telegram();
  const mail = mailbox();
  const critical = await createChannel(db, f.admin, { kind: 'telegram', name: 'Críticos', botToken: TOKEN, chatId: `-100${Date.now()}`, farmIds: [f.farmId] });
  await createChannel(db, f.admin, { kind: 'telegram', name: 'Só a vizinha', botToken: TOKEN, chatId: '@outra_fazenda', farmIds: [f.otherFarmId], minSeverity: 'warning' });
  const warnings = await createChannel(db, f.admin, { kind: 'email', name: 'Avisos', recipients: ['noc@example.com'], minSeverity: 'warning', rules: ['asset_offline'], notifyResolved: false });
  const core = await asset(f, { name: 'Core <rack 1>', critical: true, status: 'offline' });
  await asset(f, { name: 'AP do pátio', status: 'offline' });
  await evaluateAll(db);

  const first = await dispatchChannelNotifications(db, { transport: mail.transport, fetcher, origin: ORIGIN });
  assert.ok(first.sent >= 3);
  const mine = calls.filter((call) => call.chatId === critical.chatId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /Ocorrência crítica aberta/);
  assert.match(mine[0].text, /Fazenda <b>Fazenda &lt;Boa&gt; &amp; Vista<\/b>|Fazenda: <b>Fazenda &lt;Boa&gt; &amp; Vista<\/b>/);
  assert.match(mine[0].text, /Core &lt;rack 1&gt;/);
  assert.ok(!mine[0].text.includes('AP do pátio'));
  assert.ok(calls.every((call) => call.chatId !== '@outra_fazenda'));
  const email = mail.sent.filter((message) => message.to === 'noc@example.com');
  assert.equal(email.length, 1);
  assert.match(email[0].subject, /2 ocorrências abertas/);
  assert.match(email[0].text, /\[Crítica\] Core <rack 1>/);
  assert.match(email[0].text, /\[Aviso\] AP do pátio/);
  assert.match(email[0].text, /https:\/\/app\.example/);

  // Reavaliar e despachar de novo não reenvia nada.
  calls.length = 0;
  mail.sent.length = 0;
  await evaluateAll(db);
  await dispatchChannelNotifications(db, { transport: mail.transport, fetcher, origin: ORIGIN });
  assert.equal(calls.filter((call) => call.chatId === critical.chatId).length, 0);
  assert.equal(mail.sent.filter((message) => message.to === 'noc@example.com').length, 0);

  await run(f, `UPDATE assets SET status = 'online', last_observed_at = now() WHERE org_id = $1 AND id = $2`, [f.orgId, core]);
  await evaluateAll(db);
  await dispatchChannelNotifications(db, { transport: mail.transport, fetcher, origin: ORIGIN });
  const resolved = calls.filter((call) => call.chatId === critical.chatId);
  assert.equal(resolved.length, 1);
  assert.match(resolved[0].text, /Ocorrência encerrada/);
  assert.match(resolved[0].text, /encerrada em/);
  assert.equal(mail.sent.filter((message) => message.to === 'noc@example.com').length, 0, 'canal sem aviso de encerramento');

  const rows = await deliveries(f);
  const keys = await run(f, 'SELECT idempotency_key FROM notification_deliveries WHERE org_id = $1', [f.orgId]);
  assert.equal(new Set(keys.map((row) => row.idempotency_key)).size, keys.length);
  assert.deepEqual(rows.filter((row) => row.event === 'resolved').map((row) => row.status), ['sent']);
  void warnings;
});

test('canal desativado, criado depois da ocorrência ou fora do filtro não recebe nada', async () => {
  const f = await fixture();
  const { calls, fetcher } = telegram();
  const chatId = `-200${Date.now()}`;
  await asset(f, { name: 'Gateway', critical: true, status: 'offline' });
  await evaluateAll(db);
  const late = await createChannel(db, f.admin, { kind: 'telegram', name: 'Tardio', botToken: TOKEN, chatId });
  await dispatchChannelNotifications(db, { transport: mailbox().transport, fetcher });
  assert.equal(calls.filter((call) => call.chatId === chatId).length, 0, 'não reenvia o passado');

  await updateChannel(db, f.admin, late.id, { enabled: false });
  await asset(f, { name: 'Switch novo', critical: true, status: 'offline' });
  await evaluateAll(db);
  await dispatchChannelNotifications(db, { transport: mailbox().transport, fetcher });
  assert.equal(calls.filter((call) => call.chatId === chatId).length, 0, 'canal desativado');
  const actions = await run(f, `SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'alerts.%' ORDER BY occurred_at`, [f.orgId]);
  assert.deepEqual(actions.map((row) => row.action), ['alerts.channel.create', 'alerts.channel.disable']);
});

test('suprime ativos em manutenção e durante perda de contato do coletor', async () => {
  const f = await fixture();
  const { calls, fetcher } = telegram();
  const channel = await createChannel(db, f.admin, { kind: 'telegram', name: 'Tudo', botToken: TOKEN, chatId: `-300${Date.now()}`, minSeverity: 'warning' });
  await asset(f, { name: 'Câmera em manutenção', critical: true, status: 'offline', maintenance: true });
  await evaluateAll(db);
  await dispatchChannelNotifications(db, { transport: mailbox().transport, fetcher });
  assert.deepEqual((await deliveries(f)).map((row) => [row.rule, row.status]), [['asset_offline', 'suppressed']]);

  const silent = await fixture();
  const other = await createChannel(db, silent.admin, { kind: 'telegram', name: 'Tudo', botToken: TOKEN, chatId: `-301${Date.now()}`, minSeverity: 'warning' });
  await asset(silent, { name: 'Switch da sede', critical: true, status: 'offline' });
  await evaluateAll(db);
  // O coletor perde contato antes do envio: o alerta do ativo é suprimido e o do coletor sai.
  await run(silent, `UPDATE collector_health SET last_heartbeat_at = now() - interval '10 minutes' WHERE org_id = $1`, [silent.orgId]);
  await evaluateAll(db);
  await dispatchChannelNotifications(db, { transport: mailbox().transport, fetcher });
  assert.deepEqual((await deliveries(silent)).map((row) => [row.rule, row.status]).sort(), [['asset_offline', 'suppressed'], ['collector_silent', 'sent']]);
  const sent = calls.filter((call) => call.chatId === other.chatId);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Coletor da fazenda/);
  assert.equal(calls.filter((call) => call.chatId === channel.chatId).length, 0);
});

test('falhas temporárias voltam com backoff exponencial e param no limite de tentativas', async () => {
  const f = await fixture();
  let answer = { status: 502, body: { ok: false, description: 'Bad Gateway' } as unknown };
  const { calls, fetcher } = telegram(() => answer);
  const channel = await createChannel(db, f.admin, { kind: 'telegram', name: 'Instável', botToken: TOKEN, chatId: `-400${Date.now()}` });
  await asset(f, { name: 'Roteador', critical: true, status: 'offline' });
  await evaluateAll(db);
  const transport = mailbox().transport;

  const waits: number[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await dispatchChannelNotifications(db, { transport, fetcher });
    const [row] = await deliveries(f);
    assert.equal(row.attempts, attempt);
    waits.push(Number(row.wait));
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(row.status, 'pending');
      // Antes do backoff vencer, nada é reenviado.
      const before = calls.length;
      await dispatchChannelNotifications(db, { transport, fetcher });
      assert.equal(calls.length, before);
      await releasePending(f);
    } else {
      assert.equal(row.status, 'failed');
      assert.match(String(row.last_error), /HTTP 502/);
    }
  }
  assert.deepEqual(waits.slice(0, 4).map((value) => Math.round(value / 10) * 10), [30, 60, 120, 240]);

  // 429 respeita o retry_after e 400 encerra sem novas tentativas.
  const g = await fixture();
  await createChannel(db, g.admin, { kind: 'telegram', name: 'Limite', botToken: TOKEN, chatId: `-401${Date.now()}` });
  await asset(g, { name: 'Firewall', critical: true, status: 'offline' });
  await evaluateAll(db);
  answer = { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 77 } } };
  await dispatchChannelNotifications(db, { transport, fetcher });
  let [row] = await deliveries(g);
  assert.equal(row.status, 'pending');
  assert.ok(Number(row.wait) >= 70 && Number(row.wait) <= 77);
  await releasePending(g);
  answer = { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } };
  await dispatchChannelNotifications(db, { transport, fetcher });
  [row] = await deliveries(g);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  void channel;
});

test('limite por minuto do canal adia o excedente sem contar tentativa', async () => {
  const f = await fixture();
  const { calls, fetcher } = telegram();
  const channel = await createChannel(db, f.admin, { kind: 'telegram', name: 'Lento', botToken: TOKEN, chatId: `-500${Date.now()}`, rateLimitPerMinute: 1 });
  await asset(f, { name: 'Switch A', critical: true, status: 'offline' });
  await evaluateAll(db);
  await dispatchChannelNotifications(db, { transport: mailbox().transport, fetcher });
  await run(f, `UPDATE collector_health SET last_heartbeat_at = now() - interval '10 minutes' WHERE org_id = $1`, [f.orgId]);
  await evaluateAll(db);
  await dispatchChannelNotifications(db, { transport: mailbox().transport, fetcher });
  assert.equal(calls.filter((call) => call.chatId === channel.chatId).length, 1);
  const pending = (await deliveries(f)).filter((row) => row.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rule, 'collector_silent');
  assert.equal(pending[0].attempts, 0);
  assert.ok(Number(pending[0].wait) >= 50);
});

test('isolamento entre grupos e entre fazendas nos canais e no histórico', async () => {
  const f = await fixture();
  const other = await fixture();
  const { fetcher } = telegram();
  const groupWide = await createChannel(db, f.admin, { kind: 'email', name: 'Grupo todo', recipients: ['grupo@example.com'] });
  const farmOnly = await createChannel(db, f.admin, { kind: 'telegram', name: 'Só Boa Vista', botToken: TOKEN, chatId: '-600', farmIds: [f.farmId] });
  const neighbor = await createChannel(db, f.admin, { kind: 'email', name: 'Vizinha', recipients: ['v@example.com'], farmIds: [f.otherFarmId] });
  await sendTest(db, f.admin, farmOnly.id, { fetcher });
  await sendTest(db, f.admin, groupWide.id, { transport: mailbox().transport });

  // Outro grupo: canais respondem como inexistentes e listas vêm vazias.
  assert.deepEqual(await listChannels(db, other.admin), []);
  assert.deepEqual(await listDeliveries(db, other.admin, new URLSearchParams()), []);
  await assert.rejects(updateChannel(db, other.admin, farmOnly.id, { enabled: false }), status(404));
  await assert.rejects(sendTest(db, other.admin, farmOnly.id, { fetcher }), status(404));
  await assert.rejects(createChannel(db, other.admin, { kind: 'email', name: 'Invasor', recipients: ['x@example.com'], farmIds: [f.farmId] }), status(404));
  await assert.rejects(updateChannel(db, f.admin, 'nao-e-uuid', { enabled: false }), status(404));

  // TI restrito à Boa Vista: só vê e altera canais contidos no seu escopo.
  const restricted: Principal = { orgId: f.orgId, actor: 'oid-ti-restrito', role: 'ti', farmIds: [f.farmId], demo: false };
  assert.deepEqual((await listChannels(db, restricted)).map((channel) => channel.id), [farmOnly.id]);
  await assert.rejects(updateChannel(db, restricted, groupWide.id, { enabled: false }), status(404));
  await assert.rejects(updateChannel(db, restricted, neighbor.id, { enabled: false }), status(404));
  await assert.rejects(sendTest(db, restricted, groupWide.id, { transport: mailbox().transport }), status(404));
  await assert.rejects(updateChannel(db, restricted, farmOnly.id, { farmIds: [f.farmId, f.otherFarmId] }), status(404));
  await assert.rejects(createChannel(db, restricted, { kind: 'email', name: 'Tudo', recipients: ['t@example.com'] }), status(400));
  await assert.rejects(listDeliveries(db, restricted, new URLSearchParams({ farmId: f.otherFarmId })), status(404));
  const history = await listDeliveries(db, restricted, new URLSearchParams());
  assert.deepEqual(history.map((row) => row.channelId), [farmOnly.id]);
  const all = await listDeliveries(db, f.admin, new URLSearchParams());
  assert.equal(all.length, 2);
  assert.ok(!JSON.stringify(all).includes(TOKEN));

  // A política de RLS esconde as linhas de outro grupo mesmo numa consulta sem filtro de org (papel sem BYPASSRLS).
  await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'push_rls') THEN CREATE ROLE push_rls NOLOGIN NOBYPASSRLS; END IF; END $$`);
  await db.query('GRANT SELECT ON notification_channels, notification_deliveries TO push_rls');
  const visible = (orgId: string) => db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE push_rls');
    await setOrg(tx, orgId);
    const { rows: [row] } = await tx.query<{ channels: number; deliveries: number }>(`SELECT
      (SELECT count(*)::int FROM notification_channels) AS channels, (SELECT count(*)::int FROM notification_deliveries) AS deliveries`);
    return row;
  });
  assert.deepEqual(await visible(other.orgId), { channels: 0, deliveries: 0 });
  assert.deepEqual(await visible(f.orgId), { channels: 3, deliveries: 2 });
});

test('o botão de teste envia na hora e limita testes seguidos', async () => {
  const f = await fixture();
  const { calls, fetcher } = telegram();
  const channel = await createChannel(db, f.admin, { kind: 'telegram', name: 'Plantão <noite>', botToken: TOKEN, chatId: '@plantao_ti' });
  for (let index = 0; index < 5; index += 1) assert.deepEqual(await sendTest(db, f.admin, channel.id, { fetcher }), { status: 'sent' });
  assert.match(calls[0].text, /Mensagem de teste/);
  assert.match(calls[0].text, /Plantão &lt;noite&gt;/);
  assert.equal(calls[0].chatId, '@plantao_ti');
  await assert.rejects(sendTest(db, f.admin, channel.id, { fetcher }), status(429));
  const history = await listDeliveries(db, f.admin, new URLSearchParams({ channelId: channel.id }));
  assert.equal(history.length, 5);
  assert.ok(history.every((row) => row.event === 'test' && row.status === 'sent'));
});
