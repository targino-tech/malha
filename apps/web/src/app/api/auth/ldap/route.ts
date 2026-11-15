import { cookies } from 'next/headers';
import { database, mode } from '@/server/db';
import { HttpError, requestBytes } from '@/server/http';
import { publicOrigin, requireSameOrigin } from '@/server/identity';
import { authenticateLdap } from '@/server/ldap';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SESSION_COOKIE = '__Host-malha_session';

// O formulário de /entrar envia por POST; respostas são redirecionamentos para manter o fluxo sem JavaScript.
export async function POST(request: Request) {
  if (mode() === 'demo') return new Response(null, { status: 303, headers: { Location: '/' } });
  let origin: string;
  try { origin = publicOrigin(); } catch { return new Response('Configure MALHA_PUBLIC_ORIGIN.', { status: 503 }); }
  const back = (code: string) => new Response(null, { status: 303, headers: { Location: `${origin}/entrar?erro=${code}`, 'Cache-Control': 'no-store' } });
  try {
    requireSameOrigin(request);
    const secret = process.env.MALHA_AUTH_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) throw new HttpError(503, 'Login por diretório indisponível.');
    // Corpo limitado antes de qualquer leitura: a rota é pública e o formulário só tem três campos curtos.
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new HttpError(400, 'Formulário inválido.');
    const form = new URLSearchParams(new TextDecoder().decode(await requestBytes(request, 4096)));
    // O proxy HTTPS acrescenta o cliente ao fim de X-Forwarded-For; só esse valor é confiável.
    const client = request.headers.get('X-Forwarded-For')?.split(',').map((value) => value.trim()).filter(Boolean).at(-1) ?? 'direto';
    const { token } = await authenticateLdap(await database(), {
      domain: form.get('domain'), username: form.get('username'), password: form.get('password'),
    }, client, secret);
    (await cookies()).set(SESSION_COOKIE, token, { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 });
    return new Response(null, { status: 303, headers: { Location: origin, 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return back(status === 429 ? 'tentativas' : status === 403 ? 'sem-acesso' : status === 400 ? 'campos' : status === 401 ? 'credenciais' : 'indisponivel');
  }
}
