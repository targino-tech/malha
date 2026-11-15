import nodemailer from 'nodemailer';
import { setOrg, type Database, type Queryable } from './db';
import { errorName, log } from './log';

export type AlertEmail = { to: string; subject: string; text: string };
export interface MailTransport { send(message: AlertEmail): Promise<void> }

const MAX_ATTEMPTS = 5;

/**
 * SMTP cobre o Amazon SES (endpoint SMTP da região) e servidores de laboratório.
 * Sem MALHA_SMTP_URL, os e-mails são descartados com registro da contagem, sem dados pessoais.
 */
export function transportFromEnv(): MailTransport {
  const url = process.env.MALHA_SMTP_URL;
  const from = process.env.MALHA_ALERT_FROM;
  if (!url || !from) {
    return { async send() { log.warn('E-mail de alerta não enviado: configure MALHA_SMTP_URL e MALHA_ALERT_FROM.'); } };
  }
  const smtp = nodemailer.createTransport(url);
  return { async send(message) { await smtp.sendMail({ from, ...message }); } };
}

const singleLine = (value: string) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

type Pending = {
  occurrence_id: string; recipient: string; farm_id: string; farm_name: string; timezone: string;
  rule: string; resource_kind: string; title: string; opened_at: Date; resolved_at: Date | null; suppressed: boolean;
};

export function composeEmail(recipient: string, items: Pending[], origin?: string): AlertEmail {
  const farm = singleLine(items[0].farm_name);
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: items[0].timezone, dateStyle: 'short', timeStyle: 'short' });
  const lines = items.map((item) => `- ${singleLine(item.title)} (aberta em ${time.format(new Date(item.opened_at))})`);
  const subject = items.length === 1
    ? `[Malha] ${farm}: ${singleLine(items[0].title)}`
    : `[Malha] ${farm}: ${items.length} ocorrências críticas`;
  return {
    to: recipient,
    subject: subject.slice(0, 200),
    text: [`Ocorrências críticas na ${farm}:`, '', ...lines, '',
      origin ? `Acompanhe e reconheça no painel: ${origin}` : 'Acompanhe e reconheça no painel do Malha.',
      '', 'Mensagem automática do Malha. O histórico completo fica no aplicativo.'].join('\n'),
  };
}

async function sendForOrganization(tx: Queryable, orgId: string, transport: MailTransport, origin?: string) {
  // Ocorrências de ativo ficam suspensas enquanto a fazenda tiver um coletor sem contato aberto
  // ou o ativo estiver em janela de manutenção.
  const { rows } = await tx.query<Pending>(`SELECT n.occurrence_id, n.recipient, o.farm_id, f.name AS farm_name, f.timezone,
      o.rule, o.resource_kind, o.title, o.opened_at, o.resolved_at,
      (o.resource_kind = 'asset' AND EXISTS (SELECT 1 FROM occurrences s WHERE s.org_id = o.org_id AND s.farm_id = o.farm_id
        AND s.rule = 'collector_silent' AND s.resolved_at IS NULL)
        OR EXISTS (SELECT 1 FROM assets a WHERE o.resource_kind = 'asset' AND a.org_id = o.org_id AND a.farm_id = o.farm_id
          AND a.id = o.resource_id AND a.maintenance_until > now())) AS suppressed
    FROM notifications n
    JOIN occurrences o ON o.org_id = n.org_id AND o.id = n.occurrence_id
    JOIN farms f ON f.org_id = o.org_id AND f.id = o.farm_id
    WHERE n.org_id = $1 AND n.status = 'pending' AND n.available_at <= now()
    ORDER BY n.recipient, o.farm_id, o.opened_at
    LIMIT 200 FOR UPDATE OF n SKIP LOCKED`, [orgId]);

  const mark = (items: Pending[], status: string) => tx.query(`UPDATE notifications SET status = $3,
      sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END
    WHERE org_id = $1 AND (occurrence_id, recipient) IN (SELECT * FROM unnest($2::uuid[], $4::text[]))`,
  [orgId, items.map((item) => item.occurrence_id), status, items.map((item) => item.recipient)]);

  const skipped = rows.filter((row) => row.resolved_at);
  const suppressed = rows.filter((row) => !row.resolved_at && row.suppressed);
  if (skipped.length) await mark(skipped, 'skipped');
  if (suppressed.length) await mark(suppressed, 'suppressed');

  // Agrupa por destinatário e fazenda: um e-mail por unidade.
  const groups = new Map<string, Pending[]>();
  for (const row of rows) {
    if (row.resolved_at || row.suppressed) continue;
    const key = `${row.recipient}\n${row.farm_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let sent = 0;
  for (const items of groups.values()) {
    try {
      await transport.send(composeEmail(items[0].recipient, items, origin));
      await mark(items, 'sent');
      sent++;
    } catch (error) {
      await tx.query(`UPDATE notifications SET attempts = attempts + 1,
          available_at = now() + make_interval(secs => least(900, 30 * power(2, attempts))),
          status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END
        WHERE org_id = $1 AND (occurrence_id, recipient) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`,
      [orgId, items.map((item) => item.occurrence_id), items.map((item) => item.recipient), MAX_ATTEMPTS]);
      log.error('Falha ao enviar e-mail de alerta', { error: errorName(error) });
    }
  }
  return sent;
}

/** Envia notificações pendentes de todas as organizações. Retorna o número de e-mails enviados. */
export async function sendPendingNotifications(database: Database, transport: MailTransport, origin = process.env.MALHA_PUBLIC_ORIGIN) {
  const { rows: organizations } = await database.query<{ id: string }>('SELECT id FROM organizations ORDER BY id');
  let sent = 0;
  for (const { id } of organizations) {
    sent += await database.transaction(async (tx) => {
      await setOrg(tx, id);
      return sendForOrganization(tx, id, transport, origin);
    });
  }
  return sent;
}
