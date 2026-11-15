import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { database, mode } from './db';
import { HttpError, parseJson, requestBytes } from './http';
import { requireSameOrigin } from './identity';

export const PLAN_IDS = ['piloto', 'grupo', 'corporativo'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

const PER_CLIENT_HOUR = 5;
const GLOBAL_HOUR = 300;

const schema = z.object({
  id: z.uuid(),
  plan: z.enum(PLAN_IDS),
  name: z.string().trim().min(2, 'Informe seu nome.').max(120),
  email: z.email('Informe um e-mail válido.').trim().toLowerCase().max(254),
  company: z.string().trim().min(2, 'Informe a empresa ou o grupo.').max(160),
  farms: z.coerce.number().int().min(1, 'Informe ao menos 1 fazenda.').max(500, 'Para mais de 500 fazendas, fale com a equipe.'),
  message: z.string().trim().max(2000).optional().transform((value) => value || null),
  consent: z.literal(true, 'Confirme o uso dos dados para o contato.'),
  website: z.string().max(0).optional(),
}).strict();

// O proxy HTTPS do piloto acrescenta o endereço do cliente ao fim de X-Forwarded-For.
// O valor mais à direita é o único que o cliente não controla.
function clientHash(request: Request) {
  const forwarded = request.headers.get('X-Forwarded-For')?.split(',').map((value) => value.trim()).filter(Boolean);
  const client = forwarded?.at(-1) ?? 'direto';
  const secret = mode() === 'pilot' ? process.env.MALHA_AUTH_SECRET : 'malha-demo';
  if (!secret) throw new HttpError(503, 'Configure MALHA_AUTH_SECRET.');
  return createHmac('sha256', secret).update(`site-request:${client}`).digest('hex');
}

export async function createSiteRequest(request: Request) {
  requireSameOrigin(request);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Envie os dados em JSON.');
  const parsed = schema.safeParse(parseJson(await requestBytes(request, 8 * 1024)));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(422, issue?.message && !issue.message.startsWith('Invalid') ? issue.message : 'Revise os campos do formulário.');
  }
  const input = parsed.data;
  const client = clientHash(request);
  const db = await database();
  return db.transaction(async (tx) => {
    // Serializa os envios para que a contagem do limite e a gravação aconteçam juntas.
    await tx.exec('SELECT pg_advisory_xact_lock(58147262)');
    const { rows: existing } = await tx.query('SELECT 1 FROM site_requests WHERE id = $1', [input.id]);
    if (existing.length) return { accepted: true };
    const { rows: [counts] } = await tx.query<{ client: number; total: number }>(`
      SELECT count(*) FILTER (WHERE client_hash = $1)::int AS client, count(*)::int AS total
      FROM site_requests WHERE created_at > now() - interval '1 hour'`, [client]);
    if (counts.client >= PER_CLIENT_HOUR || counts.total >= GLOBAL_HOUR) {
      throw new HttpError(429, 'Muitas solicitações em pouco tempo. Tente novamente mais tarde.', { 'Retry-After': '3600' });
    }
    await tx.query(`INSERT INTO site_requests (id, plan, name, email, company, farms, message, client_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.id, input.plan, input.name, input.email, input.company, input.farms, input.message, client]);
    return { accepted: true };
  });
}
