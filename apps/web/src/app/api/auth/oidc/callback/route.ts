import { mode } from '@/server/db';
import { HttpError } from '@/server/http';
import { publicOrigin } from '@/server/identity';
import { finishOidcLogin } from '@/server/oidc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Erros voltam para o portal com um código, como no login por diretório.
export async function GET(request: Request) {
  if (mode() === 'demo') return new Response(null, { status: 303, headers: { Location: '/' } });
  try {
    return await finishOidcLogin(request);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = status === 403 ? 'sem-acesso' : status === 401 ? 'provedor' : 'indisponivel';
    let origin = '';
    try { origin = publicOrigin(); } catch { return new Response('Configure MALHA_PUBLIC_ORIGIN.', { status: 503 }); }
    return new Response(null, { status: 303, headers: { Location: `${origin}/entrar?erro=${code}`, 'Cache-Control': 'no-store' } });
  }
}
